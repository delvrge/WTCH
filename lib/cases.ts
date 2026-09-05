// Cases screen, a table the user hands to their manager: title, link to the
// post, tags (problem or complaint), status. Purely a tracker: no reply text
// lives here, a genuine drafted or sent reply belongs on the Replies screen
// (verified_answers), keyed back to its case(s) via verified_answer_cases, a
// many-to-many join table (one reply routinely answers several posts; a case
// can pick up more than one reply over time). Built from two independent
// sources and merged into one shape:
//
//   - community_patterns: a candidate issue the system detected on its own.
//     source_title (the post's real title, verbatim, any language) -> title,
//     falling back to issue_summary on rows collected before that column
//     existed; tags -> tags.
//   - verified_answers: an issue the user personally answered and confirmed
//     worked. A reply with zero rows in verified_answer_cases (never linked
//     to any case) still gets its own case row here, title falls back to
//     question_summary, and to answer_text (the reply body) as the
//     last-resort when even that is missing. A reply that IS linked to one
//     or more cases only shows up under those, not also as a phantom case
//     of its own, which is what happened before this table existed.
//
// Link instability: the community platform renumbers/moves a post on merge, so
// the stored URL can go stale. The numeric topic id embedded in the URL
// (".../<slug>-<id>") is the stable identity, derived here, never stored
// server side, since this table's schema is out of scope for this screen.
// A case is never dropped for a bad/missing link; it is flagged 'recheck'.

import { boardLabel } from './format'
import type { Pattern, VerifiedAnswer, VerifiedAnswerCase } from './types'

export type CaseSource = 'pattern' | 'verified'
export type LinkStatus = 'ok' | 'recheck'

// Manual only, set by hand from the Cases tab, never inferred. A reply
// landing back on a thread after it's marked 'closed' can't reliably be told
// apart from a plain "thanks" from a genuine reopen, so this stays a decision
// the operator makes, not something the system guesses at.
export type CaseStatus =
  | 'awaiting_reply'
  | 'inactive'
  | 'escalated'
  | 'cm_replied_waiting'
  | 'cm_replied_solved'
  | 'user_replied'
  | 'closed'

export const CASE_STATUS_OPTIONS: { value: CaseStatus; label: string }[] = [
  { value: 'awaiting_reply', label: 'Awaiting reply' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'escalated', label: 'Escalated' },
  { value: 'user_replied', label: 'Replied' },
  { value: 'cm_replied_solved', label: 'CM replied · solved' },
  { value: 'closed', label: 'Solved' },
]

export const DEFAULT_CASE_STATUS: CaseStatus = 'awaiting_reply'

