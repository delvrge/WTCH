// Step 1 of the one-off topic-taxonomy pipeline: scrape every watched-board
// post from the last year into the isolated topic_taxonomy_posts staging
// table. Read-only toward the platform (GET only), serial, rate-limited, and
// resumable, safe to re-run or Ctrl-C and restart, upserts on `url` so
// nothing is re-fetched-and-duplicated, though already-fetched threads are
// still skipped over on re-run at sitemap-walk speed, not thread-fetch speed.
//
// Run:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... USER_ID=... \
//     npx tsx scripts/topic-taxonomy/1-scrape.ts
//
// USER_ID is the ALLOWED_USER_ID value (the single operator's auth.users.id,
// same one the edge functions check against).

import './lib/load-env'
import { createClient } from '@supabase/supabase-js'
import { discoverAllWatchedTopics, fetchThreadForTaxonomy, sleep, CommunityFetchError } from './lib/scrape-lib'

const MAX_AGE_DAYS = 365
const SITEMAP_DELAY_MS = 300
const THREAD_DELAY_MS = 500

const supabaseUrl = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const userId = process.env.USER_ID

if (!supabaseUrl || !serviceRoleKey || !userId) {
  console.error('Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or USER_ID')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey)

async function main() {
  console.log(`Discovering topic URLs from the last ${MAX_AGE_DAYS} days...`)
  const candidates = await discoverAllWatchedTopics(MAX_AGE_DAYS, SITEMAP_DELAY_MS, (msg) => console.log(`  ${msg}`))
  console.log(`Found ${candidates.length} candidate topic URLs across the watched boards.`)

  // Skip URLs already scraped in a prior run of this script.
  const { data: existing, error: existingErr } = await supabase.from('topic_taxonomy_posts').select('url')
  if (existingErr) throw existingErr
  const alreadyScraped = new Set((existing ?? []).map((r) => r.url))
  const todo = candidates.filter((c) => !alreadyScraped.has(c.url))
  console.log(`${alreadyScraped.size} already scraped, ${todo.length} left to fetch.`)

  let inserted = 0
  let skippedOld = 0
  let errors = 0

  for (let i = 0; i < todo.length; i++) {
    const { url, board } = todo[i]
    try {
      const thread = await fetchThreadForTaxonomy(url)

      if (thread.created_at) {
        const ts = Date.parse(thread.created_at)
        if (!Number.isNaN(ts) && ts < Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000) {
          skippedOld++
          continue
        }
      }

      const { error } = await supabase.from('topic_taxonomy_posts').upsert(
        [
          {
            user_id: userId,
            url,
            board,
            title: thread.title,
            body: thread.body,
            post_created_at: thread.created_at,
            scraped_at: new Date().toISOString(),
          },
        ],
        { onConflict: 'url' },
      )
      if (error) throw error
      inserted++
    } catch (err) {
      errors++
      if (err instanceof CommunityFetchError) {
        console.error(`  [${i + 1}/${todo.length}] ${err.status} ${url}`)
      } else {
        console.error(`  [${i + 1}/${todo.length}] ${(err as Error).message}`)
      }
    }

    if ((i + 1) % 50 === 0) {
      console.log(`  progress: ${i + 1}/${todo.length} (inserted ${inserted}, skipped-old ${skippedOld}, errors ${errors})`)
    }

    if (i < todo.length - 1) {
      await sleep(THREAD_DELAY_MS)
    }
  }

  console.log(`\nDone. Inserted ${inserted}, skipped-old ${skippedOld}, errors ${errors}.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
