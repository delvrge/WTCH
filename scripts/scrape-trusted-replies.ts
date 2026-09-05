// One-time (re-runnable) backfill: pulls each trusted CM/CE's own reply
// history from their community platform profile, going back CUTOFF_MONTHS,
// and stores each (problem, their specific reply) pair in trusted_replies ,
// see migration 20260823000200_trusted_replies.sql for why this is its own
// table instead of verified_answers.
//
// The profile activity feed is client-rendered (a plain fetch sees nothing),
// so this uses a headless Chromium tab (Playwright) just to enumerate each
// person's thread links via "Show more posts" pagination. Once a thread URL
// is known, the actual thread content is fetched the same way the rest of
// the app does it: fetchThread() from _shared/community-sources.ts, a plain
// GET (same read-only-toward-the-platform posture as everywhere else). That
// file has zero Deno-specific imports, so it's imported here unmodified.
//
// Idempotent: re-running skips any (source_url, source_author) pair already
// stored (unique constraint + a pre-check), and safe to re-run to pick up
// each person's newer replies later.
//
// Profile URLs are deployment-specific, set TRUSTED_AUTHOR_PROFILE_URLS as
// a comma-separated env var (full profile URLs on your COMMUNITY_HOST).
//
// Run:
//   TRUSTED_AUTHOR_PROFILE_URLS=https://community.example.com/members/janedoe-1234 \
//     npx tsx scripts/scrape-trusted-replies.ts
//   npx tsx scripts/scrape-trusted-replies.ts --only janedoe-1234   (one profile, for testing)

import './topic-taxonomy/lib/load-env'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { appendFileSync } from 'node:fs'
import { fetchThread } from '../supabase/functions/_shared/community-sources'
import type { ThreadAnswer, ThreadContent } from '../supabase/functions/_shared/community-sources'
import { ISSUE_SUMMARY_CORE } from '../supabase/functions/_shared/normalize-issue'
import { chatJSON, embed as geminiEmbed } from './lib/gemini'