export interface CaseRow {
  /** `pattern:<id>` or `verified:<id>`, stable across re-fetches. */
  id: string
  /**
   * Short sequential tracking number, 1..N, assigned oldest case first over
   * the whole (unfiltered, unpaginated) case list, so a case keeps its
   * number as newer ones arrive, and filtering or paging never renumbers it.
   * Display only: not stored server side, and not the post's identity, that
   * is topicId.
   */
  caseNumber: number
  source: CaseSource
  /** Effective title, the manual override when set, else the derived one. */
  title: string
  /** Derived title (pattern issue_summary / linked-pattern title / question_summary / answer_text fallback), ignoring any manual override. */
  derivedTitle: string
  /** Hand-entered override from the Cases table, or null when none is on record. */
  manualTitle: string | null
  tags: string[]
  /** Fixed taxonomy (lib/topic-taxonomy.ts) off the source pattern directly ,
   *  null for a 'verified'-source row (verified_answers carries no
   *  topic/subtopic of its own; see category/subcategory in tags instead)
   *  and for a pattern collected before the fixed taxonomy replaced the
   *  self-organizing cluster system. Not the same thing as topicId below. */
  topic: string | null
  subtopic: string | null
  /** Effective URL for the post, the manual override when set, else the derived one. */
  url: string | null
  /** Derived URL (source_url / cluster-match fallback), ignoring any manual override. */
  derivedUrl: string | null
  /** Hand-entered override from the Cases table, or null when none is on record. */
  manualUrl: string | null
  /** Numeric topic id parsed from the effective URL, the stable identity for the post. */
  topicId: string | null
  linkStatus: LinkStatus
  /** ISO date this case is numbered/sorted/displayed by (thread date or
   *  verified date), the post's own age, not when it was added here. */
  caseDate: string | null
  /** ISO date the Time frame filter actually checks: when this row was last
   *  touched (last_seen/verified_at, falling back to created_at), when you
   *  started or last worked this case, not when the underlying post was
   *  made. A case pasted today about a months-old thread must still show up
   *  under "30 days"; filtering on caseDate (thread date) would hide it. */
  activityDate: string | null
  /** The row's OWN created_at, when it was first added to the Library.
   *  Never changes after insertion (unlike activityDate, bumped on every
   *  re-match) and unrelated to the underlying post's own age (unlike
   *  caseDate). This is what caseNumber is assigned from: it is the only one
   *  of the three that is guaranteed to only increase as cases are added, so
   *  a new case always gets appended past the highest existing number
   *  instead of landing in the middle and shifting everything after it. */
  addedAt: string | null
  status: CaseStatus
  /** case_status.updated_at, last time status/url/title was touched for this case. */
  statusUpdatedAt: string | null
  /** case_status.unread_since, set by the bell's poller (check-case-replies)
   *  when a new reply lands on this case; null once viewed. Drives the
   *  orange unread indicator, independent of `status`. */
  unreadSince: string | null
  /** Whether this case has a reply on the Replies screen yet, and whether any of them are verified. A 'verified'-source row IS itself a reply, so it always reads its own state here. */
  replyStatus: 'none' | 'unverified' | 'verified'
  /** The reply the chip deep-links to when there's more than one: a verified reply wins over a draft, ties broken oldest-first. Null when replyStatus is 'none'. */
  replyAnswerId: string | null
  /** How many replies are linked to this case, 1 for a 'verified'-source row (it's always exactly itself), 0 or more for a 'pattern'-source row. Drives the "×N" badge next to the Reply chip when more than one. */
  replyCount: number
  /** Who added this case, first part of their email, or "Matt" for cases
   *  from before shared access existed. */
  addedBy: string | null
}

// A case sits in 'awaiting_reply' with no update in this long is treated as
// gone quiet, the user isn't coming back, but it's still "open" so it
// shouldn't silently rot with the same color as a fresh ask. Purely a
// display computation: never stored, never changes actual status. Labelled
// "Inactive" in the UI.
export const INACTIVE_AWAITING_DAYS = 7

export function isInactiveAwaiting(row: Pick<CaseRow, 'status' | 'statusUpdatedAt'>): boolean {
  if (row.status !== 'awaiting_reply') return false
  if (!row.statusUpdatedAt) return false
  const ts = new Date(row.statusUpdatedAt).getTime()
  if (!Number.isFinite(ts)) return false
  return Date.now() - ts > INACTIVE_AWAITING_DAYS * 86400000
}

// ── time-frame control ──────────────────────────────────────────────────

export const DEFAULT_CASE_WINDOW_DAYS = 30

export const CASE_WINDOW_OPTIONS: { days: number; label: string }[] = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '365 days' },
  { days: 0, label: 'All' },
]

// A case with no known date can never be asserted to fall inside a window,
// so it only ever appears under "All", same rule the Library board uses.
export function withinCaseWindow(date: string | null, days: number): boolean {
  if (days === 0) return true
  if (!date) return false
  const ts = new Date(date).getTime()
  if (!Number.isFinite(ts)) return false
  return Date.now() - ts <= days * 86400000
}

// ── topic id / link derivation ──────────────────────────────────────────

