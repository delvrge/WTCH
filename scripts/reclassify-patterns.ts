// One-time batch reclassification: every LIVE community_patterns row still
// missing a subtopic (i.e. every row collected before the fixed 9-topic/
// 27-subtopic taxonomy replaced the self-organizing cluster system) gets
// classified against that fixed list, same rules the live extraction path
// (pattern-extract.ts) now uses for new posts.
//
// Unlike scripts/topic-taxonomy/, this touches LIVE production data
// (community_patterns), not the isolated topic_taxonomy_posts staging
// table. Safe to re-run: only rows with subtopic IS NULL are touched, and a
// row that fails classification is simply left NULL (the topic/subtopic
// CHECK constraints already tolerate NULL, see
// 20260820010000_fixed_topic_taxonomy.sql) rather than forced to a guess.
//
// Run:
//   npx tsx scripts/reclassify-patterns.ts

import './topic-taxonomy/lib/load-env'
import { createClient } from '@supabase/supabase-js'
import { TAXONOMY_PROMPT_BLOCK, UNCLUSTERED, snapSubtopic, snapTopic } from '../supabase/functions/_shared/topic-taxonomy'
import { chatJSON } from './lib/gemini'

const BATCH_SIZE = 25
const CONCURRENCY = 5

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
  source_title: string | null
  issue_summary: string
  typical_approach: string
  surface: string | null
}

interface Classification {
  id: string
  topic: string
  subtopic: string
}

function buildSystemPrompt(): string {
  return `You classify existing support-pattern records for ${process.env.PRODUCT_NAME ?? 'the product'} against a FIXED, locked taxonomy. Pick exactly one topic and exactly one of its subtopics per record, VERBATIM (exact spelling/case), never invent, reword, or improve a name; this list is locked and never grows.

${TAXONOMY_PROMPT_BLOCK}

If a record genuinely does not fit any topic above, return topic "${UNCLUSTERED}" and subtopic "${UNCLUSTERED}", a real, honest outcome, not a failure. Do not force a fit you are not confident about.

Respond with ONLY a JSON object: { "classifications": [ { "id": "...", "topic": "...", "subtopic": "..." } ] }, one entry per input record, in any order, every input id present exactly once.`
}

async function classifyBatch(rows: Row[]): Promise<Classification[]> {
  const userContent = JSON.stringify(
    rows.map((r) => ({
      id: r.id,
      title: r.source_title,
      issue_summary: r.issue_summary,
      typical_approach: r.typical_approach,
      surface: r.surface,
    })),
  )
  const content = await chatJSON({
    apiKey: geminiApiKey!,
    systemPrompt: buildSystemPrompt(),
    userContent,
    temperature: 0.3,
  })
  const parsed = JSON.parse(content)
  if (!Array.isArray(parsed.classifications)) throw new Error('Model response missing classifications array')
  return parsed.classifications
}

// PostgREST caps a single response at 1000 rows by default. Each processed
// row flips subtopic from NULL to non-NULL, so the `IS NULL` filter's result
// set shrinks out from under an offset-based page (same issue as
// 1b-translate.ts/2-embed.ts), re-query "next 1000 still-NULL rows" each
// round instead.
const PAGE_SIZE = 1000

async function main() {
  let totalClassified = 0
  const failedIds = new Set<string>()

  while (true) {
    const { data: allRows, error } = await supabase
      .from('community_patterns')
      .select('id, source_title, issue_summary, typical_approach, surface')
      .is('subtopic', null)
      .limit(PAGE_SIZE)
    if (error) throw error
    if (!allRows || allRows.length === 0) break

    const rows = (allRows as Row[]).filter((r) => !failedIds.has(r.id))
    if (rows.length === 0) break

    if (totalClassified === 0) console.log(`at least ${rows.length} rows to reclassify (paging ${PAGE_SIZE} at a time)`)

    for (let i = 0; i < rows.length; i += BATCH_SIZE * CONCURRENCY) {
      const group = rows.slice(i, i + BATCH_SIZE * CONCURRENCY)
      const batches: Row[][] = []
      for (let j = 0; j < group.length; j += BATCH_SIZE) batches.push(group.slice(j, j + BATCH_SIZE))

      const results = await Promise.all(
        batches.map(async (batch) => {
          try {
            return { batch, classifications: await classifyBatch(batch) }
          } catch (err) {
            console.error(`  batch failed (${batch.length} rows): ${(err as Error).message}`)
            for (const row of batch) failedIds.add(row.id)
            return null
          }
        }),
      )

      for (const result of results) {
        if (!result) continue
        const byId = new Map(result.batch.map((r) => [r.id, r]))
        const returnedIds = new Set<string>()

        for (const c of result.classifications) {
          if (!byId.has(c.id)) continue
          returnedIds.add(c.id)

          const snappedTopic = snapTopic(c.topic)
          const snappedSubtopic = snappedTopic ? snapSubtopic(snappedTopic, c.subtopic) : null
          const topic = snappedTopic ?? UNCLUSTERED
          const subtopic = snappedSubtopic ?? UNCLUSTERED

          const { error: updateError } = await supabase
            .from('community_patterns')
            .update({ topic, subtopic })
            .eq('id', c.id)
          if (updateError) {
            console.error(`  skipping pattern ${c.id}: write failed: ${updateError.message}`)
            failedIds.add(c.id)
            continue
          }
          totalClassified++
        }

        // Any row in the batch the model didn't return an entry for.
        for (const row of result.batch) {
          if (!returnedIds.has(row.id)) failedIds.add(row.id)
        }
      }

      console.log(`reclassified ${totalClassified} so far${failedIds.size ? `, ${failedIds.size} failed` : ''}`)
    }
  }

  console.log(`done, reclassified ${totalClassified} rows total`)
  if (failedIds.size > 0) {
    console.log(`${failedIds.size} row(s) could not be classified and remain NULL: ${[...failedIds].slice(0, 20).join(', ')}${failedIds.size > 20 ? ', ...' : ''}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
