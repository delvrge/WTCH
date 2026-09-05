'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import CaseTable from '@/components/CaseTable'
import CaseConversationModal from '@/components/CaseConversationModal'
import KbdHint from '@/components/KbdHint'
import { toast, Toaster } from '@/components/Toast'
import { callWatchFn } from '@/lib/functions'
import { errorMessage, isJwtClockSkewError, supabaseClient } from '@/lib/supabase'
import { boardCategoryFromUrl, isoDate } from '@/lib/format'
import { useCmdK } from '@/lib/useCmdK'
import {
  buildCases,
  casesToCsv,
  deriveTopicId,
  downloadCsv,
  CASE_STATUS_OPTIONS,
  CASE_WINDOW_OPTIONS,
  DEFAULT_CASE_WINDOW_DAYS,
  withinCaseWindow,
  type CaseRow,
  type CaseStatus,
} from '@/lib/cases'
import { type Pattern, type VerifiedAnswer } from '@/lib/types'

const PAGE_SIZES = [10, 20, 50, 100]
const ELLIPSIS = -1

const CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: 'bug-reports', label: 'Bug Reports' },
  { value: 'feature-requests', label: 'Feature Requests' },
  { value: 'questions', label: 'Questions' },
]

// Windowed page list: always the first and last page, plus a couple either
// side of the current one, with gaps elided. Rendering every page number
// would defeat the point of paginating once the case count grows.
function buildPageNumbers(current: number, total: number): number[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const pages = new Set<number>([1, total, current])
  if (current - 1 > 1) pages.add(current - 1)
  if (current + 1 < total) pages.add(current + 1)
  const sorted = [...pages].sort((a, b) => a - b)
  const out: number[] = []
  let previous = 0
  for (const n of sorted) {
    if (previous && n - previous > 1) out.push(ELLIPSIS)
    out.push(n)
    previous = n
  }
  return out
}

// The library browses what the system has already collected — community_watches
// / watch_id stay in the schema as an internal grouping (community_patterns
// references them) but nothing on this screen asks the user to name, pick, or
// configure one. Patterns are read across every watch at once, as one flat,
// already-sorted collection.
//
// This is just Cases now — the Patterns/cluster browser that used to live
// above it described issues without letting the operator act on them, and
// duplicated data Cases already shows, so it was removed (see the comment
// further down where it used to render).