// COMMUNITY_HOST topic URLs end in "<slug>-<numericId>". Kept as a
// local, self-contained parse (rather than importing the edge-function
// helper) so this screen has no dependency outside its own files.
export function deriveTopicId(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '')
    const slug = path.split('/').pop() || ''
    const match = slug.match(/-(\d+)$/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

export function latestPatternUrl(p: Pattern): string | null {
  if (p.source_url) return p.source_url
  if (p.source_urls?.length) return p.source_urls[p.source_urls.length - 1]
  return null
}

// ── row builders ─────────────────────────────────────────────────────────

/** A case's linked replies reduced to what the chip needs: which one to
 * show/link to (verified beats draft; ties go to whichever is earlier in
 * the input list, callers pass replies oldest-first), the aggregate status,
 * and the total count for the "×N" badge. */
function summarizeReplies(
  replies: { id: string; verified: boolean }[] | undefined,
): { status: 'none' | 'unverified' | 'verified'; answerId: string | null; count: number } {
  if (!replies?.length) return { status: 'none', answerId: null, count: 0 }
  const primary = replies.find(r => r.verified) ?? replies[0]
  return { status: primary.verified ? 'verified' : 'unverified', answerId: primary.id, count: replies.length }
}

function patternToCase(
  p: Pattern,
  statusMap: Map<string, CaseStatus>,
  urlOverrideMap: Map<string, string>,
  titleOverrideMap: Map<string, string>,
  statusUpdatedAtMap: Map<string, string>,
  unreadSinceMap: Map<string, string>,
  repliesByPatternId: Map<string, { id: string; verified: boolean }[]>,
): CaseRow {
  const derivedUrl = latestPatternUrl(p)
  const id = `pattern:${p.id}`
  const manualUrl = urlOverrideMap.get(id) ?? null
  const url = manualUrl || derivedUrl
  const topicId = deriveTopicId(url)
  const tags = p.tags?.length ? p.tags : p.surface ? [p.surface] : []
  // The post's own title, exactly as it was written and in whatever language
  // it was written in, that is what makes a row recognisable as the case
  // being tracked. issue_summary is the model's generalized English
  // abstraction of it, kept only as the fallback for rows collected before
  // source_title existed.
  const derivedTitle = p.source_title?.trim() || p.issue_summary
  const manualTitle = titleOverrideMap.get(id) ?? null
  const replySummary = summarizeReplies(repliesByPatternId.get(p.id))
  return {
    id,
    caseNumber: 0, // assigned by buildCases once the full list is known
    source: 'pattern',
    title: manualTitle || derivedTitle,
    derivedTitle,
    manualTitle,
    tags,
    topic: p.topic ?? null,
    subtopic: p.subtopic ?? null,
    url,
    derivedUrl,
    manualUrl,
    topicId,
    linkStatus: url && topicId ? 'ok' : 'recheck',
    caseDate: p.thread_created_at || p.last_seen || p.created_at || null,
    activityDate: p.last_seen || p.created_at || null,
    addedAt: p.created_at || null,
    status: statusMap.get(id) ?? DEFAULT_CASE_STATUS,
    statusUpdatedAt: statusUpdatedAtMap.get(id) ?? null,
    unreadSince: unreadSinceMap.get(id) ?? null,
    replyStatus: replySummary.status,
    replyAnswerId: replySummary.answerId,
    replyCount: replySummary.count,
    addedBy: p.added_by ?? null,
  }
}

function verifiedToCase(
  v: VerifiedAnswer,
  statusMap: Map<string, CaseStatus>,
  urlOverrideMap: Map<string, string>,
  titleOverrideMap: Map<string, string>,
  statusUpdatedAtMap: Map<string, string>,
  unreadSinceMap: Map<string, string>,
): CaseRow {
  const tags = [v.category, v.subcategory].filter((t): t is string => Boolean(t))
  const id = `verified:${v.id}`
  const derivedUrl = v.source_url || null
  const manualUrl = urlOverrideMap.get(id) ?? null
  const url = manualUrl || derivedUrl
  // Title resolution, never the answer body when a real title is available:
  // 1) question_summary (a summary of the post, not the reply); 2) answer_text,
  // only when literally nothing else is on record.
  const derivedTitle = (v.question_summary?.trim() ? v.question_summary : null) || v.answer_text
  const manualTitle = titleOverrideMap.get(id) ?? null
  return {
    id,
    caseNumber: 0, // assigned by buildCases once the full list is known
    source: 'verified',
    title: manualTitle || derivedTitle,
    derivedTitle,
    manualTitle,
    tags,
    topic: null,
    subtopic: null,
    url,
    derivedUrl,
    manualUrl,
    topicId: deriveTopicId(url),
    linkStatus: url ? 'ok' : 'recheck',
    caseDate: v.verified_at || v.created_at || null,
    activityDate: v.verified_at || v.created_at || null,
    addedAt: v.created_at || null,
    status: statusMap.get(id) ?? DEFAULT_CASE_STATUS,
    statusUpdatedAt: statusUpdatedAtMap.get(id) ?? null,
    unreadSince: unreadSinceMap.get(id) ?? null,
    replyStatus: v.verified ? 'verified' : 'unverified',
    replyAnswerId: v.id,
    replyCount: 1,
    addedBy: v.added_by ?? null,
  }
}

/**
 * Merge patterns and verified answers into one case list.
 * Rejected patterns (review_status: 'rejected') are excluded, they were
 * marked by the user as not real issues, so they do not belong in a report
 * handed to a manager. Dismissed cases (case_status.dismissed) are excluded
 * the same way, not this CM's case to track, regardless of source.
 */
export function buildCases(
  patterns: Pattern[],
  verified: VerifiedAnswer[],
  statuses: {
    case_id: string
    status: CaseStatus
    dismissed?: boolean
    url?: string | null
    title?: string | null
    updated_at?: string | null
    unread_since?: string | null
  }[] = [],
  links: Pick<VerifiedAnswerCase, 'answer_id' | 'pattern_id'>[] = [],
): CaseRow[] {
  const statusMap = new Map(statuses.map(s => [s.case_id, s.status] as const))
  const dismissedIds = new Set(statuses.filter(s => s.dismissed).map(s => s.case_id))
  const urlOverrideMap = new Map(
    statuses.filter((s): s is typeof s & { url: string } => Boolean(s.url)).map(s => [s.case_id, s.url] as const),
  )
  const titleOverrideMap = new Map(
    statuses
      .filter((s): s is typeof s & { title: string } => Boolean(s.title))
      .map(s => [s.case_id, s.title] as const),
  )
  const statusUpdatedAtMap = new Map(
    statuses
      .filter((s): s is typeof s & { updated_at: string } => Boolean(s.updated_at))
      .map(s => [s.case_id, s.updated_at] as const),
  )
  const unreadSinceMap = new Map(
    statuses
      .filter((s): s is typeof s & { unread_since: string } => Boolean(s.unread_since))
      .map(s => [s.case_id, s.unread_since] as const),
  )

  // Group replies by the case(s) verified_answer_cases links them to.
  // Sorted oldest-verified-first before grouping, so summarizeReplies'
  // "ties go to whichever is earlier" tie-break is deterministic rather
  // than depending on the order the query happened to return rows in.
  const answersById = new Map(verified.map(v => [v.id, v] as const))
  const sortedLinks = [...links].sort((a, b) => {
    const at = answersById.get(a.answer_id)?.verified_at || ''
    const bt = answersById.get(b.answer_id)?.verified_at || ''
    return at.localeCompare(bt)
  })
  const repliesByPatternId = new Map<string, { id: string; verified: boolean }[]>()
  const linkedAnswerIds = new Set<string>()
  for (const link of sortedLinks) {
    const answer = answersById.get(link.answer_id)
    if (!answer) continue // stale read, the answer or the link since disappeared
    linkedAnswerIds.add(answer.id)
    const entry = { id: answer.id, verified: answer.verified }
    const list = repliesByPatternId.get(link.pattern_id)
    if (list) list.push(entry)
    else repliesByPatternId.set(link.pattern_id, [entry])
  }

  const patternCases = patterns
    .filter(p => p.review_status !== 'rejected' && !dismissedIds.has(`pattern:${p.id}`))
    .map(p =>
      patternToCase(p, statusMap, urlOverrideMap, titleOverrideMap, statusUpdatedAtMap, unreadSinceMap, repliesByPatternId),
    )
  // A reply linked to one or more cases only shows up under those; only a
  // fully unlinked reply gets a case row of its own.
  const verifiedCases = verified
    .filter(v => !linkedAnswerIds.has(v.id) && !dismissedIds.has(`verified:${v.id}`))
    .map(v =>
      verifiedToCase(v, statusMap, urlOverrideMap, titleOverrideMap, statusUpdatedAtMap, unreadSinceMap),
    )

  const all = [...verifiedCases, ...patternCases]

  // Number oldest-added-first, by addedAt (row insertion time), NOT
  // caseDate (the underlying post's own age). caseDate is arbitrary
  // relative to when a case actually got added: a case pasted today about
  // an old thread would land in the MIDDLE of a caseDate-sorted sequence
  // and shift every later case's number, defeating the "a case keeps its
  // number forever" promise this numbering exists for. addedAt only ever
  // increases as rows are inserted, so a new case always lands past every
  // existing number instead. Ties (and unset addedAt, which sorts last)
  // fall back to id so the numbering is deterministic across reloads.
  const byOldest = [...all].sort((a, b) => {
    const at = a.addedAt ? new Date(a.addedAt).getTime() : Number.POSITIVE_INFINITY
    const bt = b.addedAt ? new Date(b.addedAt).getTime() : Number.POSITIVE_INFINITY
    if (at !== bt) return at - bt
    return a.id.localeCompare(b.id)
  })
  byOldest.forEach((row, index) => {
    row.caseNumber = index + 1
  })

  // Displayed newest-added-first (addedAt, same basis as caseNumber above ,
  // keeps the visible order and the # column agreeing with each other,
  // highest number at the top), undated last.
  return all.sort((a, b) => {
    if (!a.addedAt && !b.addedAt) return 0
    if (!a.addedAt) return 1
    if (!b.addedAt) return -1
    return new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime()
  })
}

// ── CSV export ───────────────────────────────────────────────────────────

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

/** MM/DD/YYYY, plain text, not a full ISO timestamp, so it doesn't get
 * reformatted into a datetime-with-offset when the CSV opens in Sheets. */
function caseDateLabel(value: string | null): string {
  if (!value) return ''
  const ts = new Date(value).getTime()
  if (!Number.isFinite(ts)) return ''
  const [y, m, d] = new Date(ts).toISOString().slice(0, 10).split('-')
  return `${m}/${d}/${y}`
}

export function casesToCsv(rows: CaseRow[]): string {
  const header = ['#', 'Title', 'Link', 'Category', 'Topic ID', 'Link status', 'Status', 'Reply', 'Tags', 'Topic', 'Subtopic', 'Date']
  const replyLabel: Record<CaseRow['replyStatus'], string> = {
    none: 'no reply yet',
    unverified: 'unverified draft',
    verified: 'verified',
  }
  const lines = [header.map(csvCell).join(',')]
  for (const row of rows) {
    lines.push(
      [
        String(row.caseNumber),
        row.title,
        row.url || '',
        boardLabel(row.url) || '',
        row.topicId || '',
        row.linkStatus === 'recheck' ? 'needs re-check' : 'ok',
        CASE_STATUS_OPTIONS.find(o => o.value === row.status)?.label || row.status,
        replyLabel[row.replyStatus],
        row.tags.join('; '),
        row.topic || '',
        row.subtopic || '',
        caseDateLabel(row.caseDate),
      ]
        .map(csvCell)
        .join(','),
    )
  }
  // CRLF: the common expectation for CSV consumed by spreadsheet apps.
  return lines.join('\r\n')
}

/** Browser-only: builds a Blob, downloads it via an object URL, revokes it after. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
