// Step 2: embed every topic_taxonomy_posts row still missing an embedding.
// Same dims as the rest of this tool (gemini-embedding-001 truncated to
// 1536), embedding title_en+body_en concatenated (run 1b-translate.ts first --
// embedding the raw multilingual text made language the dominant signal and
// HDBSCAN clustered posts by language instead of topic). Falls back to the
// raw title/body if a row wasn't translated, so a translation gap doesn't
// stall the whole run. Batched against Gemini (not the community platform, so no politeness
// delay needed beyond staying under Gemini's own rate limits).
// Safe to re-run: only embedding IS NULL rows are touched.
//
// Run:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... GEMINI_API_KEY=... \
//     npx tsx scripts/topic-taxonomy/2-embed.ts

import './lib/load-env'
import { createClient } from '@supabase/supabase-js'
import { getEncoding } from 'js-tiktoken'
import { embedBatch as geminiEmbedBatch } from '../lib/gemini'

const BATCH_SIZE = 50
// Gemini's embedding model tops out well above this; the cl100k_base
// tokenizer is kept as the truncation yardstick (it's a proxy, not exact
// for Gemini's own tokenizer) purely to keep per-post payloads bounded.
const MAX_TOKENS_PER_POST = 8000
const encoding = getEncoding('cl100k_base')

function truncateToTokenLimit(text: string): string {
  const tokens = encoding.encode(text)
  if (tokens.length <= MAX_TOKENS_PER_POST) return text
  return encoding.decode(tokens.slice(0, MAX_TOKENS_PER_POST))
}

const supabaseUrl = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const geminiApiKey = process.env.GEMINI_API_KEY

if (!supabaseUrl || !serviceRoleKey || !geminiApiKey) {
  console.error('Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or GEMINI_API_KEY')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey)

async function embedBatch(texts: string[]): Promise<number[][]> {
  return geminiEmbedBatch({ apiKey: geminiApiKey!, texts })
}

/**
 * Embeds a batch as one request when possible. If the batch request fails
 * for any reason, falls back to embedding each item individually so one bad
 * post can't take down the other 49 with it — the culprit is logged by id
 * and reported as `null` (caller leaves its embedding NULL rather than
 * guessing), everything else still gets embedded.
 */
async function embedBatchSafely(
  batch: { id: string; title: string; body: string; title_en: string | null; body_en: string | null }[],
): Promise<(number[] | null)[]> {
  const texts = batch.map((r) => truncateToTokenLimit(`${r.title_en ?? r.title}\n\n${r.body_en ?? r.body}`))
  try {
    return await embedBatch(texts)
  } catch (err) {
    console.error(`  batch embedding failed (${(err as Error).message}), retrying items individually...`)
    const results: (number[] | null)[] = []
    for (let k = 0; k < texts.length; k++) {
      try {
        const [embedding] = await embedBatch([texts[k]])
        results.push(embedding)
      } catch (itemErr) {
        console.error(`  skipping post ${batch[k].id}: ${(itemErr as Error).message}`)
        results.push(null)
      }
    }
    return results
  }
}

// PostgREST caps a single response at 1000 rows by default. Rather than
// paginate with .range() (which would misbehave here: each processed row
// flips embedding from NULL to non-NULL, so the `IS NULL` filter's result
// set shrinks out from under an offset-based page), just re-query "next
// 1000 still-NULL rows" each round — already-embedded rows fall out of the
// filter on their own, so this naturally converges without ever skipping or
// re-processing a row.
const PAGE_SIZE = 1000

async function main() {
  let totalEmbedded = 0
  // Ids that failed even the individual-retry fallback. Their embedding
  // stays NULL, so without this they'd reappear in every future page
  // forever — tracked here so a round containing only known failures stops
  // the loop instead of spinning on it.
  const failedIds = new Set<string>()

  while (true) {
    const { data: allRows, error } = await supabase
      .from('topic_taxonomy_posts')
      .select('id, title, body, title_en, body_en')
      .is('embedding', null)
      .limit(PAGE_SIZE)
    if (error) throw error
    if (!allRows || allRows.length === 0) break

    const rows = allRows.filter((r) => !failedIds.has(r.id))
    if (rows.length === 0) break // everything still NULL is a known failure

    if (totalEmbedded === 0) console.log(`at least ${rows.length} rows to embed (paging ${PAGE_SIZE} at a time)`)

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE)
      const embeddings = await embedBatchSafely(batch)

      for (let j = 0; j < batch.length; j++) {
        if (embeddings[j] === null) {
          failedIds.add(batch[j].id)
          continue
        }
        const { error: updateError } = await supabase
          .from('topic_taxonomy_posts')
          .update({ embedding: embeddings[j] })
          .eq('id', batch[j].id)
        if (updateError) throw updateError
        totalEmbedded++
      }

      console.log(`embedded ${totalEmbedded} so far${failedIds.size ? `, ${failedIds.size} failed` : ''}`)
    }
  }

  console.log(`done, embedded ${totalEmbedded} rows total`)
  if (failedIds.size > 0) {
    console.log(`${failedIds.size} row(s) could not be embedded and remain NULL: ${[...failedIds].join(', ')}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
