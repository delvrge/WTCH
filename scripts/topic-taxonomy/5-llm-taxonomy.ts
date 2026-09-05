// Step 5 (alternative to the HDBSCAN path in 3a/3b/cluster.py): community
// support posts turned out to be a topical continuum, not density-separated
// groups -- HDBSCAN had no stable middle between 44+ micro-clusters and 2
// mega-blobs. This skips clustering entirely and has the LLM read titles
// directly, map-reduce style:
//
//   Pass 1 (map):    batch title_en values (~400/call) to Gemini, ask
//                     for the distinct problem topics visible in that batch.
//   Pass 2 (reduce):  feed every batch's proposed topics into ONE final call
//                     that consolidates duplicates/near-duplicates into
//                     10-15 Topics, each with 2-4 Subtopics.
//
// Read-only: does not write cluster_id/topic/subtopic back to the DB, only
// emits a markdown proposal to review.
//
// Run:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... GEMINI_API_KEY=... \
//     npx tsx scripts/topic-taxonomy/5-llm-taxonomy.ts

import './lib/load-env'
import { createClient } from '@supabase/supabase-js'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { chatJSON } from '../lib/gemini'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPORT_PATH = join(__dirname, 'output', 'llm-taxonomy.md')

const BATCH_SIZE = 400
const MAP_CONCURRENCY = 5

const supabaseUrl = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const geminiApiKey = process.env.GEMINI_API_KEY

if (!supabaseUrl || !serviceRoleKey || !geminiApiKey) {
  console.error('Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or GEMINI_API_KEY')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey)

interface ProposedTopic {
  name: string
  description: string
}

interface FinalSubtopic {
  name: string
  description: string
}

interface FinalTopic {
  name: string
  description: string
  subtopics: FinalSubtopic[]
}

async function chatJson(system: string, user: string): Promise<any> {
  const content = await chatJSON({ apiKey: geminiApiKey!, systemPrompt: system, userContent: user })
  return JSON.parse(content)
}

async function mapBatch(titles: string[], batchIndex: number): Promise<ProposedTopic[]> {
  const numbered = titles.map((t, i) => `${i + 1}. ${t}`).join('\n')
  try {
    const parsed = await chatJson(
      `You read ${process.env.PRODUCT_NAME ?? 'the product'} community support post titles. List the distinct problem topics you see in this batch. Each topic needs a short name (2-5 words) and a one-line description. Do not force titles into topics that do not fit -- just describe what is actually there. Respond as JSON: {"topics": [{"name": "...", "description": "..."}]}.`,
      numbered,
    )
    if (!Array.isArray(parsed.topics)) throw new Error('Model response missing topics array')
    return parsed.topics
  } catch (err) {
    console.error(`  batch ${batchIndex} failed: ${(err as Error).message}`)
    return []
  }
}

async function reduceToFinalTaxonomy(allProposals: ProposedTopic[]): Promise<FinalTopic[]> {
  const list = allProposals.map((t, i) => `${i + 1}. ${t.name} -- ${t.description}`).join('\n')
  const parsed = await chatJson(
    `You are given topic proposals collected from many batches of ${process.env.PRODUCT_NAME ?? 'the product'} community support post titles. Many are duplicates or near-duplicates of each other. Consolidate them into a final taxonomy of 10-15 Topics that together cover the support surface, each with 2-4 Subtopics nested under it. Topic = broad area (e.g. "Image Generation", "Billing & Credits", "Account & Login"). Subtopic = specific problem within that area (e.g. "Blurry output quality", "Credits not refreshing"). Base names only on what the proposals actually support -- do not invent categories. Respond as JSON: {"topics": [{"name": "...", "description": "...", "subtopics": [{"name": "...", "description": "..."}]}]}.`,
    list,
  )
  if (!Array.isArray(parsed.topics)) throw new Error('Reduce response missing topics array')
  return parsed.topics
}

// PostgREST caps a single response at 1000 rows by default -- this read
// doesn't mutate title_en as it goes, so a plain offset .range() page is
// safe here (unlike 2-embed.ts's IS NULL filter, which shrinks mid-loop).
const PAGE_SIZE = 1000

async function fetchAllTitles(): Promise<string[]> {
  const all: string[] = []
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('topic_taxonomy_posts')
      .select('title_en')
      .not('title_en', 'is', null)
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    all.push(...(data as { title_en: string }[]).map((r) => r.title_en))
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return all
}

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size))
  return chunks
}

async function main() {
  const titles = await fetchAllTitles()
  if (titles.length === 0) {
    console.error('No translated titles found -- run 1b-translate.ts first.')
    process.exit(1)
  }
  console.log(`${titles.length} titles to map`)

  const batches = chunk(titles, BATCH_SIZE)
  const allProposals: ProposedTopic[] = []

  for (let i = 0; i < batches.length; i += MAP_CONCURRENCY) {
    const group = batches.slice(i, i + MAP_CONCURRENCY)
    const results = await Promise.all(group.map((batch, k) => mapBatch(batch, i + k)))
    for (const topics of results) allProposals.push(...topics)
    console.log(`mapped batch ${Math.min(i + MAP_CONCURRENCY, batches.length)}/${batches.length}, ${allProposals.length} proposed topics so far`)
  }

  console.log(`reducing ${allProposals.length} proposed topics into final taxonomy...`)
  const finalTopics = await reduceToFinalTaxonomy(allProposals)
  console.log(`final taxonomy: ${finalTopics.length} topics`)

  const reportSections: string[] = []
  reportSections.push(`# Proposed Topic/Subtopic taxonomy (LLM map-reduce over titles)\n`)
  reportSections.push(`Generated from ${titles.length} translated titles, ${batches.length} map batches, ${allProposals.length} raw proposed topics consolidated into ${finalTopics.length} final topics.\n`)

  for (const topic of finalTopics) {
    reportSections.push(`## ${topic.name}`)
    reportSections.push(`${topic.description}\n`)
    for (const sub of topic.subtopics ?? []) {
      reportSections.push(`- **${sub.name}** -- ${sub.description}`)
    }
    reportSections.push('')
  }

  reportSections.push(`## Appendix: raw proposed topics before consolidation\n`)
  for (const t of allProposals) {
    reportSections.push(`- ${t.name} -- ${t.description}`)
  }

  writeFileSync(REPORT_PATH, reportSections.join('\n'))
  console.log(`\nWrote report to ${REPORT_PATH}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
