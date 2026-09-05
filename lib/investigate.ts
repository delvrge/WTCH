// Investigation walkthrough screen, types only.
//
// Mirrors the `investigate` edge function's response contract
// (supabase/functions/investigate/index.ts). Kept out of lib/dashboard.ts on
// purpose: this is a different output with a different audience. The draft
// is customer-facing text to send; this is an internal plan for the operator
// to work the case. They share a retrieval layer and nothing else.

import type { PatternHit } from './dashboard'

/** Whether the case can be answered and closed now, or needs the operator to
 *  gather specifics first. Drives the whole shape of the walkthrough: a
 *  `closeable` case never carries questions. */
export type CaseKind = 'closeable' | 'needs_investigation'

export interface InvestigationStep {
  text: string
  /** `[C:<pattern id>]` / `[V:<verified answer id>]` / `[T:<trusted reply
   *  id>]` / `[S:<solved thread url>]` / `[SD:<support doc url>]`, already
   *  verified server-side against what was actually retrieved, or null for
   *  ordinary procedure with no past case behind it. */
  cite: string | null
}

export interface InvestigationQuestion {
  text: string
  /** What the answer tells the operator. Empty when the model gave none. */
  why: string
}

export interface Investigation {
  case_kind: CaseKind
  one_liner: string
  confidence: 'high' | 'medium' | 'low'
  steps: InvestigationStep[]
  /** Always empty for `closeable` cases, enforced by the edge function. */
  questions_to_ask: InvestigationQuestion[]
  watch_out: string[]
}

export interface VerifiedHit {
  id: string
  question_summary: string
  answer_text: string
  source_url: string | null
  similarity: number
}

/** A real reply from a trusted Community Manager/Expert, backfilled
 *  ahead of time into trusted_replies rather than found live via the
 *  solved-threads search. Not the operator's own reply. */
export interface TrustedHit {
  id: string
  question_summary: string
  answer_text: string
  source_url: string
  source_author: string
  is_accepted: boolean
  similarity: number
}

/** An official support documentation passage, keyword-matched. */
export interface SupportDocHit {
  url: string
  title: string
  excerpt: string
}

/** Why a past thread counts as answered, strongest first. A plain "a CM
 *  replied" tier deliberately does not exist: staff reply constantly just to
 *  ask for a screenshot, so a reply must be marked as the solution, confirmed
 *  by the asker, or judged to resolve the issue before it is shown at all.
 *  Mirrors SolvedReason in supabase/functions/_shared/solved-cases.ts. */
export type SolvedReason = 'accepted_answer' | 'confirmed_by_asker' | 'verified_fix'

/** A past community thread that matches the problem AND already has an answer
 *  on it. Usually the most valuable section on screen: the case the operator
 *  is working is typically still unanswered. */
export interface SolvedCase {
  url: string
  title: string
  board: string | null
  similarity: number
  reason: SolvedReason
  answer: {
    text: string
    author: string | null
    badge: string | null
    created_at: string | null
    /** Screenshot/attachment URLs pulled from the answer's real HTML body. */
    images: string[]
  }
}

export interface InvestigateRequest {
  text: string
  /** Set by a Library "Rerun", the case is already in community_patterns,
   *  so auto-collect must not touch it again. Requires pattern_id to still
   *  get a usable auto_collected (and therefore Tags) back. */
  skip_auto_collect?: boolean
  pattern_id?: string
}

export interface InvestigateResponse {
  success: true
  investigation: Investigation
  /** The abstracted description the search actually ran on. Worth showing:
   *  when a walkthrough looks off, this is usually why. */
  normalized_issue: string
  similar: PatternHit[]
  verified: VerifiedHit[]
  trusted: TrustedHit[]
  solved: SolvedCase[]
  /** Official support documentation passages, keyword-matched off the same
   *  post title/thread tokens used for the solved-thread search. */
  support: SupportDocHit[]
  /** Set when a link was pasted and the thread was fetched, so the operator
   *  can see the tool read the real post rather than just their one line. */
  source: { url: string; title: string } | null
  /** The pasted case, auto-collected into the Library on every call. `url` is
   *  null when no thread was fetched and the case was collected from the
   *  pasted text itself, flagged for the operator to paste the real link in
   *  by hand later, never dropped. Null only when the collect itself failed
   *  (see `errors`). */
  auto_collected: { url: string | null; pattern_id: string; action: 'inserted' | 'updated' | 'skipped' } | null
  /** Fetched then rejected, with the reason. Not rendered today; kept in the
   *  contract because it is what makes the solved filter debuggable. */
  solved_dropped: { url: string; reason: string }[]
  errors: string[]
}

/** Resolves a step's `[C:id]` / `[V:id]` / `[S:url]` / `[SD:url]` ref to
 *  something displayable. Returns null when there is no citation to show. */
export function resolveCite(
  cite: string | null,
  similar: PatternHit[],
  verified: VerifiedHit[],
  solved: SolvedCase[] = [],
  support: SupportDocHit[] = [],
  trusted: TrustedHit[] = [],
): { label: string; url: string | null } | null {
  if (!cite) return null
  if (cite.startsWith('[SD:')) {
    const id = cite.slice(4, -1)
    const hit = support.find((d) => d.url === id)
    return hit ? { label: hit.title, url: hit.url } : null
  }
  const id = cite.slice(3, -1)
  if (cite.startsWith('[S:')) {
    // Solved threads are keyed by url, not an id, they are community
    // threads, not rows we own.
    const hit = solved.find((c) => c.url === id)
    return hit ? { label: hit.title, url: hit.url } : null
  }
  if (cite.startsWith('[C:')) {
    const hit = similar.find((p) => p.id === id)
    if (!hit) return null
    return {
      label: hit.source_title || hit.issue_summary,
      url: hit.source_urls[0] ?? null,
    }
  }
  if (cite.startsWith('[V:')) {
    const hit = verified.find((v) => v.id === id)
    if (!hit) return null
    return { label: hit.question_summary, url: hit.source_url }
  }
  if (cite.startsWith('[T:')) {
    const hit = trusted.find((t) => t.id === id)
    if (!hit) return null
    return { label: hit.question_summary, url: hit.source_url }
  }
  return null
}
