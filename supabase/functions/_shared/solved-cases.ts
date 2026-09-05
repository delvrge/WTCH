// Finds past community threads that describe the same problem AND already have
// an answer on them.
//
// WHY THIS EXISTS
// The case the operator is working is almost always unanswered, often empty,
// or carrying nothing but the operator's own "please send a screenshot".
// Reading that thread tells you what the problem is; it cannot tell you what
// the solution was. The solution, if it exists anywhere, is on a DIFFERENT
// thread that was already resolved. This module goes and finds those.
//
// It replaces something that cannot be done: many community platforms show a
// "related topics" rail with Answered badges, but that rail (and the green
// "Correct Answer" box on bug-report boards) is drawn client-side. A plain
// GET never sees it. So rather than scrape the site's suggestions, this
// searches the operator's OWN corpus of scraped community posts
// (topic_taxonomy_posts) semantically, then fetches the best candidates and
// checks each one for a real answer.
//
// EMBEDDING SHAPE, the easy mistake here
// topic_taxonomy_posts.embedding is an embedding of `title_en || body_en`,
// full post text. It is NOT the abstracted one-liner that community_patterns
// and verified_answers store. Pass this module a FULL-TEXT embedding (the
// fetched thread's title + body), never the normalized issue description used
// for the other two searches, or you reintroduce exactly the raw-vs-abstracted
// mismatch that _shared/normalize-issue.ts exists to prevent.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import {
  citableAuthorityAnswers,
  discoverTopics,
  fetchThread,
  parseTopicUrl,
} from './community-sources.ts'
import type { ThreadAnswer, ThreadContent } from './community-sources.ts'
import { chatJSON } from './ai-provider.ts'

/** Corpus rows to consider before any thread is fetched. */
const CORPUS_CANDIDATE_LIMIT = 18
/**
 * Full-text against full-text, so this floor is NOT comparable to the 0.6 used
 * for the abstracted-summary searches. Set deliberately loose: a candidate that
 * survives here still has to pass the much stricter "does it actually have an
 * answer" test below, which is what really filters the list.
 */
const CORPUS_MIN_SIMILARITY = 0.45
/** Hard cap on page fetches per run. Each is ~1.4MB and ~300ms of politeness. */
const MAX_THREAD_FETCHES = 8
/** Solved cases worth returning before the live-discovery fallback is skipped.
 *  Bumped from 2 to 3 (with CORPUS_CANDIDATE_LIMIT/MAX_THREAD_FETCHES raised
 *  to match) so a case with real prior art doesn't get shorted just because
 *  two hits looked "enough", the operator wants three when three exist. */
const ENOUGH_SOLVED = 3
/** Staff replies per thread sent to the model. Threads rarely carry more than
 *  two or three that are worth judging, and this bounds the prompt. */
const MAX_CANDIDATES_PER_THREAD = 3
/** Wall-clock ceiling for the whole search, fetches included. */
const SEARCH_TIME_BUDGET_MS = 20000
/** Matches TOPIC_FETCH_DELAY_MS in community-sources.ts. */
const FETCH_DELAY_MS = 300

/**
 * Why a thread counts as answered, strongest first. Shown to the operator,
 * because these are genuinely different strengths of claim.
 *
 * The plain "a CM/CE replied" tier is deliberately GONE. It was the original
 * proxy and it was too noisy to keep: community managers reply constantly
 * just to ask for a screenshot or an OS version, so most "solved" threads it
 * surfaced contained no solution at all. A reply now has to survive the
 * three checks below to count.
 */
export type SolvedReason =
  /** The asker or a moderator marked this reply as the solution. */
  | 'accepted_answer'
  /** The person who asked replied afterwards saying it worked. */
  | 'confirmed_by_asker'
  /** A model read the reply and judged that it resolves the issue rather
   *  than requesting more information. */
  | 'verified_fix'

export interface SolvedCase {
  url: string
  /** The post's own title, in its own language. */
  title: string
  board: string | null
  similarity: number
  reason: SolvedReason
  answer: {
    text: string
    author: string | null
    badge: string | null
    created_at: string | null
    /** Screenshot/attachment URLs on the real answer, see ThreadAnswer.images. */
    images: string[]
  }
}

