// Step 3a: dump every embedded post's {id, embedding} to a local JSON file
// for the Python clustering step. Keeps HDBSCAN's dependency (numpy/sklearn/
// hdbscan) out of the Node/edge-function world entirely, cluster.py has no
// DB credentials and touches nothing but this file and its output.
//
// Run:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     npx tsx scripts/topic-taxonomy/3a-export-embeddings.ts

import './lib/load-env'
import { createClient } from '@supabase/supabase-js'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = join(__dirname, 'output', 'embeddings.json')

const supabaseUrl = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey)

// PostgREST caps a single response at 1000 rows by default, a plain select
// silently truncates past that, so this pages through with .range() until a
// page comes back short.
const PAGE_SIZE = 1000

async function fetchAllRows(): Promise<{ id: string; embedding: string | number[] }[]> {
  const all: { id: string; embedding: string | number[] }[] = []
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('topic_taxonomy_posts')
      .select('id, embedding')
      .not('embedding', 'is', null)
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    all.push(...data)
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return all
}

// PostgREST serializes pgvector columns as their string literal
// ("[0.001,-0.002,...]"), not a JSON array, parse it into real numbers so
// the exported JSON is directly usable by numpy on the Python side.
function parseEmbedding(raw: string | number[]): number[] {
  if (Array.isArray(raw)) return raw
  return JSON.parse(raw)
}

async function main() {
  const rows = await fetchAllRows()
  console.log(`Exporting ${rows.length} embeddings to ${OUTPUT_PATH}`)

  const parsed = rows.map((r) => ({ id: r.id, embedding: parseEmbedding(r.embedding) }))
  writeFileSync(OUTPUT_PATH, JSON.stringify(parsed))
  console.log('done')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
