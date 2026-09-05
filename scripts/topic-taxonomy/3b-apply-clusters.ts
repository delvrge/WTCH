// Step 3c (after cluster.py): write HDBSCAN's cluster_id labels back onto
// topic_taxonomy_posts.
//
// Run:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     npx tsx scripts/topic-taxonomy/3b-apply-clusters.ts

import './lib/load-env'
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const INPUT_PATH = join(__dirname, 'output', 'cluster-labels.json')

const supabaseUrl = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey)

async function main() {
  const labels: { id: string; cluster_id: number }[] = JSON.parse(readFileSync(INPUT_PATH, 'utf-8'))
  console.log(`Applying ${labels.length} cluster labels...`)

  for (let i = 0; i < labels.length; i++) {
    const { id, cluster_id } = labels[i]
    const { error } = await supabase.from('topic_taxonomy_posts').update({ cluster_id }).eq('id', id)
    if (error) throw error
    if ((i + 1) % 200 === 0) console.log(`  ${i + 1}/${labels.length}`)
  }

  console.log('done')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
