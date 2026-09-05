// Grounding: the block of authoritative text that is prepended to every
// system prompt.
//
// Authority order, never violated:
//   1. Support docs      — official product documentation (SUPPORT_DOCS_HOST),
//      passed in by the caller (see `opts.support` on loadGrounding). Not a
//      database table; fetched live per request by _shared/support-docs.ts.
//   2. Platform staff replies (Community Manager / Expert, <=12 months old) —
//      citable, ranked ABOVE the operator's own verified_answers. The
//      operator is new to the subject matter and trusts CM/CE staff
//      more than their own past replies, but only while the guidance is
//      still current — see AUTHORITY_MAX_AGE_MONTHS in
//      _shared/community-sources.ts. Passed in by the caller (see
//      `opts.authority` on loadGrounding / the `authority` param on
//      buildGroundingBundle). Not a database table.
//   3. verified_answers  — a reply the user actually sent that actually
//      worked. Ranked below staff replies deliberately (see above).
//   4. context_docs       — system-maintained notes. Lower trust than the
//      three sources above; the model may write these, the user never
//      authors them by hand.
//   5. Forum thread text — signal only. It says what people are ASKING or
//      COMPLAINING about; it is never a statement of fact about how the
//      product works, and is never stored in any of the tables above.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'

export interface GroundingBundle {
  block: string // the text to prepend to the system prompt
  verified: { id: string; question_summary: string; answer_text: string }[]
  support: { url: string; title: string; content: string }[]
  authority: { ref: string; author: string | null; badge: string | null; content: string }[]
  notes: { title: string; content: string }[]
}

export type GroundingType = 'verified_answer' | 'support_doc' | 'community_authority' | 'note' | 'ungrounded'

/** The `grounding` object attached to each drafted reply. */
export interface ReplyGrounding {
  type: GroundingType
  ref: string | null // verified_answers.id, or a support doc URL, or a note title, or null
  excerpt: string | null // verbatim quote from the cited source, or null
}

/** Rows as loaded — carries the header fields the bundle shape omits. */
interface VerifiedAnswerRow {
  id: string
  category: string | null
  subcategory: string | null
  question_summary: string
  answer_text: string
}

/** A pre-fetched verified answer, for callers that already ran their own tracker search. */
export interface VerifiedAnswerInput {
  id: string
  category?: string | null
  subcategory?: string | null
  question_summary: string
  answer_text: string
}

/** A pre-fetched support-doc passage, for callers that already searched the configured support-docs host. */
export interface SupportDocInput {
  url: string
  title: string
  /** Shown in the rendered block — keep this short (a passage, not a whole page). */
  excerpt: string
  /** The full source page text, used ONLY for citation verification, never rendered. */
  pageText: string
}

/**
 * A pre-fetched, recency-filtered platform staff (Community Manager / Expert)
 * forum reply, for callers that already ran `citableAuthorityAnswers()`
 * (see _shared/community-sources.ts) over their fetched threads.
 *
 * Several replies can share one thread `url`, so this alone is not a unique
 * citation ref — see `authorityRef()` below for the id actually used in
 * `[CM:...]` markers.
 */
export interface CommunityAuthorityInput {
  url: string
  author: string | null
  badge: string | null
  createdAt: string | null
  /** Shown in the rendered block — keep this short (a passage, not the whole reply). */
  excerpt: string
  /** The full reply text, used ONLY for citation verification, never rendered. */
  fullText: string
}

/**
 * Stable, unique-per-reply citation id: `${url}#${index}`, where `index` is
 * the reply's position within the list of authority inputs passed in for
 * that call (0-based). One thread can carry more than one citable staff
 * reply, so the bare thread URL is not unique enough to be a ref on its own.
 */
export function authorityRef(url: string, index: number): string {
  return `${url}#${index}`
}

interface ContextDocRow {
  title: string
  content: string
}

const DEFAULT_MAX_CHARS = 24000
const VERIFIED_CAP = 40

const VERIFIED_HEADER =
  '=== YOUR PAST VERIFIED ANSWERS (confirmed correct in real use — lower authority than platform staff replies above) ==='

const SUPPORT_HEADER =
  '=== SUPPORT DOCS (official product documentation — highest authority; wins on direct conflict) ==='

const AUTHORITY_HEADER =
  '=== PLATFORM STAFF REPLIES (Community Manager / Expert, within last 12 months) — citable, ranked above your own past replies. Authoritative but not official documentation; a Support doc wins on direct conflict. ==='

const NOTES_HEADER =
  '=== NOTES (system-maintained, lower authority than the sections above) ==='