export default function LibraryPage() {
  const [cases, setCases] = useState<CaseRow[]>([])
  const [casesLoading, setCasesLoading] = useState(true)
  const [casesError, setCasesError] = useState('')
  const [caseWindowDays, setCaseWindowDays] = useState(DEFAULT_CASE_WINDOW_DAYS)
  const [caseStatusFilter, setCaseStatusFilter] = useState<CaseStatus | 'all'>('all')
  const [caseCategoryFilter, setCaseCategoryFilter] = useState<string | 'all'>('all')
  const [caseQuery, setCaseQuery] = useState('')
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0])
  const [page, setPage] = useState(1)
  const [highlightCaseId, setHighlightCaseId] = useState<string | null>(null)
  const caseSearchRef = useRef<HTMLInputElement | null>(null)
  const [caseSearchFocused, setCaseSearchFocused] = useState(false)
  useCmdK(caseSearchRef, () => setCaseSearchFocused(true))

  // Deep-link support: the bell links here as /library?q=<case id> so
  // clicking a new-reply notification jumps straight to that case instead of
  // a bare case list. useSearchParams (not a raw window.location.search read)
  // so this fires even when the operator is already sitting on /library and
  // clicks another bell item — a plain effect with an empty dep array would
  // only ever run on mount and silently do nothing on the second click.
  // Window/status filters are opened wide so an older thread the 30-day
  // default would otherwise hide doesn't make the link look broken. The text
  // search box is deliberately left alone — the point is to land on the case
  // in place, not hide every other row.
  const searchParams = useSearchParams()
  useEffect(() => {
    const q = searchParams.get('q')
    if (!q) return
    setCaseWindowDays(0)
    setCaseStatusFilter('all')
    setHighlightCaseId(q)
  }, [searchParams])

  // Every verified_answers row, kept around just for the Reply column's
  // preview snippet (see replyPreviews below) — linking a reply to a case
  // now lives only on /replies ("Linked cases"), not duplicated here.
  const [existingReplies, setExistingReplies] = useState<
    { id: string; question_summary: string; answer_text: string }[]
  >([])

  // The chat-bubble popup for a case with an unread new reply.
  const [conversationCase, setConversationCase] = useState<CaseRow | null>(null)

  // `retried` gates the auto-recovery to a single attempt per call — a
  // session refresh either clears the clock-skew rejection or it doesn't;
  // looping on it would just hammer the same failing request.
  const loadCases = useCallback(async (retried = false): Promise<void> => {
    setCasesError('')
    setCasesLoading(true)
    try {
      const client = supabaseClient()
      const [patternsRes, verifiedRes, statusRes, linksRes] = await Promise.all([
        client
          .from('community_patterns')
          .select(
            'id, source_title, issue_summary, typical_approach, surface, tags, source_url, source_urls, thread_created_at, last_seen, created_at, review_status, topic, subtopic, added_by',
          ),
        client
          .from('verified_answers')
          .select(
            'id, category, subcategory, question_summary, answer_text, source_url, verified_at, created_at, verified, added_by',
          ),
        client.from('case_status').select('case_id, status, dismissed, url, title, updated_at, unread_since'),
        client.from('verified_answer_cases').select('answer_id, pattern_id'),
      ])
      if (patternsRes.error) throw new Error(patternsRes.error.message)
      if (verifiedRes.error) throw new Error(verifiedRes.error.message)
      if (statusRes.error) throw new Error(statusRes.error.message)
      if (linksRes.error) throw new Error(linksRes.error.message)

      const built = buildCases(
        (patternsRes.data || []) as Pattern[],
        (verifiedRes.data || []) as VerifiedAnswer[],
        (statusRes.data || []) as {
          case_id: string
          status: CaseStatus
          dismissed: boolean
          url: string | null
          title: string | null
          updated_at: string | null
          unread_since: string | null
        }[],
        (linksRes.data || []) as { answer_id: string; pattern_id: string }[],
      )
      setCases(built)
      setExistingReplies(
        ((verifiedRes.data || []) as { id: string; question_summary: string; answer_text: string }[]).map(v => ({
          id: v.id,
          question_summary: v.question_summary,
          answer_text: v.answer_text,
        })),
      )
    } catch (err) {
      // A fresh session token usually carries a corrected `iat` — worth one
      // silent retry before bothering the operator with a Retry button.
      if (!retried && isJwtClockSkewError(err)) {
        try {
          await supabaseClient().auth.refreshSession()
        } catch {
          // Refresh itself failing just means the retry below fails too,
          // surfacing the same error — nothing extra to handle here.
        }
        return loadCases(true)
      }
      setCases([])
      setCasesError(errorMessage(err, 'Could not load cases.'))
    } finally {
      setCasesLoading(false)
    }
  }, [])

  useEffect(() => {
    loadCases()
  }, [loadCases])

  async function updateCaseStatus(row: CaseRow, status: CaseStatus) {
    setCases(prev => prev.map(c => (c.id === row.id ? { ...c, status } : c)))
    const {
      data: { user },
    } = await supabaseClient().auth.getUser()
    if (!user) return
    const { error: upsertError } = await supabaseClient()
      .from('case_status')
      .upsert({ case_id: row.id, user_id: user.id, status, updated_at: new Date().toISOString() })
    if (upsertError) {
      setCasesError(errorMessage(upsertError, 'Could not save that status change.'))
      setCases(prev => prev.map(c => (c.id === row.id ? { ...c, status: row.status } : c)))
      return
    }

    // Semi-manual reply auto-fill: Solved (closed) and "CM replied · solved"
    // both mean the operator has already resolved it — the second is a case
    // still open on the board but answered, so it's just as much a source of
    // a real fix as a fully closed one. If it has no reply on record yet,
    // draft one from whatever solved it (the thread's own answer, a
    // matching solved thread, or the case's recorded fix) so the operator's
    // only step left is review + copy-paste. Best-effort — a failed draft
    // never blocks the status change itself, it just means write the reply
    // by hand as before.
    if ((status === 'closed' || status === 'cm_replied_solved') && row.replyStatus === 'none') {
      void draftReplyForClosedCase(row)
    }
  }

  async function draftReplyForClosedCase(row: CaseRow) {
    try {
      await callWatchFn<{ success: true; answer_id: string; grounding: string }>('draft-from-case', {
        case_id: row.id,
        title: row.title,
        url: row.url,
      })
      toast.success('Drafted a reply from the fix — review it on Replies.')
      await loadCases()
    } catch (err) {
      toast.error(errorMessage(err, 'Could not draft a reply — write this one by hand.'))
    }
  }

  // Clears the bell's unread flag for a case — called when the operator
  // actually looks at it (opens the thread link, or the linked reply). Fire
  // and forget: worst case a stale unread flag lingers one extra poll, never
  // blocks the click it's attached to.
  function markCaseViewed(row: CaseRow) {
    if (!row.unreadSince) return
    setCases(prev => prev.map(c => (c.id === row.id ? { ...c, unreadSince: null } : c)))
    void (async () => {
      const {
        data: { user },
      } = await supabaseClient().auth.getUser()
      if (!user) return
      await supabaseClient()
        .from('case_status')
        .upsert({ case_id: row.id, user_id: user.id, unread_since: null, updated_at: new Date().toISOString() })
    })()
  }

  // Manual link override — same upsert path as status/dismissed, keyed by
  // the same case_id. Clearing (url: null) reverts display to the derived
  // link; buildCases treats a null/empty override as "no override".
  async function updateCaseUrl(row: CaseRow, url: string | null) {
    const prevManualUrl = row.manualUrl
    setCases(prev =>
      prev.map(c =>
        c.id === row.id
          ? { ...c, manualUrl: url, url: url || c.derivedUrl, topicId: deriveTopicId(url || c.derivedUrl) }
          : c,
      ),
    )
    const {
      data: { user },
    } = await supabaseClient().auth.getUser()
    if (!user) return
    const { error: upsertError } = await supabaseClient()
      .from('case_status')
      .upsert({ case_id: row.id, user_id: user.id, url, updated_at: new Date().toISOString() })
    if (upsertError) {
      setCasesError(errorMessage(upsertError, 'Could not save that link.'))
      setCases(prev =>
        prev.map(c =>
          c.id === row.id
            ? { ...c, manualUrl: prevManualUrl, url: prevManualUrl || c.derivedUrl, topicId: deriveTopicId(prevManualUrl || c.derivedUrl) }
            : c,
        ),
      )
    }
  }

  // Manual title override — same upsert path as status/url, keyed by the
  // same case_id. Clearing (title: null) reverts display to the derived
  // title; buildCases treats a null/empty override as "no override".
  async function updateCaseTitle(row: CaseRow, title: string | null) {
    const prevManualTitle = row.manualTitle
    setCases(prev =>
      prev.map(c => (c.id === row.id ? { ...c, manualTitle: title, title: title || c.derivedTitle } : c)),
    )
    const {
      data: { user },
    } = await supabaseClient().auth.getUser()
    if (!user) return
    const { error: upsertError } = await supabaseClient()
      .from('case_status')
      .upsert({ case_id: row.id, user_id: user.id, title, updated_at: new Date().toISOString() })
    if (upsertError) {
      setCasesError(errorMessage(upsertError, 'Could not save that title.'))
      setCases(prev =>
        prev.map(c =>
          c.id === row.id ? { ...c, manualTitle: prevManualTitle, title: prevManualTitle || c.derivedTitle } : c,
        ),
      )
    }
  }

  // A real delete, not a hide: removes the underlying row itself
  // (community_patterns or verified_answers) plus its case_status row.
  // verified_answer_cases entries cascade automatically (ON DELETE CASCADE).
  // Previously this only upserted case_status.dismissed = true, which left
  // the row in place forever — "removed" cases kept colliding with anything
  // that later re-matched the same thread (auto-collect, a backfill run),
  // silently landing back in a hidden, still-dismissed state instead of
  // actually being gone.
  async function removeCase(row: CaseRow) {
    setCases(prev => prev.filter(c => c.id !== row.id))
    const table = row.source === 'pattern' ? 'community_patterns' : 'verified_answers'
    const rowId = row.id.slice(row.id.indexOf(':') + 1)
    const { error: deleteError } = await supabaseClient().from(table).delete().eq('id', rowId)
    if (deleteError) {
      setCasesError(errorMessage(deleteError, 'Could not remove that case.'))
      setCases(prev => [...prev, row])
      return
    }
    // Best-effort cleanup — case_status has no FK to either source table, so
    // a failure here would only leave a harmless orphaned row behind, never
    // block the actual deletion above.
    await supabaseClient().from('case_status').delete().eq('case_id', row.id)
  }

  const replyPreviews = useMemo(
    () => new Map(existingReplies.map(r => [r.id, r.answer_text] as const)),
    [existingReplies],
  )

  const windowedCases = useMemo(
    () => cases.filter(c => withinCaseWindow(c.activityDate, caseWindowDays)),
    [cases, caseWindowDays],
  )
  const statusFilteredCases = useMemo(
    () => (caseStatusFilter === 'all' ? windowedCases : windowedCases.filter(c => c.status === caseStatusFilter)),
    [windowedCases, caseStatusFilter],
  )
  // Same board category shown in the Category column (bug-reports/
  // feature-requests/questions), derived from the case's own URL — not a
  // stored field, so filtering just re-derives it per row.
  const categoryFilteredCases = useMemo(
    () =>
      caseCategoryFilter === 'all'
        ? statusFilteredCases
        : statusFilteredCases.filter(c => boardCategoryFromUrl(c.url) === caseCategoryFilter),
    [statusFilteredCases, caseCategoryFilter],
  )
  // Plain substring search across the fields actually shown in the table, so
  // what the operator can see is what they can search.
  const visibleCases = useMemo(() => {
    const needle = caseQuery.trim().toLowerCase()
    if (!needle) return categoryFilteredCases
    return categoryFilteredCases.filter(c =>
      [c.title, c.url, c.id, c.topicId, String(c.caseNumber), ...(c.tags || [])]
        .filter(Boolean)
        .some(field => String(field).toLowerCase().includes(needle)),
    )
  }, [categoryFilteredCases, caseQuery])

  const hiddenCases = cases.length - windowedCases.length
  const recheckCaseIds = useMemo(
    () => visibleCases.filter(c => c.linkStatus === 'recheck').map(c => c.id),
    [visibleCases],
  )
  const recheckCount = recheckCaseIds.length

  const pageCount = Math.max(1, Math.ceil(visibleCases.length / pageSize))
  // Clamp rather than reset: changing a filter can shrink the list below the
  // current page, which would otherwise render an empty table with no hint
  // that there is anything to see.
  const safePage = Math.min(page, pageCount)
  const pagedCases = useMemo(
    () => visibleCases.slice((safePage - 1) * pageSize, safePage * pageSize),
    [visibleCases, safePage, pageSize],
  )
  useEffect(() => {
    if (page !== safePage) setPage(safePage)
  }, [page, safePage])

  const pageNumbers = useMemo(() => buildPageNumbers(safePage, pageCount), [safePage, pageCount])

  // Once the bell's target case is in the (now widened) visible list, jump to
  // whichever page it landed on.
  useEffect(() => {
    if (!highlightCaseId) return
    const index = visibleCases.findIndex(c => c.id === highlightCaseId)
    if (index === -1) return
    setPage(Math.floor(index / pageSize) + 1)
  }, [highlightCaseId, visibleCases, pageSize])

  // Scroll it into view and flash it once its row is actually on the current
  // page. Cleared after the flash so revisiting the same case later
  // re-triggers it instead of doing nothing the second time.
  useEffect(() => {
    if (!highlightCaseId) return
    if (!pagedCases.some(c => c.id === highlightCaseId)) return
    const el = document.querySelector(`[data-case-id="${highlightCaseId}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const timeout = window.setTimeout(() => setHighlightCaseId(null), 2500)
    return () => window.clearTimeout(timeout)
  }, [highlightCaseId, pagedCases])

  function exportCasesCsv() {
    const csv = casesToCsv(visibleCases)
    const windowLabel = CASE_WINDOW_OPTIONS.find(o => o.days === caseWindowDays)?.label || 'all'
    const suffix = windowLabel.replace(/\s+/g, '').toLowerCase()
    downloadCsv(`cases-${suffix}-${isoDate(new Date().toISOString())}.csv`, csv)
  }

  function resetFilters() {
    setCaseQuery('')
    setCaseWindowDays(DEFAULT_CASE_WINDOW_DAYS)
    setCaseStatusFilter('all')
    setCaseCategoryFilter('all')
    setPageSize(PAGE_SIZES[0])
    setPage(1)
  }

  const filtersActive =
    caseQuery !== '' ||
    caseWindowDays !== DEFAULT_CASE_WINDOW_DAYS ||
    caseStatusFilter !== 'all' ||
    caseCategoryFilter !== 'all' ||
    pageSize !== PAGE_SIZES[0]

  return (
    <div className="stack-lg">
      <Toaster />
      <div className="page-head">
        <h1>Library</h1>
      </div>

      {/* The pattern/cluster browser used to live here. It described issues
          without letting the operator act on them, and duplicated data that
          Cases and the Replies boxes already show, so it was removed. Its
          "Sync"/refine control has since been removed too — the fixed
          9-topic/27-subtopic taxonomy replaced the self-organizing cluster
          system (community_clusters, refine-clusters, its 30-minute cron)
          entirely, so there is nothing left to sync on demand. */}

      <section className="stack-lg">
        <h2>Cases</h2>

        {/* Search sits on its own row above the filters: it is the control
            reached for most often, and giving it the full width stops the
            selects from squeezing it down to a stub. Both rows share one
            stack so they read as a single control block. */}
        {caseSearchFocused ? <div className="page-dim" /> : null}
        <div className="stack">
        <div className="field search-bar-row">
          <label htmlFor="case-search">Search</label>
          <div className="input-kbd-wrap dim-on-focus">
            <input
              ref={caseSearchRef}
              id="case-search"
              className="input-lg"
              type="search"
              value={caseQuery}
              placeholder="Filter cases by number, title, tag or thread id"
              onChange={e => setCaseQuery(e.target.value)}
              onBlur={() => setCaseSearchFocused(false)}
            />
            <KbdHint letter="K" />
          </div>
        </div>

        <div className="row">
            <div className="field field-inline" style={{ minWidth: 140, flex: '0 0 auto' }}>
              <label htmlFor="case-window">Time frame</label>
              <select
                id="case-window"
                value={caseWindowDays}
                onChange={e => setCaseWindowDays(Number(e.target.value))}
              >
                {CASE_WINDOW_OPTIONS.map(option => (
                  <option key={option.days} value={option.days}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field field-inline" style={{ minWidth: 180, flex: '0 0 auto' }}>
              <label htmlFor="case-status-filter">Status</label>
              <select
                id="case-status-filter"
                value={caseStatusFilter}
                onChange={e => setCaseStatusFilter(e.target.value as CaseStatus | 'all')}
              >
                <option value="all">All</option>
                {CASE_STATUS_OPTIONS.map(option => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field field-inline" style={{ minWidth: 160, flex: '0 0 auto' }}>
              <label htmlFor="case-category-filter">Category</label>
              <select
                id="case-category-filter"
                value={caseCategoryFilter}
                onChange={e => setCaseCategoryFilter(e.target.value)}
              >
                <option value="all">All</option>
                {CATEGORY_OPTIONS.map(option => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field field-inline" style={{ minWidth: 110, flex: '0 0 auto' }}>
              <label htmlFor="case-page-size">Per page</label>
              <select
                id="case-page-size"
                value={pageSize}
                onChange={e => setPageSize(Number(e.target.value))}
              >
                {PAGE_SIZES.map(size => (
                  <option key={size} value={size}>{size}</option>
                ))}
              </select>
            </div>
            {/* Aligned to the bottom of the selects rather than the top of the
                row, so it sits on the controls' baseline instead of floating
                level with their labels. */}
            <div className="field field-inline" style={{ flex: '0 0 auto' }}>
              <span className="field-label-spacer" aria-hidden="true" />
              <span className="meta">
                {visibleCases.length} case{visibleCases.length === 1 ? '' : 's'}
                {recheckCount > 0 ? (
                  <>
                    {', '}
                    <button
                      type="button"
                      className="meta-link-btn"
                      onClick={() => setHighlightCaseId(recheckCaseIds[0])}
                    >
                      {recheckCount} need re-check
                    </button>
                  </>
                ) : null}
              </span>
            </div>
            <span className="spacer" />
            {/* minWidth 0 overrides .field-inline's 220px floor, which would
                otherwise pad the pair away from the row's right edge. */}
            <div className="field field-inline" style={{ flex: '0 0 auto', minWidth: 0 }}>
              <span className="field-label-spacer" aria-hidden="true" />
              <div className="row" style={{ gap: 8, flexWrap: 'nowrap', justifyContent: 'flex-end' }}>
                <button type="button" className="btn quiet" onClick={resetFilters} disabled={!filtersActive}>
                  Reset filters
                </button>
                <button
                  type="button"
                  className="btn primary"
                  onClick={exportCasesCsv}
                  disabled={casesLoading || visibleCases.length === 0}
                >
                  Export CSV
                </button>
              </div>
            </div>
          </div>
        </div>

          {hiddenCases > 0 ? <p className="meta">{hiddenCases} of {cases.length} cases outside this window</p> : null}

          {casesError ? (
            <p className="error">
              {casesError}{' '}
              <button type="button" className="btn quiet" onClick={() => void loadCases()}>
                Retry
              </button>
            </p>
          ) : null}

          {/* casesLoading gates the empty state specifically: rows.length === 0
              is indistinguishable from "still fetching" otherwise, so a case
              that landed seconds ago (from the Dashboard) could flash "No
              cases in this window" for the instant before the fetch resolves,
              reading as if the collect had failed. */}
          {casesLoading && pagedCases.length === 0 ? (
            <p className="meta"><span className="spinner" /> Loading cases…</p>
          ) : (
            <CaseTable
              rows={pagedCases}
              replyPreviews={replyPreviews}
              onStatusChange={updateCaseStatus}
              onUrlChange={updateCaseUrl}
              onTitleChange={updateCaseTitle}
              onRemove={removeCase}
              onView={markCaseViewed}
              highlightId={highlightCaseId}
              onOpenConversation={row => {
                markCaseViewed(row)
                setConversationCase(row)
              }}
            />
          )}

          {conversationCase ? (
            <CaseConversationModal
              row={conversationCase}
              existingReply={
                conversationCase.replyAnswerId ? replyPreviews.get(conversationCase.replyAnswerId) : undefined
              }
              onClose={() => setConversationCase(null)}
            />
          ) : null}

          {pageCount > 1 ? (
            <div className="row pager" role="navigation" aria-label="Case pages">
              <button
                type="button"
                className="btn"
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
              >
                Prev
              </button>
              {pageNumbers.map((n, i) =>
                n === ELLIPSIS ? (
                  <span key={`gap-${i}`} className="meta">…</span>
                ) : (
                  <button
                    key={n}
                    type="button"
                    className={`btn${n === page ? ' primary' : ''}`}
                    aria-current={n === page ? 'page' : undefined}
                    onClick={() => setPage(n)}
                  >
                    {n}
                  </button>
                ),
              )}
              <button
                type="button"
                className="btn"
                onClick={() => setPage(p => Math.min(pageCount, p + 1))}
                disabled={page === pageCount}
              >
                Next
              </button>
            </div>
          ) : null}
      </section>
    </div>
  )
}
