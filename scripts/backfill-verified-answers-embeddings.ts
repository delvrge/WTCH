// One-off backfill: embeds question_summary for every verified_answers row
// still missing an embedding (pre-migration rows — save-verified now embeds
// on insert going forward). Run once with:
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... GEMINI_API_KEY=... \
//     npx tsx scripts/backfill-verified-answers-embeddings.ts
//
// Safe to re-run: only rows with embedding IS NULL are touched.

import { createClient } from '@supabase/supabase-js'
import { embed as geminiEmbed } from './lib/gemini'

const supabaseUrl = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const geminiApiKey = process.env.GEMINI_API_KEY

if (!supabaseUrl || !serviceRoleKey || !geminiApiKey) {
  console.error('Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or GEMINI_API_KEY')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey)

async function embed(text: string): Promise<number[]> {
  return geminiEmbed({ apiKey: geminiApiKey!, text })
}

async function main() {
  const { data: rows, error } = await supabase
    .from('verified_answers')
    .select('id, question_summary')
    .is('embedding', null)
  if (error) throw error

  console.log(`${rows?.length ?? 0} rows to backfill`)

  for (const row of rows ?? []) {
    const embedding = await embed(row.question_summary)
    const { error: updateError } = await supabase
      .from('verified_answers')
      .update({ embedding })
      .eq('id', row.id)
    if (updateError) throw updateError
    console.log(`embedded ${row.id}`)
  }

  console.log('done')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
