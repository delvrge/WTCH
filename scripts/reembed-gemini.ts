// One-off cutover: OpenAI -> Gemini embeddings. Every embedding stored in
// this project so far came from OpenAI's text-embedding-3-small. Now that
// all live AI calls go through Gemini (see _shared/ai-provider.ts), those
// old vectors are meaningless against new Gemini-embedded queries even
// though the column is still vector(1536) — same dimension count, different
// model, different vector space. This re-embeds every row in every table
// that Investigate/search reads from, using the SAME text each row was
// originally embedded from.
//
// Run once, after GEMINI_API_KEY is live everywhere:
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... GEMINI_API_KEY=... \
//     npx tsx scripts/reembed-gemini.ts
//
// Safe to re-run — every row gets overwritten each time, so a partial run
// just means some rows get done twice.

import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const geminiApiKey = process.env.GEMINI_API_KEY

if (!supabaseUrl || !serviceRoleKey || !geminiApiKey) {
  console.error('Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or GEMINI_API_KEY')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey)

async function embed(text: string): Promise<number[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${geminiApiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: { parts: [{ text }] },
        outputDimensionality: 1536,
      }),
    },
  )
  if (!res.ok) throw new Error(`Embedding request failed: ${await res.text()}`)
  const data = await res.json()
  const values: number[] | undefined = data.embedding?.values
  if (!values) throw new Error('No embedding returned')
  return values
}

/** Small delay between calls — the free tier is rate-limited per minute. */
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function reembedTable(table: string, textColumn: string, buildText?: (row: Record<string, unknown>) => string, selectColumns?: string) {
  const { data: rows, error } = await supabase.from(table).select(selectColumns ?? `id, ${textColumn}`)
  if (error) throw error

  console.log(`${table}: ${rows?.length ?? 0} rows to re-embed`)

  for (const row of (rows ?? []) as unknown as Record<string, unknown>[]) {
    const text = buildText ? buildText(row) : String(row[textColumn] ?? '')
    if (!text.trim()) continue
    const embedding = await embed(text)
    const { error: updateError } = await supabase.from(table).update({ embedding }).eq('id', row.id)
    if (updateError) throw updateError
    console.log(`  ${table} ${row.id} done`)
    await sleep(1200) // ~50 req/min, under the free-tier per-minute cap
  }
}

async function main() {
  await reembedTable('community_patterns', 'issue_summary')
  await reembedTable('verified_answers', 'question_summary')
  await reembedTable('trusted_replies', 'question_summary')
  await reembedTable(
    'topic_taxonomy_posts',
    'title',
    (row) => `${row.title_en ?? row.title}\n\n${row.body_en ?? row.body}`,
    'id, title, body, title_en, body_en',
  )
  console.log('done')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
