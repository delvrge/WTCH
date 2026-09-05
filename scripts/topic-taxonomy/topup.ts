// Periodic top-up: runs scrape → translate → embed in sequence, so keeping
// topic_taxonomy_posts current (it's live-read by investigation.ts and
// solved-cases.ts — see README.md) is one command instead of three.
//
// Deliberately excludes the clustering/labeling steps (3a-4) — those are a
// one-off taxonomy-design exercise, not routine maintenance, and re-running
// them risks disturbing the fixed taxonomy already locked in and referenced
// by lib/topic-taxonomy.ts. All three steps here are idempotent
// (upsert-on-url in 1-scrape, only-touch-NULL in 1b-translate/2-embed), so
// running this regularly only processes what's new since last time.
//
// Run:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... GEMINI_API_KEY=... USER_ID=... \
//     npx tsx scripts/topic-taxonomy/topup.ts
//
// (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/GEMINI_API_KEY are auto-loaded from
// .env.local by each step's own './lib/load-env' — only USER_ID, needed by
// 1-scrape.ts alone, isn't in .env.local and must be passed inline, same as
// running that step by itself.)

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const dir = dirname(fileURLToPath(import.meta.url))

const steps = ['1-scrape.ts', '1b-translate.ts', '2-embed.ts']

for (const step of steps) {
  console.log(`\n=== ${step} ===`)
  const result = spawnSync('npx', ['tsx', join(dir, step)], { stdio: 'inherit', env: process.env })
  if (result.status !== 0) {
    console.error(`\n${step} failed (exit ${result.status}) — stopping. Re-run this script once fixed; every step is safe to resume.`)
    process.exit(result.status ?? 1)
  }
}

console.log('\nTop-up complete.')