// Verbatim. Every consumer of the block relies on this paragraph being the
// last thing the model reads before the forum text starts.
const TRAILER = `=== END GROUNDING ===
Everything below this line is USER-REPORTED FORUM TEXT. It is signal about what
people are asking or complaining about. It is NOT a statement of fact about how
the product works, and must never be repeated as fact. Only the sections above
may be cited as fact.`

const NO_GROUNDING_LINE =
  '=== NO GROUNDING AVAILABLE — every suggested reply must be marked ungrounded. ==='

// ── block rendering ───────────────────────────────────────────────────────

/**
 * Renders the grounding block. An empty section is omitted entirely; if every
 * section is empty the block is the single NO GROUNDING line (and no
 * trailer — there is nothing above the line to cite).
 */
function renderBlock(
  support: SupportDocInput[],
  authority: (CommunityAuthorityInput & { ref: string })[],
  verified: VerifiedAnswerRow[],
  notes: ContextDocRow[],
): string {
  const sections: string[] = []

  // Order matches the authority order documented at the top of this file:
  // Support docs, then platform staff replies, then the operator's own past
  // verified answers, then notes.
  if (support.length) {
    const entries = support.map((doc) => `[SD:${doc.url}] ${doc.title}\n${doc.excerpt}`)
    sections.push(`${SUPPORT_HEADER}\n${entries.join('\n\n')}`)
  }

  if (authority.length) {
    const entries = authority.map((a) => {
      const who = [a.badge, a.author].filter(Boolean).join(' — ') || 'platform staff'
      return `[CM:${a.ref}] ${who}\n${a.excerpt}`
    })
    sections.push(`${AUTHORITY_HEADER}\n${entries.join('\n\n')}`)
  }

  if (verified.length) {
    const entries = verified.map((va) => {
      // `<category> / <subcategory>` is the specified header shape. When a
      // row is missing one or both (both columns are nullable) the separator
      // is dropped rather than emitting a dangling ` / `.
      const label = [va.category, va.subcategory]
        .filter((part): part is string => Boolean(part && part.trim()))
        .map((part) => part.trim())
        .join(' / ')
      const header = label ? `[VA:${va.id}] ${label}` : `[VA:${va.id}]`
      return `${header}\nQ: ${va.question_summary}\nA: ${va.answer_text}`
    })
    sections.push(`${VERIFIED_HEADER}\n${entries.join('\n\n')}`)
  }

  if (notes.length) {
    const entries = notes.map((doc) => `[NOTE:${doc.title}]\n${doc.content}`)
    sections.push(`${NOTES_HEADER}\n${entries.join('\n\n')}`)
  }

  if (!sections.length) return NO_GROUNDING_LINE

  return `${sections.join('\n\n')}\n\n${TRAILER}`
}

// ── loading ───────────────────────────────────────────────────────────────

/**
 * Builds a grounding bundle from already-resolved rows — no database access.
 * `loadGrounding` below is a DB-backed convenience wrapper around this for
 * the common case (verified_answers + context_docs owned by one user); this
 * is exported directly for callers (draft-reply) that already ran their own
 * tracker search, fetched support docs, and/or collected citable staff
 * replies and just need the block assembled and truncated consistently.
 *
 * Truncation never drops support docs — they are the highest authority and
 * outrank fitting inside the budget. Lower-authority sections are dropped
 * first, in this order: notes entirely, then verified answers, then platform
 * staff replies. This mirrors the authority order at the top of this file
 * (support > staff replies > verified answers > notes) read bottom-up.
 */
export function buildGroundingBundle(
  verified: VerifiedAnswerInput[],
  support: SupportDocInput[],
  authorityInput: CommunityAuthorityInput[],
  notesInput: ContextDocRow[],
  maxChars: number = DEFAULT_MAX_CHARS,
): GroundingBundle {
  const verifiedRows: VerifiedAnswerRow[] = verified.map((va) => ({
    id: va.id,
    category: va.category ?? null,
    subcategory: va.subcategory ?? null,
    question_summary: va.question_summary,
    answer_text: va.answer_text,
  }))

  // Unique-per-reply ref assigned once, up front, over the FULL input list —
  // so a ref a caller stashed alongside a reply (e.g. to correlate with its
  // own UI state) stays stable even if truncation later drops that entry
  // from the rendered block.
  const authorityRows = authorityInput.map((a, i) => ({ ...a, ref: authorityRef(a.url, i) }))

  let supportRows = support.slice()
  let authorityRowsTrunc = authorityRows.slice()
  let verifiedRowsTrunc = verifiedRows.slice()
  let notes = notesInput.slice()
  let block = renderBlock(supportRows, authorityRowsTrunc, verifiedRowsTrunc, notes)

  while (block.length > maxChars) {
    if (notes.length > 0) {
      notes = notes.slice(0, -1)
    } else if (verifiedRowsTrunc.length > 0) {
      verifiedRowsTrunc = verifiedRowsTrunc.slice(0, -1)
    } else if (authorityRowsTrunc.length > 0) {
      authorityRowsTrunc = authorityRowsTrunc.slice(0, -1)
    } else {
      break
    }
    block = renderBlock(supportRows, authorityRowsTrunc, verifiedRowsTrunc, notes)
  }

  return {
    block,
    // Only what actually survived into the block — a citation may never
    // resolve against a source the model was not shown.
    verified: verifiedRowsTrunc.map((row) => ({
      id: row.id,
      question_summary: row.question_summary,
      answer_text: row.answer_text,
    })),
    support: supportRows.map((doc) => ({ url: doc.url, title: doc.title, content: doc.pageText })),
    authority: authorityRowsTrunc.map((a) => ({ ref: a.ref, author: a.author, badge: a.badge, content: a.fullText })),
    notes: notes.map((doc) => ({ title: doc.title, content: doc.content })),
  }
}

