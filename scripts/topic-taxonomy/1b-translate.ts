// Step 1b (run after 1-scrape.ts, before 2-embed.ts): translate every post's
// title/body to English via Gemini and write title_en/body_en. Without
// this, embeddings pick up language as the dominant signal and HDBSCAN
// clusters posts by language (Spanish together, German together, etc.)
// instead of by topic.
//
// Safe to re-run: only rows still missing title_en/body_en are touched.
//
// Run:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... GEMINI_API_KEY=... \
//     npx tsx scripts/topic-taxonomy/1b-translate.ts

import './lib/load-env'
import { createClient } from '@supabase/supabase-js'
import { getEncoding } from 'js-tiktoken'
import { chatJSON } from '../lib/gemini'

const CONCURRENCY = 10
// Chat models can take far more than this, but the cost scales with input
// size and a forum post doesn't need more context than this to translate.
const MAX_TOKENS_PER_FIELD = 4000
const encoding = getEncoding('cl100k_base')

function truncateToTokenLimit(text: string): string {
  const tokens = encoding.encode(text)
  if (tokens.length <= MAX_TOKENS_PER_FIELD) return text
  return encoding.decode(tokens.slice(0, MAX_TOKENS_PER_FIELD))
}

// Postgres text columns reject \x00 - strip before write, model sometimes
// echoes stray null bytes from source posts.
function stripNullBytes(text: string): string {
  return text.replace(/\u0000/g, '')
}

const supabaseUrl = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const geminiApiKey = process.env.GEMINI_API_KEY

if (!supabaseUrl || !serviceRoleKey || !geminiApiKey) {
  console.error('Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or GEMINI_API_KEY')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey)

interface Row {
  id: string
  title: string
  body: string
}

async function translate(row: Row): Promise<{ title_en: string; body_en: string }> {
  const content = await chatJSON({
    apiKey: geminiApiKey!,
    systemPrompt:
      `You translate ${process.env.PRODUCT_NAME ?? 'the product'} community forum posts to English. If the text is already in English, return it unchanged. Preserve meaning and tone; do not summarize, add commentary, or explain your translation. Respond as JSON: {"title_en": "...", "body_en": "..."}.`,
    userContent: JSON.stringify({
      title: truncateToTokenLimit(row.title),
      body: truncateToTokenLimit(row.body),
    }),
  })
  const parsed = JSON.parse(content)
  if (typeof parsed.title_en !== 'string' || typeof parsed.body_en !== 'string') {
    throw new Error('Model response missing title_en/body_en')
  }
  return parsed
}

// PostgREST caps a single response at 1000 rows by default. Can't paginate
// with .range() here: each processed row flips title_en from NULL to
// non-NULL, so the `IS NULL` filter's result set shrinks out from under an
// offset-based page (same issue as 2-embed.ts). Re-query "next 1000 still-
// NULL rows" each round instead.
const PAGE_SIZE = 1000

async function main() {
  let totalTranslated = 0
  // Ids that failed translation. Left untranslated, so without this they'd
  // reappear in every future page forever.
  const failedIds = new Set<string>()

  while (true) {
    const { data: allRows, error } = await supabase
      .from('topic_taxonomy_posts')
      .select('id, title, body')
      .is('title_en', null)
      .limit(PAGE_SIZE)
    if (error) throw error
    if (!allRows || allRows.length === 0) break

    const rows = (allRows as Row[]).filter((r) => !failedIds.has(r.id))
    if (rows.length === 0) break // everything still NULL is a known failure

    if (totalTranslated === 0) console.log(`at least ${rows.length} rows to translate (paging ${PAGE_SIZE} at a time)`)

    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const batch = rows.slice(i, i + CONCURRENCY)
      const results = await Promise.all(
        batch.map(async (row) => {
          try {
            return { id: row.id, ...(await translate(row)) }
          } catch (err) {
            console.error(`  skipping post ${row.id}: ${(err as Error).message}`)
            failedIds.add(row.id)
            return null
          }
        }),
      )

      for (const result of results) {
        if (!result) continue
        const { id, title_en, body_en } = result
        const { error: updateError } = await supabase
          .from('topic_taxonomy_posts')
          .update({ title_en: stripNullBytes(title_en), body_en: stripNullBytes(body_en) })
          .eq('id', id)
        if (updateError) {
          console.error(`  skipping post ${id}: write failed: ${updateError.message}`)
          failedIds.add(id)
          continue
        }
        totalTranslated++
      }

      console.log(`translated ${totalTranslated} so far${failedIds.size ? `, ${failedIds.size} failed` : ''}`)
    }
  }

  console.log(`done, translated ${totalTranslated} rows total`)
  if (failedIds.size > 0) {
    console.log(`${failedIds.size} row(s) could not be translated and remain NULL: ${[...failedIds].join(', ')}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