// console.log alone has been observed to vanish entirely (nothing in the
// redirected file) when this script gets killed mid-run on a high-volume
// profile, a stray progress file written synchronously, line by line,
// survives that even when stdout doesn't.
const PROGRESS_FILE = process.env.SCRAPE_PROGRESS_FILE || '/tmp/scrape-trusted-replies.progress.log'
function log(msg: string): void {
  console.log(msg)
  try {
    appendFileSync(PROGRESS_FILE, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    // best-effort only
  }
}

const PROFILE_URLS = (process.env.TRUSTED_AUTHOR_PROFILE_URLS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const CUTOFF_MONTHS = 6
const THREAD_DELAY_MS = 600
const PAGINATION_DELAY_MS = 900
const MAX_PAGINATION_CLICKS = 120

const supabaseUrl = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const geminiApiKey = process.env.GEMINI_API_KEY
const allowedUserId = process.env.ALLOWED_USER_ID

if (!supabaseUrl || !serviceRoleKey) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from .env.local')
if (!geminiApiKey) throw new Error('GEMINI_API_KEY missing from .env.local')

const apiKey: string = geminiApiKey
const supabase = createClient(supabaseUrl, serviceRoleKey)

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeUrl(u: string): string {
  return u.trim().replace(/\/+$/, '')
}

function normalizeName(n: string): string {
  return n.trim().toLowerCase().replace(/\s+/g, ' ')
}

async function resolveUserId(): Promise<string> {
  if (allowedUserId) return allowedUserId
  const { data, error } = await supabase.from('community_patterns').select('user_id').limit(1).single()
  if (error) throw error
  return (data as { user_id: string }).user_id
}

/** Converts one relative-date string ("11 days ago", "4 months ago") to an
 *  approximate day count. Used ONLY to decide when to stop clicking "Show
 *  more posts", never to decide whether a reply is actually in range. The
 *  real cutoff, checked per-thread below, is the fetched answer's own
 *  created_at from JSON-LD, which is exact. */
function relativeAgeDays(relativeText: string): number {
  const m = relativeText.match(/(\d+)\s*(day|week|month|year)s?\s*ago/i)
  if (!m) return 0
  const n = Number(m[1])
  const unit = m[2].toLowerCase()
  if (unit === 'day') return n
  if (unit === 'week') return n * 7
  if (unit === 'month') return n * 30
  return n * 365
}

const CUTOFF_DAYS = CUTOFF_MONTHS * 30
// Hard wall-clock budget for the WHOLE pagination loop on one profile.
// Someone with hundreds of replies could otherwise page for a very long
// time; once this is hit, whatever's been collected so far is returned
// as-is rather than risking the process being killed with nothing saved.
const PAGINATION_TIME_BUDGET_MS = 180000

/** Clicks "Show more posts" on an already-loaded profile page until either
 *  the button disappears, the OLDEST entry loaded so far is past the
 *  cutoff, MAX_PAGINATION_CLICKS is hit, or PAGINATION_TIME_BUDGET_MS
 *  elapses. Returns every candidate thread URL found in the activity feed
 *  (deduplicated, /replies/<id> suffix stripped so it points at the
 *  canonical thread fetchThread() expects).
 *
 *  Everything is read in ONE page.evaluate() call per iteration (raw DOM,
 *  no per-element Playwright IPC round-trips), with hundreds of
 *  accumulated entries after many clicks, doing this element-by-element
 *  turned each iteration into hundreds of round-trips and made the whole
 *  loop unusably slow on a high-volume profile. */
async function collectActivityLinks(page: import('playwright').Page): Promise<string[]> {
  const seen = new Set<string>()
  const startedAt = Date.now()

  for (let click = 0; click < MAX_PAGINATION_CLICKS; click++) {
    if (Date.now() - startedAt > PAGINATION_TIME_BUDGET_MS) {
      if (process.env.DEBUG_SCRAPE) log(`    [click ${click}] time budget hit, stopping`)
      break
    }

    const { hrefs, dateTexts } = await page.evaluate(() => {
      const main = document.querySelector('main')
      if (!main) return { hrefs: [] as string[], dateTexts: [] as string[] }
      const links = Array.from(main.querySelectorAll('a[href]')) as HTMLAnchorElement[]
      const hrefs = links
        .map((a) => a.getAttribute('href') || '')
        .filter((h) => /\/replies\/|\/conversations\/|\/questions\/|\/bug-reports\//.test(h) && !h.includes('/members/'))
      const dateTexts = (main.innerText.match(/\d+\s*(?:day|week|month|year)s?\s*ago/gi) || [])
      return { hrefs, dateTexts }
    })

    for (const href of hrefs) {
      const abs = href.startsWith('http') ? href : new URL(href, `https://${process.env.COMMUNITY_HOST ?? 'community.example.com'}`).toString()
      const base = abs.replace(/\/replies\/\d+\/?$/, '')
      seen.add(base)
    }

    const maxAgeDays = dateTexts.reduce((max, t) => Math.max(max, relativeAgeDays(t)), 0)
    if (process.env.DEBUG_SCRAPE) {
      log(`    [click ${click}] links=${hrefs.length} seen=${seen.size} maxAgeDays=${maxAgeDays} elapsed=${Date.now() - startedAt}ms`)
    }
    if (maxAgeDays >= CUTOFF_DAYS) break

    // Not a real <button>, the platform renders this as an <a class="btn--load-more">
    // styled to look like one, with a click handler that AJAX-appends the
    // next page rather than navigating. getByRole('button', ...) never
    // matches it, so pagination silently never advanced past the first load.
    const showMore = page.locator('a.btn--load-more')
    const visible = await showMore.isVisible().catch(() => false)
    if (!visible) break
    await showMore.scrollIntoViewIfNeeded().catch(() => {})
    await showMore.click()
    await sleep(PAGINATION_DELAY_MS)
  }

  return [...seen]
}

interface ExtractedPair {
  question_summary: string
  answer_text: string
}

async function extractPair(thread: ThreadContent, answer: ThreadAnswer, apiKey: string): Promise<ExtractedPair> {
  const systemPrompt = `You are building a precedent bank of real support replies from a trusted ${process.env.PRODUCT_NAME ?? 'the product'} Community Manager/Expert, for another operator to learn from and cite when drafting their own replies.

Given a forum thread's original post and ONE specific reply on it, produce:
- question_summary: ${ISSUE_SUMMARY_CORE} Always in English, even if the original post is in another language.
- answer_text: the reply's actual content, lightly cleaned (strip greetings like "Hi there,", sign-offs, quoted-post artifacts, forum boilerplate) but otherwise kept close to the original wording and substance. Do NOT paraphrase, generalize, or summarize it into an abstract description. If the reply is not already in English, translate it, preserving its actual content and tone as closely as a translation allows.
Never use an em dash (—) anywhere; use a period, comma, or "and" instead.

Respond with ONLY a JSON object: { "question_summary": string, "answer_text": string }`

  const userContent = `THREAD TITLE: ${thread.title}\n\nORIGINAL POST:\n${thread.body}\n\nTHE REPLY TO EXTRACT:\n${answer.text}`

  const raw = await chatJSON({ apiKey, systemPrompt, userContent, temperature: 0.3 })
  const parsed = JSON.parse(raw)
  if (!parsed.question_summary || !parsed.answer_text) throw new Error('AI response missing required fields')
  return { question_summary: String(parsed.question_summary).trim(), answer_text: String(parsed.answer_text).trim() }
}

async function embed(text: string, apiKey: string): Promise<number[]> {
  return geminiEmbed({ apiKey, text })
}

async function main() {
  const args = process.argv.slice(2)
  const onlyArg = args.indexOf('--only')
  const only = onlyArg >= 0 ? args[onlyArg + 1] : null
  const profileUrls = only ? PROFILE_URLS.filter((u) => u.includes(only)) : PROFILE_URLS
  if (only && !profileUrls.length) throw new Error(`--only "${only}" matched no profile URL`)

  const userId = await resolveUserId()
  const cutoff = new Date()
  cutoff.setMonth(cutoff.getMonth() - CUTOFF_MONTHS)

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ userAgent: 'CommunityWatch/1.0' })

  let totalInserted = 0
  let totalSkippedOld = 0
  let totalSkippedDup = 0
  let totalSkippedNoMatch = 0
  let totalErrors = 0

  try {
    for (const profileUrl of profileUrls) {
      log(`\n=== ${profileUrl} ===`)
      await page.goto(profileUrl, { waitUntil: 'networkidle', timeout: 30000 })
      await sleep(1000)

      const displayName = (await page.locator('h1').first().textContent().catch(() => null))?.trim() ?? null
      log(`  display name: ${displayName ?? '(unknown)'}`)

      const links = await collectActivityLinks(page)
      log(`  ${links.length} candidate thread link(s)`)

      for (let i = 0; i < links.length; i++) {
        const threadUrl = links[i]
        try {
          const thread = await fetchThread(threadUrl)

          const answer =
            thread.answers.find((a) => a.author_url && normalizeUrl(a.author_url) === normalizeUrl(profileUrl)) ??
            (displayName ? thread.answers.find((a) => a.author && normalizeName(a.author) === normalizeName(displayName)) : undefined)

          if (!answer) {
            totalSkippedNoMatch++
            continue
          }

          const answerDate = answer.created_at ? new Date(answer.created_at) : null
          if (!answerDate || Number.isNaN(answerDate.getTime()) || answerDate < cutoff) {
            totalSkippedOld++
            continue
          }

          const authorLabel = answer.author ?? displayName ?? 'unknown'

          const { data: existing } = await supabase
            .from('trusted_replies')
            .select('id')
            .eq('source_url', threadUrl)
            .eq('source_author', authorLabel)
            .maybeSingle()
          if (existing) {
            totalSkippedDup++
            continue
          }

          const { question_summary, answer_text } = await extractPair(thread, answer, apiKey)
          const embedding = await embed(question_summary, apiKey)

          const { error: insertError } = await supabase.from('trusted_replies').insert({
            user_id: userId,
            question_summary,
            answer_text,
            source_url: threadUrl,
            source_title: thread.title,
            source_author: authorLabel,
            source_badge: answer.badge ?? null,
            is_accepted: answer.is_accepted,
            thread_created_at: answer.created_at,
            embedding,
          })
          if (insertError) {
            // Unique constraint race (re-run overlap) is not a real failure.
            if (insertError.code === '23505') totalSkippedDup++
            else throw insertError
          } else {
            totalInserted++
          }
        } catch (err) {
          totalErrors++
          log(`  [${i + 1}/${links.length}] ERROR ${(err as Error).message}`)
        }

        if ((i + 1) % 25 === 0) {
          log(`  progress: ${i + 1}/${links.length} (inserted ${totalInserted}, dup ${totalSkippedDup}, old ${totalSkippedOld}, no-match ${totalSkippedNoMatch}, errors ${totalErrors})`)
        }

        await sleep(THREAD_DELAY_MS)
      }
    }
  } finally {
    await browser.close()
  }

  log(`\nDone. inserted ${totalInserted}, dup ${totalSkippedDup}, old ${totalSkippedOld}, no-match ${totalSkippedNoMatch}, errors ${totalErrors}.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
