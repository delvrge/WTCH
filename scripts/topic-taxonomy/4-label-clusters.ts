// Step 4 (run only after clustering is stable -- i.e. after reviewing
// cluster.py's console output and being happy with the cluster count):
// sample 10-15 posts per cluster, ask Gemini for one Topic + Subtopic
// name grounded in what's actually in the cluster, write topic/subtopic back
// onto every row in that cluster, and emit a markdown review report.
//
// Run:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... GEMINI_API_KEY=... \
//     npx tsx scripts/topic-taxonomy/4-label-clusters.ts

import './lib/load-env'
import { createClient } from '@supabase/supabase-js'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { chatJSON } from '../lib/gemini'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPORT_PATH = join(__dirname, 'output', 'taxonomy-report.md')

const SAMPLE_SIZE = 15
const EXAMPLES_IN_REPORT = 5

const supabaseUrl = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const geminiApiKey = process.env.GEMINI_API_KEY

if (!supabaseUrl || !serviceRoleKey || !geminiApiKey) {
  console.error('Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or GEMINI_API_KEY')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey)

interface Post {
  id: string
  url: string
  title: string
  body: string
  cluster_id: number
}

function sample<T>(arr: T[], n: number): T[] {
  const copy = [...arr]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy.slice(0, n)
}

async function proposeTopicSubtopic(posts: Post[]): Promise<{ topic: string; subtopic: string }> {
  const excerpt = posts.map((p, i) => `[${i + 1}] ${p.title}\n${p.body.slice(0, 500)}`).join('\n\n')
  const content = await chatJSON({
    apiKey: geminiApiKey!,
    systemPrompt:
      `You name clusters of ${process.env.PRODUCT_NAME ?? 'the product'} community forum posts for a support taxonomy. Given a sample of posts from ONE cluster, propose exactly one short Topic (broad area, e.g. "Image Generation", "Billing & Credits", "Account & Login") and one Subtopic (specific, e.g. "Blurry output quality", "Credits not refreshing"). Base the names only on what is actually in the sample -- do not invent categories the sample does not support. Respond as JSON: {"topic": "...", "subtopic": "..."}.`,
    userContent: excerpt,
  })
  const parsed = JSON.parse(content)
  if (!parsed.topic || !parsed.subtopic) throw new Error('Model response missing topic/subtopic')
  return parsed
}

// PostgREST caps a single response at 1000 rows by default -- this read
// doesn't mutate cluster_id as it goes, so a plain offset .range() page is
// safe here (unlike 2-embed.ts's IS NULL filter, which shrinks mid-loop).
const PAGE_SIZE = 1000

async function fetchAllClusteredRows(): Promise<Post[]> {
  const all: Post[] = []
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('topic_taxonomy_posts')
      .select('id, url, title, body, cluster_id')
      .not('cluster_id', 'is', null)
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    all.push(...(data as Post[]))
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return all
}

async function main() {
  const rows = await fetchAllClusteredRows()
  if (rows.length === 0) {
    console.error('No clustered rows found -- run 3b-apply-clusters.ts first.')
    process.exit(1)
  }

  const byCluster = new Map<number, Post[]>()
  for (const row of rows as Post[]) {
    if (!byCluster.has(row.cluster_id)) byCluster.set(row.cluster_id, [])
    byCluster.get(row.cluster_id)!.push(row)
  }

  const unclustered = byCluster.get(-1) ?? []
  const clusterIds = [...byCluster.keys()].filter((id) => id !== -1).sort((a, b) => byCluster.get(b)!.length - byCluster.get(a)!.length)

  console.log(`${clusterIds.length} clusters, ${unclustered.length} unclustered posts`)

  const reportSections: string[] = []
  reportSections.push(`# Topic/Subtopic taxonomy proposal\n`)
  reportSections.push(`Generated from ${rows.length} clustered posts across ${clusterIds.length} clusters. ${unclustered.length} posts landed in the unclustered pile.\n`)

  for (const clusterId of clusterIds) {
    const posts = byCluster.get(clusterId)!
    const sampled = sample(posts, Math.min(SAMPLE_SIZE, posts.length))
    console.log(`cluster ${clusterId}: ${posts.length} posts, sampling ${sampled.length}`)

    const { topic, subtopic } = await proposeTopicSubtopic(sampled)

    const { error: updateError } = await supabase
      .from('topic_taxonomy_posts')
      .update({ topic, subtopic })
      .eq('cluster_id', clusterId)
    if (updateError) throw updateError

    const examples = sample(posts, Math.min(EXAMPLES_IN_REPORT, posts.length))
    reportSections.push(`## Cluster ${clusterId}: ${topic}, ${subtopic}`)
    reportSections.push(`${posts.length} posts\n`)
    for (const ex of examples) {
      reportSections.push(`- [${ex.title}](${ex.url})`)
    }
    reportSections.push('')
  }

  reportSections.push(`## Unclustered (noise)`)
  reportSections.push(`${unclustered.length} posts did not clearly belong to any cluster.\n`)
  for (const ex of sample(unclustered, Math.min(EXAMPLES_IN_REPORT, unclustered.length))) {
    reportSections.push(`- [${ex.title}](${ex.url})`)
  }

  writeFileSync(REPORT_PATH, reportSections.join('\n'))
  console.log(`\nWrote report to ${REPORT_PATH}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
