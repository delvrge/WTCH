// One-time batch reclassification: every verified_answers row whose
// subcategory doesn't satisfy the fixed 9-topic/27-subtopic taxonomy (free
// text from before boxes were retired, or simply unset) gets a fixed
// subtopic value.
//
// Two paths, decided per row:
//   - Linked to a community_patterns row (verified_answer_cases) whose own
//     subtopic is already set: inherit it outright, no LLM call. The
//     pattern's classification already happened once
//     (scripts/reclassify-patterns.ts), one source of truth, no risk of the
//     reply and its case disagreeing.
//   - Unlinked (or its linked pattern has no subtopic either): classify from
//     the reply's own text (question_summary + answer_text) against the
//     fixed list, same taxonomy block pattern-extract.ts /
//     reclassify-patterns.ts use.
//
// Safe to re-run: only rows that still fail the fixed-list check are
// touched, and a row that fails classification is left as-is (logged, not
// forced to a guess) rather than corrupted.
//
// Run:
//   npx tsx scripts/reclassify-verified-answers.ts

import './topic-taxonomy/lib/load-env'
import { createClient } from '@supabase/supabase-js'
import { TOPIC_TAXONOMY, UNCLUSTERED } from '../supabase/functions/_shared/topic-taxonomy'
import { chatJSON } from './lib/gemini'

const supabaseUrl = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const geminiApiKey = process.env.GEMINI_API_KEY

if (!supabaseUrl || !serviceRoleKey || !geminiApiKey) {
  console.error('Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or GEMINI_API_KEY')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey)

const SUBTOPICS = TOPIC_TAXONOMY.flatMap((t) => t.subtopics)
const FIXED_LIST = [...SUBTOPICS, UNCLUSTERED]

function snapAnySubtopic(value: string): string | null {
  const norm = value.trim().toLowerCase()
  if (norm === UNCLUSTERED.toLowerCase()) return UNCLUSTERED
  return SUBTOPICS.find((s) => s.toLowerCase() === norm) ?? null
}

interface Row {
  id: string
  question_summary: string
  answer_text: string
  subcategory: string | null
}

const TAXONOMY_BLOCK = TOPIC_TAXONOMY
  .map((t) => `  - ${t.topic}\n${t.subtopics.map((s) => `      - ${s}`).join('\n')}`)
  .join('\n')

function buildSystemPrompt(): string {
  return `You classify existing verified support replies for ${process.env.PRODUCT_NAME ?? 'the product'} against a FIXED, locked list of subtopics. Pick exactly one subtopic, VERBATIM (exact spelling/case), never invent, reword, or improve a name; this list is locked and never grows.

${TAXONOMY_BLOCK}

If a record genuinely does not fit any subtopic above, return "${UNCLUSTERED}", a real, honest outcome, not a failure. Do not force a fit you are not confident about.

Respond with ONLY a JSON object: { "classifications": [ { "id": "...", "subtopic": "..." } ] }, one entry per input record, in any order, every input id present exactly once.`
}

async function classifyBatch(rows: Row[]): Promise<{ id: string; subtopic: string }[]> {
  const userContent = JSON.stringify(
    rows.map((r) => ({ id: r.id, question: r.question_summary, answer: r.answer_text })),
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

// Same shrinking-filter page loop as reclassify-patterns.ts, moot at
// today's 5 rows, kept for consistency with the rest of scripts/.
const PAGE_SIZE = 1000

async function main() {
  let inherited = 0
  let classified = 0
  const failedIds = new Set<string>()

  while (true) {
    const { data: allRows, error } = await supabase
      .from('verified_answers')
      .select('id, question_summary, answer_text, subcategory')
      .or(`subcategory.is.null,subcategory.not.in.(${FIXED_LIST.map((v) => `"${v}"`).join(',')})`)
      .limit(PAGE_SIZE)
    if (error) throw error
    if (!allRows || allRows.length === 0) break

    const rows = (allRows as Row[]).filter((r) => !failedIds.has(r.id))
    if (rows.length === 0) break

    // Path 1: inherit the linked pattern's subtopic outright, no LLM call.
    const ids = rows.map((r) => r.id)
    const { data: links, error: linksError } = await supabase
      .from('verified_answer_cases')
      .select('answer_id, pattern_id')
      .in('answer_id', ids)
    if (linksError) throw linksError

    const patternIds = [...new Set((links || []).map((l) => l.pattern_id))]
    const { data: patterns, error: patternsError } = patternIds.length
      ? await supabase.from('community_patterns').select('id, subtopic').in('id', patternIds)
      : { data: [], error: null }
    if (patternsError) throw patternsError
    const subtopicByPattern = new Map((patterns || []).map((p) => [p.id, p.subtopic as string | null]))

    const firstLinkedSubtopic = new Map<string, string>()
    for (const link of links || []) {
      if (firstLinkedSubtopic.has(link.answer_id)) continue
      const subtopic = subtopicByPattern.get(link.pattern_id)
      if (subtopic) firstLinkedSubtopic.set(link.answer_id, subtopic)
    }

    const toClassify: Row[] = []
    for (const row of rows) {
      const inheritedSubtopic = firstLinkedSubtopic.get(row.id)
      if (!inheritedSubtopic) {
        toClassify.push(row)
        continue
      }
      const { error: updateError } = await supabase
        .from('verified_answers')
        .update({ subcategory: inheritedSubtopic })
        .eq('id', row.id)
      if (updateError) {
        console.error(`  skipping ${row.id}: write failed: ${updateError.message}`)
        failedIds.add(row.id)
        continue
      }
      inherited++
      console.log(`  ${row.id}: inherited "${inheritedSubtopic}" from linked pattern`)
    }

    // Path 2: unlinked (or linked pattern has no subtopic either), classify
    // from the reply's own text.
    if (toClassify.length) {
      try {
        const results = await classifyBatch(toClassify)
        const byId = new Map(toClassify.map((r) => [r.id, r]))
        const returnedIds = new Set<string>()

        for (const c of results) {
          if (!byId.has(c.id)) continue
          returnedIds.add(c.id)
          const snapped = snapAnySubtopic(c.subtopic) ?? UNCLUSTERED

          const { error: updateError } = await supabase
            .from('verified_answers')
            .update({ subcategory: snapped })
            .eq('id', c.id)
          if (updateError) {
            console.error(`  skipping ${c.id}: write failed: ${updateError.message}`)
            failedIds.add(c.id)
            continue
          }
          classified++
          console.log(`  ${c.id}: classified "${snapped}"`)
        }

        for (const row of toClassify) {
          if (!returnedIds.has(row.id)) failedIds.add(row.id)
        }
      } catch (err) {
        console.error(`  batch failed (${toClassify.length} rows): ${(err as Error).message}`)
        for (const row of toClassify) failedIds.add(row.id)
      }
    }

    console.log(`inherited ${inherited}, classified ${classified} so far${failedIds.size ? `, ${failedIds.size} failed` : ''}`)
  }

  console.log(`done, inherited ${inherited}, classified ${classified} via LLM`)
  if (failedIds.size > 0) {
    console.log(`${failedIds.size} row(s) could not be classified: ${[...failedIds].join(', ')}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
