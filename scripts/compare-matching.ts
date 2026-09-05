// Measures the matching fix: raw-text embedding (the old query path) vs
// normalize-then-embed (the new one), scored against the live data.
//
//   npx tsx scripts/compare-matching.ts [--limit N] [--verbose]
//
// Read-only. Sends nothing to the platform, writes nothing to the database.
//
// METHOD
// Every community_patterns row stores `source_title`: the real post title,
// in the poster's own language, verbatim. That gives free ground truth —
// query with a case's own title and the case itself is the row that SHOULD
// come back first. So for each sampled row we:
//
//   OLD path: embed the raw title, match against community_patterns
//   NEW path: abstract the title to an English issue description
//             (normalizeAndEmbed), then match
//
// and report where the row's own id ranked, and at what similarity. A rank
// of 1 at a high similarity is the outcome the fix is supposed to produce;
// rank "-" means the true row did not come back at all above the floor.
//
// The same two embeddings are also run against verified_answers, whose
// stored vectors are embeddings of `question_summary` — abstracted English.
// There is no ground truth there, so it reports top-1 similarity only: the
// number that TRACKER_MIN_SIMILARITY has to be set against.

import './topic-taxonomy/lib/load-env'
import { createClient } from '@supabase/supabase-js'
import { normalizeAndEmbed, embedText } from '../supabase/functions/_shared/normalize-issue'

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const geminiApiKey = process.env.GEMINI_API_KEY
const allowedUserId = process.env.ALLOWED_USER_ID

if (!supabaseUrl || !serviceRoleKey) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from .env.local')
if (!geminiApiKey) throw new Error('GEMINI_API_KEY missing from .env.local')

const args = process.argv.slice(2)
const limitArg = args.indexOf('--limit')
const LIMIT = limitArg >= 0 ? Number(args[limitArg + 1]) : 12
const VERBOSE = args.includes('--verbose')

// Floor low on purpose: this is a measurement run, not the production path.
// A high floor would hide exactly the near-misses worth seeing.
const PROBE_MIN_SIMILARITY = 0.3
const PROBE_MATCH_COUNT = 10

const supabase = createClient(supabaseUrl, serviceRoleKey)

interface Row {
  id: string
  user_id: string
  source_title: string | null
  issue_summary: string
  surface: string | null
}

interface Match { id: string; similarity: number }

async function matchPatterns(userId: string, embedding: number[]): Promise<Match[]> {
  const { data, error } = await supabase.rpc('match_community_patterns', {
    p_user_id: userId,
    p_embedding: embedding,
    p_match_count: PROBE_MATCH_COUNT,
    p_min_similarity: PROBE_MIN_SIMILARITY,
  })
  if (error) throw error
  return ((data ?? []) as Match[]).sort((a, b) => b.similarity - a.similarity)
}

async function matchVerified(userId: string, embedding: number[]): Promise<Match[]> {
  const { data, error } = await supabase.rpc('match_verified_answers', {
    p_user_id: userId,
    p_embedding: embedding,
    p_match_count: PROBE_MATCH_COUNT,
    p_min_similarity: PROBE_MIN_SIMILARITY,
  })
  if (error) throw error
  return ((data ?? []) as Match[]).sort((a, b) => b.similarity - a.similarity)
}

/** 1-based rank of `id` in `matches`, or null when absent. */
function rankOf(matches: Match[], id: string): number | null {
  const i = matches.findIndex((m) => m.id === id)
  return i < 0 ? null : i + 1
}

function pad(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n)
}

function fmtRank(rank: number | null, sim: number | undefined): string {
  if (rank === null) return pad('—', 11)
  return pad(`#${rank} @ ${sim!.toFixed(3)}`, 11)
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
}

async function main() {
  let query = supabase
    .from('community_patterns')
    .select('id, user_id, source_title, issue_summary, surface')
    .not('source_title', 'is', null)
    .order('last_seen', { ascending: false })
    .limit(LIMIT)
  if (allowedUserId) query = query.eq('user_id', allowedUserId)

  const { data, error } = await query
  if (error) throw error
  const rows = (data ?? []) as Row[]
  if (!rows.length) {
    console.log('No community_patterns rows with a source_title — nothing to probe.')
    return
  }

  console.log(`Probing ${rows.length} case(s) by their own source_title.\n`)
  console.log(`${pad('TITLE (the query)', 44)} ${pad('OLD raw', 11)} ${pad('NEW normalized', 11)}`)
  console.log('-'.repeat(70))

  const oldSelfSims: number[] = []
  const newSelfSims: number[] = []
  const oldTrackerTop: number[] = []
  const newTrackerTop: number[] = []
  let oldFound = 0
  let newFound = 0
  let oldRank1 = 0
  let newRank1 = 0

  for (const row of rows) {
    const title = row.source_title!.trim()
    try {
      const oldEmbedding = await embedText(title, geminiApiKey!)
      const { issueDescription, embedding: newEmbedding } = await normalizeAndEmbed(title, geminiApiKey!)

      const [oldMatches, newMatches, oldTracker, newTracker] = await Promise.all([
        matchPatterns(row.user_id, oldEmbedding),
        matchPatterns(row.user_id, newEmbedding),
        matchVerified(row.user_id, oldEmbedding),
        matchVerified(row.user_id, newEmbedding),
      ])

      const oldRank = rankOf(oldMatches, row.id)
      const newRank = rankOf(newMatches, row.id)
      const oldSim = oldRank ? oldMatches[oldRank - 1].similarity : undefined
      const newSim = newRank ? newMatches[newRank - 1].similarity : undefined

      if (oldRank) { oldFound++; oldSelfSims.push(oldSim!); if (oldRank === 1) oldRank1++ }
      if (newRank) { newFound++; newSelfSims.push(newSim!); if (newRank === 1) newRank1++ }
      if (oldTracker[0]) oldTrackerTop.push(oldTracker[0].similarity)
      if (newTracker[0]) newTrackerTop.push(newTracker[0].similarity)

      console.log(`${pad(title, 44)} ${fmtRank(oldRank, oldSim)} ${fmtRank(newRank, newSim)}`)
      if (VERBOSE) {
        console.log(`    stored issue_summary: ${row.issue_summary}`)
        console.log(`    normalized query:     ${issueDescription}`)
        console.log(`    tracker top-1:        old ${oldTracker[0]?.similarity.toFixed(3) ?? '—'} / new ${newTracker[0]?.similarity.toFixed(3) ?? '—'}`)
      }
    } catch (err) {
      console.log(`${pad(title, 44)} ERROR: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  console.log('\n── community_patterns: did the case find ITSELF ──')
  console.log(`  retrieved at all:   old ${oldFound}/${rows.length}   new ${newFound}/${rows.length}`)
  console.log(`  ranked #1:          old ${oldRank1}/${rows.length}   new ${newRank1}/${rows.length}`)
  console.log(`  mean similarity:    old ${mean(oldSelfSims).toFixed(3)}      new ${mean(newSelfSims).toFixed(3)}`)
  console.log('\n── verified_answers: top-1 similarity (no ground truth) ──')
  console.log(`  mean top-1:         old ${mean(oldTrackerTop).toFixed(3)}      new ${mean(newTrackerTop).toFixed(3)}`)
  console.log(`  n with any hit:     old ${oldTrackerTop.length}/${rows.length}   new ${newTrackerTop.length}/${rows.length}`)
  console.log('\nSet TRACKER_MIN_SIMILARITY / PATTERN_MIN_SIMILARITY below the NEW')
  console.log('numbers a genuine match scores, above what an unrelated row scores.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