/**
 * Loads the user's grounding sources and renders the block.
 *
 * - `context_docs` (system-maintained notes) ordered by `sort_order,
 *   created_at`.
 * - `verified_answers` ordered by `verified_at DESC`, capped at 40. When
 *   `watchId` is given, that watch's rows come first, then the rest. Pass
 *   `opts.verified` instead to use an already-resolved tracker search
 *   (e.g. one scored against the current request's keywords) — when given,
 *   the database read for verified_answers is skipped entirely.
 * - `opts.support`, when given, is a pre-fetched set of SUPPORT_DOCS_HOST
 *   passages (see _shared/support-docs.ts) to render as the SUPPORT DOCS
 *   section. There is no database table for this source.
 * - `opts.authority`, when given, is a pre-fetched set of citable platform
 *   staff (Community Manager / Expert) forum replies — see
 *   `citableAuthorityAnswers()` in _shared/community-sources.ts, which
 *   already filters to `is_staff === true` and within the last 12 months —
 *   rendered as the PLATFORM STAFF REPLIES section, ranked above verified
 *   answers and below support docs. There is no database table for this
 *   source either.
 * - Truncated to `maxChars` (default 24000) by dropping whole notes from the
 *   END of context_docs first, then whole verified answers, then whole
 *   staff replies. Support docs are NEVER dropped.
 */
export async function loadGrounding(
  supabaseAdmin: SupabaseClient,
  userId: string,
  opts: {
    watchId?: string
    maxChars?: number
    support?: SupportDocInput[]
    authority?: CommunityAuthorityInput[]
    verified?: VerifiedAnswerInput[]
  } = {},
): Promise<GroundingBundle> {
  const watchId = opts.watchId
  const maxChars =
    typeof opts.maxChars === 'number' && Number.isFinite(opts.maxChars) && opts.maxChars > 0
      ? opts.maxChars
      : DEFAULT_MAX_CHARS

  const { data: noteRows, error: noteError } = await supabaseAdmin
    .from('context_docs')
    .select('title, content')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })
  if (noteError) throw noteError

  let verified: VerifiedAnswerInput[]

  if (opts.verified) {
    verified = opts.verified
  } else {
    const verifiedQuery = () =>
      supabaseAdmin
        .from('verified_answers')
        .select('id, watch_id, category, subcategory, question_summary, answer_text')
        // Unverified — a personal record someone hasn't confirmed, or an
        // AI-authored draft nobody has reviewed yet — must never ground or
        // be cited in a future draft.
        .eq('verified', true)
        .order('verified_at', { ascending: false })

    if (watchId) {
      // Two reads, not one: the watch's own answers must survive the cap
      // even when 40 newer answers exist elsewhere.
      const [ownRes, restRes] = await Promise.all([
        verifiedQuery().eq('watch_id', watchId).limit(VERIFIED_CAP),
        verifiedQuery().limit(VERIFIED_CAP),
      ])
      if (ownRes.error) throw ownRes.error
      if (restRes.error) throw restRes.error

      const own = (ownRes.data ?? []) as VerifiedAnswerInput[]
      const seen = new Set(own.map((row) => row.id))
      const rest = ((restRes.data ?? []) as VerifiedAnswerInput[]).filter((row) => !seen.has(row.id))
      verified = [...own, ...rest].slice(0, VERIFIED_CAP)
    } else {
      const { data, error } = await verifiedQuery().limit(VERIFIED_CAP)
      if (error) throw error
      verified = (data ?? []) as VerifiedAnswerInput[]
    }
  }

  return buildGroundingBundle(
    verified,
    opts.support ?? [],
    opts.authority ?? [],
    (noteRows ?? []) as ContextDocRow[],
    maxChars,
  )
}