export interface SolvedSearchResult {
  cases: SolvedCase[]
  /** Threads fetched but rejected, with the reason. The tuning surface: if
   *  good threads are being dropped, it shows up here first. */
  dropped: { url: string; reason: string }[]
  errors: string[]
  /** True when the corpus came up short and live discovery was used. */
  widened: boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Phrases that mark a reply as a request for information rather than an
// answer. Free first-pass filter: anything caught here never reaches the
// model, so the obvious "can you send a screenshot" replies cost nothing to
// reject. Deliberately conservative, a reply that BOTH asks something and
// gives a fix must survive this and be judged properly by the model.
const INFO_REQUEST_PHRASES = [
  'could you provide',
  'could you share',
  'can you please',
  'can you provide',
  'can you share',
  'could you try',
  'more details',
  'more information',
  'a few more',
  'which browser',
  'what browser',
  'what os',
  'which os',
  'operating system',
  'screen shot',
  'screenshot',
  'let us know',
  'are you still',
]

// Markers that a reply contains something ACTIONABLE, whatever else it also
// asks for. Their presence vetoes the info-request heuristic entirely, because
// staff routinely do both in one breath: "Definitely need more information.
// Could you try logging out of your Creative Cloud app and then log back in?"
// is a request AND the fix, and the first cut of this filter threw it away.
// When a reply contains any of these, only the model gets to judge it.
const FIX_MARKERS = [
  'try ',
  'log out',
  'logout',
  'sign out',
  'log back',
  'clear your',
  'clear the',
  'cache',
  'update',
  'reinstall',
  'disable',
  'enable',
  'switch to',
  'known issue',
  'expected behavior',
  'working on',
  'has been fixed',
  'is fixed',
  'resolved',
  'workaround',
  'instead of',
  'make sure',
  'check that',
  'you can',
  'go to',
  'click',
  'select',
]

/** Words an asker uses when something worked. Matched loosely and in a few
 *  languages, since community posts arrive in many. */
const CONFIRMATION_PHRASES = [
  'thank',
  'thanks',
  'that worked',
  'it worked',
  'works now',
  'working now',
  'solved',
  'fixed it',
  'gracias',
  'funcionó',
  'obrigado',
  'merci',
  'danke',
]

/**
 * True when a reply reads as a request for information rather than a fix.
 *
 * Layer one of three, and deliberately timid: its only job is to keep replies
 * that are PURELY questions out of the paid layer. Rejection needs all three
 * of a question mark, a request phrase, and no actionable marker anywhere in
 * the text. Anything that both asks and answers goes to the model instead,
 * which is the case that matters, staff very often do both at once.
 */
function looksLikeInfoRequest(text: string): boolean {
  const lower = text.toLowerCase()
  if (!lower.includes('?')) return false
  // Anything actionable, and this layer abstains, the model decides.
  if (FIX_MARKERS.some((marker) => lower.includes(marker))) return false
  return INFO_REQUEST_PHRASES.some((phrase) => lower.includes(phrase))
}

/**
 * True when the person who opened the thread replied AFTER this answer and
 * sounded satisfied. The strongest free signal available: no flag, no model
 * call, just the asker saying it worked.
 *
 * Name comparison is loose because JSON-LD renders the same person's display
 * name inconsistently across a page.
 */
function askerConfirmed(thread: ThreadContent, answer: ThreadAnswer): boolean {
  const asker = thread.author?.trim().toLowerCase()
  if (!asker) return false
  const answerTime = answer.created_at ? new Date(answer.created_at).getTime() : null

  return thread.answers.some((later) => {
    if (later === answer) return false
    if (later.author?.trim().toLowerCase() !== asker) return false
    if (answerTime !== null && later.created_at) {
      if (new Date(later.created_at).getTime() < answerTime) return false
    }
    const lower = later.text.toLowerCase()
    return CONFIRMATION_PHRASES.some((phrase) => lower.includes(phrase))
  })
}

interface PendingJudgement {
  candidate: SolvedCase
  answerText: string
}

/**
 * Layer three: one model call judging every remaining candidate at once.
 *
 * Batched deliberately. Six separate calls would cost six round trips and six
 * prompts to answer the same question; one call with a numbered list is a
 * single ~$0.0001 request for the whole run.
 *
 * Fails OPEN: if the call errors or returns junk, candidates are kept rather
 * than dropped. A noisy list is a worse product but an empty one is a broken
 * one, and the two free layers have already removed the obvious noise.
 */
async function judgeAnswers(
  pending: PendingJudgement[],
  apiKey: string,
): Promise<{ kept: SolvedCase[]; dropped: { url: string; reason: string }[] }> {
  if (!pending.length) return { kept: [], dropped: [] }

  const list = pending
    .map((p, i) => `${i + 1}. ${p.answerText.slice(0, 900).replace(/\s+/g, ' ')}`)
    .join('\n\n')

  const systemPrompt = `You are shown replies that platform staff or Community Experts posted on support threads. For each one, decide what it actually DOES.

- "resolves": it states a cause, gives a fix, a workaround, a setting to change, or a definitive answer (including "this is expected behavior" or "this is a known issue being worked on"). The reader could act on it.
- "requests_info": it mainly asks the user for more detail (screenshots, OS, browser, prompt used) without giving them anything to act on. A pleasantry plus questions is requests_info.

Judge only what the text does. Do not guess at context you cannot see.

Respond with ONLY a JSON object mapping each number to its verdict, like: { "1": "resolves", "2": "requests_info" }`

  try {
    const rawContent = await chatJSON({
      apiKey,
      systemPrompt,
      userContent: list,
      temperature: 0,
    })
    const parsed = JSON.parse(rawContent)

    const kept: SolvedCase[] = []
    const dropped: { url: string; reason: string }[] = []
    pending.forEach((p, i) => {
      const verdict = parsed[String(i + 1)]
      if (verdict === 'requests_info') {
        dropped.push({ url: p.candidate.url, reason: 'staff reply only requests information (model)' })
      } else {
        kept.push(p.candidate)
      }
    })
    return { kept, dropped }
  } catch {
    // Fail open, see the note above.
    return { kept: pending.map((p) => p.candidate), dropped: [] }
  }
}

/**
 * The reply worth considering from a thread, and how strong the claim is.
 *
 * `reason: null` means "a staff reply exists but nothing yet proves it
 * answers anything", that candidate still has to clear the info-request
 * heuristic and the model check before it can be shown.
 */
function bestAnswer(
  thread: ThreadContent,
): { proven: { answer: ThreadAnswer; reason: SolvedReason } | null; unproven: ThreadAnswer[] } {
  // Marked as the solution: nothing more to prove, and no model call spent.
  const accepted = thread.answers.find((a) => a.is_accepted)
  if (accepted) return { proven: { answer: accepted, reason: 'accepted_answer' }, unproven: [] }

  const staff = citableAuthorityAnswers(thread)
  if (!staff.length) return { proven: null, unproven: [] }

  // The asker coming back to say it worked is the strongest free evidence
  // there is, so it is checked across every staff reply.
  const confirmed = staff.find((a) => askerConfirmed(thread, a))
  if (confirmed) return { proven: { answer: confirmed, reason: 'confirmed_by_asker' }, unproven: [] }

  // EVERY remaining staff reply is a candidate, longest first.
  //
  // This used to pick the longest reply and judge only that one, on the theory
  // that a real answer runs longer than "can you send a screenshot". It does
  // not: a thread often carries a long, detailed request for information AND a
  // short real fix, and picking by length surfaced the request while the fix
  // never got a vote. Length now only orders the candidates; the model decides.
  const ranked = [...staff].sort((a, b) => b.text.length - a.text.length)
  return { proven: null, unproven: ranked.slice(0, MAX_CANDIDATES_PER_THREAD) }
}

/** Fetches candidate urls in order, keeping the ones that carry an answer. */
async function collectSolved(
  urls: { url: string; similarity: number }[],
  excludeUrl: string | null,
  deadline: number,
  out: SolvedCase[],
  pending: PendingJudgement[],
  dropped: { url: string; reason: string }[],
  errors: string[],
): Promise<void> {
  let fetches = 0
  for (const candidate of urls) {
    if (out.length >= ENOUGH_SOLVED * 2) return
    if (fetches >= MAX_THREAD_FETCHES) return
    if (Date.now() > deadline) return
    if (excludeUrl && candidate.url === excludeUrl) continue
    if (out.some((c) => c.url === candidate.url)) continue

    if (fetches > 0) await sleep(FETCH_DELAY_MS)
    fetches++

    let thread: ThreadContent
    try {
      thread = await fetchThread(candidate.url)
    } catch (err) {
      // A candidate that would not load is a dropped candidate, not an error
      // the operator needs to see in red. They did not ask for this thread;
      // it was a guess that did not pan out. It stays in `dropped`, which is
      // where the tuning information lives.
      dropped.push({
        url: candidate.url,
        reason: `could not fetch: ${err instanceof Error ? err.message : 'failed'}`,
      })
      continue
    }

    const { proven, unproven } = bestAnswer(thread)
    const shape = (answer: ThreadAnswer, reason: SolvedReason): SolvedCase => ({
      url: candidate.url,
      title: thread.title,
      board: parseTopicUrl(candidate.url)?.category ?? null,
      similarity: candidate.similarity,
      reason,
      answer: {
        text: answer.text,
        author: answer.author,
        badge: answer.badge ?? null,
        created_at: answer.created_at,
        images: answer.images,
      },
    })

    if (proven) {
      out.push(shape(proven.answer, proven.reason))
      continue
    }

    if (!unproven.length) {
      dropped.push({
        url: candidate.url,
        reason: thread.answers.length ? 'no accepted answer and no staff reply' : 'no replies at all',
      })
      continue
    }

    // Layer one, free: replies that are purely questions never reach the paid
    // layer. Applied per reply, so one info-request does not disqualify a
    // sibling reply that actually answers.
    const worthJudging = unproven.filter((a) => !looksLikeInfoRequest(a.text))
    if (!worthJudging.length) {
      dropped.push({
        url: candidate.url,
        reason: 'every staff reply only requests information (heuristic)',
      })
      continue
    }

    for (const answer of worthJudging) {
      pending.push({ candidate: shape(answer, 'verified_fix'), answerText: answer.text })
    }
  }
}

/**
 * Past threads that match the problem AND have an answer on them.
 *
 * `fullTextEmbedding` must be an embedding of full post text, see the
 * EMBEDDING SHAPE note at the top of this file.
 *
 * Never throws: a failed corpus search or a dead candidate url degrades into
 * an `errors` entry and a shorter list, because a walkthrough with no solved
 * cases is still useful and a 500 is not.
 */
export async function findSolvedCases(
  supabaseAdmin: SupabaseClient,
  userId: string,
  fullTextEmbedding: number[],
  opts: {
    /** The thread the operator is working, so it can't cite itself. */
    excludeUrl?: string | null
    /** Drives the live-discovery fallback when the corpus comes up short. */
    keywords?: string[]
    /** Enables the model check. Without it the two free layers still run, so
     *  the list is filtered but not judged. */
    apiKey?: string
  } = {},
): Promise<SolvedSearchResult> {
  const deadline = Date.now() + SEARCH_TIME_BUDGET_MS
  const cases: SolvedCase[] = []
  const pending: PendingJudgement[] = []
  const dropped: { url: string; reason: string }[] = []
  const errors: string[] = []
  let widened = false

  // ── Corpus first ────────────────────────────────────────────────────────
  try {
    const { data, error } = await supabaseAdmin.rpc('match_taxonomy_posts', {
      p_user_id: userId,
      p_embedding: fullTextEmbedding,
      p_match_count: CORPUS_CANDIDATE_LIMIT,
      p_min_similarity: CORPUS_MIN_SIMILARITY,
    })
    if (error) throw error
    const rows = ((data ?? []) as { url: string; similarity: number }[])
      .sort((a, b) => b.similarity - a.similarity)
      .map((r) => ({ url: r.url, similarity: r.similarity }))
    await collectSolved(rows, opts.excludeUrl ?? null, deadline, cases, pending, dropped, errors)
  } catch (err) {
    errors.push(`corpus: ${err instanceof Error ? err.message : 'search failed'}`)
  }

  // ── Live discovery fallback ─────────────────────────────────────────────
  // Only when the corpus genuinely came up short: it is slower, keyword-driven
  // rather than semantic, and every candidate costs another page fetch.
  if (cases.length + pending.length < ENOUGH_SOLVED && opts.keywords?.length && Date.now() < deadline) {
    widened = true
    try {
      const topics = await discoverTopics(opts.keywords, undefined, 8, 365, deadline)
      await collectSolved(
        topics.map((t) => ({ url: t.url, similarity: 0 })),
        opts.excludeUrl ?? null,
        deadline,
        cases,
        pending,
        dropped,
        errors,
      )
    } catch (err) {
      errors.push(`discovery: ${err instanceof Error ? err.message : 'failed'}`)
    }
  }

  // ── Layer three: one batched model call over what is left ───────────────
  // Several replies from the SAME thread can be in here, since each is judged
  // on its own merits. Only the first surviving reply per thread is shown:
  // candidates were queued longest-first, and a second card for a thread
  // already listed is repetition, not extra evidence.
  const judged = pending.length && opts.apiKey
    ? await judgeAnswers(pending, opts.apiKey)
    // No key: keep them rather than silently returning nothing. The two free
    // layers have already run, so this is filtered, just not judged.
    : { kept: pending.map((p) => p.candidate), dropped: [] as { url: string; reason: string }[] }

  const seen = new Set(cases.map((c) => c.url))
  for (const kept of judged.kept) {
    if (seen.has(kept.url)) continue
    seen.add(kept.url)
    cases.push(kept)
  }
  // Only report a thread as dropped when NO reply on it survived, otherwise
  // the dropped list implies a thread was rejected when it is on screen.
  for (const d of judged.dropped) {
    if (!seen.has(d.url)) dropped.push(d)
  }

  // Strongest evidence first, then by how well the post matched. A thread the
  // asker confirmed outranks one only a model vouched for.
  const RANK: Record<SolvedReason, number> = {
    accepted_answer: 0,
    confirmed_by_asker: 1,
    verified_fix: 2,
  }
  cases.sort((a, b) => {
    const byReason = RANK[a.reason] - RANK[b.reason]
    if (byReason !== 0) return byReason
    return b.similarity - a.similarity
  })

  return { cases, dropped, errors, widened }
}
