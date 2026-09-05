'use client'

import { useEffect, useRef, useState } from 'react'
import { toast, Toaster } from '@/components/Toast'
import { callWatchFn } from '@/lib/functions'
import { errorMessage, supabaseClient } from '@/lib/supabase'
import { COMMUNITY_TAGS } from '@/lib/tags'
import InvestigationPanel from '@/components/InvestigationPanel'
import KbdHint from '@/components/KbdHint'
import { useCmdK } from '@/lib/useCmdK'
import type { InvestigateResponse } from '@/lib/investigate'
import type { SuggestTagsResponse } from '@/lib/types'

// Dashboard route is its own page component, so switching tabs and coming
// back unmounts and remounts it — a walkthrough would otherwise vanish just
// from clicking Library and back. sessionStorage survives that (and a tab
// reload), and is scoped to the browser tab, unlike localStorage.
const DASHBOARD_STORAGE_KEY = 'wtch.dashboard.state'

interface DashboardSnapshot {
  text: string
  investigation: InvestigateResponse | null
  selectedTags: string[]
  recommendedTags: string[]
  showAllTags: boolean
  tagsSaved: boolean
}

function readSnapshot(): Partial<DashboardSnapshot> {
  try {
    const raw = sessionStorage.getItem(DASHBOARD_STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function writeSnapshot(patch: Partial<DashboardSnapshot>) {
  try {
    sessionStorage.setItem(DASHBOARD_STORAGE_KEY, JSON.stringify({ ...readSnapshot(), ...patch }))
  } catch {
    // Storage full/unavailable — state just won't survive this navigation.
  }
}

// A run (Investigate itself, and the tag suggestion it kicks off) lives at
// module scope, not component state — component state dies the moment the
// operator clicks another tab, which used to silently drop whatever the
// call came back with. A plain in-flight promise survives client-side route
// changes just fine (the module isn't reloaded, only the page component
// unmounts), so the work keeps running and writes its result straight to
// sessionStorage as soon as it lands, regardless of whether Dashboard is
// still the mounted page. `inFlightText` / `suggestingPatternId` are read
// directly by any mounted DashboardPage instance to show "Working" without
// needing to have started the run itself; `runListeners` is how a remount
// (or an instance left mounted the whole time) hears about it finishing.
let inFlightText: string | null = null
let suggestingPatternId: string | null = null
const runListeners = new Set<(withResync: boolean) => void>()
// `withResync` distinguishes "just force a re-render" (start of a run,
// nothing new on disk yet) from "and pull the latest snapshot off
// sessionStorage" (a run finished, its result is now written). Notifying
// with resync at the START of a run would read back the previous, stale
// investigation and clobber the setInvestigation(null) a fresh run's own
// caller just did — same bump, minus the data resync, fixes that.
function notifyRunListeners(withResync: boolean) {
  runListeners.forEach(listen => listen(withResync))
}

async function suggestTagsInBackground(patternId: string) {
  suggestingPatternId = patternId
  notifyRunListeners(false)
  try {
    const data = await callWatchFn<SuggestTagsResponse>('suggest-tags', { pattern_id: patternId })
    // The model's picks are a claim, not a fact — anything not an exact
    // COMMUNITY_TAGS member is dropped rather than shown (suggest-tags already
    // does this same filtering server-side; this is a second, independent
    // check on the client).
    const allowed = new Set(COMMUNITY_TAGS)
    const valid = [...new Set(data.tags.filter(t => allowed.has(t)))]
    const prevSelected = readSnapshot().selectedTags ?? []
    writeSnapshot({
      recommendedTags: valid,
      selectedTags: [...new Set([...prevSelected, ...valid])],
      tagsSaved: false,
    })
  } catch {
    // Advisory only — a failed suggestion just leaves the section empty;
    // the operator can hit Re-suggest. Nowhere to surface an error once
    // the page that started it may be long gone.
  } finally {
    suggestingPatternId = null
    notifyRunListeners(true)
  }
}

async function runInvestigateInBackground(
  value: string,
  opts: { skipAutoCollect?: boolean; patternId?: string } = {},
) {
  inFlightText = value
  notifyRunListeners(false)
  try {
    const data = await callWatchFn<InvestigateResponse>('investigate', {
      text: value,
      ...(opts.skipAutoCollect ? { skip_auto_collect: true } : {}),
      ...(opts.patternId ? { pattern_id: opts.patternId } : {}),
    })
    writeSnapshot({
      text: value,
      investigation: data,
      selectedTags: [],
      recommendedTags: [],
      showAllTags: false,
      tagsSaved: false,
    })
    if (data.auto_collected) {
      if (data.auto_collected.action === 'skipped') {
        void suggestTagsInBackground(data.auto_collected.pattern_id)
      } else {
        // url is null for a fallback collect (case built from the pasted
        // text alone, no thread matched) — flagged for a manual link later,
        // not a failure, so this still reads as a success.
        toast.success(
          data.auto_collected.url ? 'Added to library.' : 'Added to library — no thread matched, flagged for re-check.',
        )
        void suggestTagsInBackground(data.auto_collected.pattern_id)
      }
    }
    if (data.errors.some(e => e.startsWith('auto-collect:'))) {
      toast.error('Could not add to library — see the note below the walkthrough.')
    }
  } catch (err) {
    toast.error(errorMessage(err, 'Investigation failed.'))
  } finally {
    inFlightText = null
    notifyRunListeners(true)
  }
}

// Paste a post link (or title, or a plain description), press Go. Runs the
// investigate edge function: searches the tracker, the Library and past
// solved threads at once, decides whether the case can be answered and
// closed or still needs specifics gathered, and hands back a walkthrough —
// what to do, in order, and which past case each step came from. Also
// auto-collects the pasted case into the Library — core behavior, every
// case pasted here ends up tracked, never silently dropped.
export default function DashboardPage() {
  const [text, setText] = useState('')
  const [investigation, setInvestigation] = useState<InvestigateResponse | null>(null)
  const [error, setError] = useState('')

  // Tags, shown once a run auto-collects the pasted post's own thread
  // (auto_collected.pattern_id) — there's no community_patterns row to save
  // tags onto otherwise, so the section only appears then.
  //
  // Default view is AI-recommended tags only, not the full COMMUNITY_TAGS wall.
  // `recommendedTags` holds the last validated suggestion (subset of
  // COMMUNITY_TAGS); `showAllTags` is the deliberate, operator-triggered escape
  // hatch to the full fixed list.
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [recommendedTags, setRecommendedTags] = useState<string[]>([])
  const [showAllTags, setShowAllTags] = useState(false)
  const [tagsBusy, setTagsBusy] = useState(false)
  const [tagsError, setTagsError] = useState('')
  const [tagsSaved, setTagsSaved] = useState(false)

  // Re-rendered whenever the background run (or its tag suggestion) starts
  // or finishes, so `busy`/`suggesting` below always reflect the module-
  // level state even if this particular instance never started the run —
  // e.g. it was mounted before the run began, or just remounted after it.
  const [, bump] = useState(0)
  const busy = inFlightText !== null
  const suggesting = suggestingPatternId !== null

  const checkAgainApplied = useRef(false)
  const textInputRef = useRef<HTMLInputElement | null>(null)
  const [searchFocused, setSearchFocused] = useState(false)
  useCmdK(textInputRef, () => setSearchFocused(true))

  useEffect(() => {
    const listener = (withResync: boolean) => {
      bump(n => n + 1)
      if (!withResync) return
      const saved = readSnapshot()
      if (saved.investigation !== undefined) setInvestigation(saved.investigation)
      if (Array.isArray(saved.selectedTags)) setSelectedTags(saved.selectedTags)
      if (Array.isArray(saved.recommendedTags)) setRecommendedTags(saved.recommendedTags)
    }
    runListeners.add(listener)
    return () => {
      runListeners.delete(listener)
    }
  }, [])

  // Restored post-mount, not via a useState lazy initializer: the initial
  // render must match the server's (empty) markup, or React flags a
  // hydration mismatch.
  useEffect(() => {
    const saved = readSnapshot()
    if (typeof saved.text === 'string') setText(saved.text)
    if (saved.investigation) setInvestigation(saved.investigation)
    if (Array.isArray(saved.selectedTags)) setSelectedTags(saved.selectedTags)
    if (Array.isArray(saved.recommendedTags)) setRecommendedTags(saved.recommendedTags)
    if (typeof saved.showAllTags === 'boolean') setShowAllTags(saved.showAllTags)
    if (typeof saved.tagsSaved === 'boolean') setTagsSaved(saved.tagsSaved)
  }, [])

  // Keeps the typed-but-not-yet-submitted text alive across a tab switch
  // too, not just a finished run's result — writeSnapshot merges, so this
  // never clobbers investigation/tags written elsewhere.
  useEffect(() => {
    writeSnapshot({ text })
  }, [text])

  // Library's "Rerun" link lands here as /dashboard?text=<url or
  // title>&run=1&pattern_id=<id> — re-investigating a case already tracked
  // without re-copying its link, and without auto-collect touching that
  // row again. Runs once per page load (after the sessionStorage restore
  // above, so an explicit link click wins over whatever was left in this
  // tab) and strips the query string afterward so a later manual
  // Clear/Go doesn't re-trigger it.
  useEffect(() => {
    if (checkAgainApplied.current) return
    checkAgainApplied.current = true
    const params = new URLSearchParams(window.location.search)
    const queryText = params.get('text')
    if (!queryText) return
    const autoRun = params.get('run') === '1'
    const patternId = params.get('pattern_id') || undefined
    setText(queryText)
    window.history.replaceState(null, '', window.location.pathname)
    if (autoRun) run(queryText, { skipAutoCollect: true, patternId })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function clearDashboard() {
    setText('')
    setError('')
    setInvestigation(null)
    setSelectedTags([])
    setRecommendedTags([])
    setShowAllTags(false)
    setTagsError('')
    setTagsSaved(false)
    sessionStorage.removeItem(DASHBOARD_STORAGE_KEY)
  }

  function run(overrideText?: string, opts?: { skipAutoCollect?: boolean; patternId?: string }) {
    const value = (overrideText ?? text).trim()
    if (!value) return setError('Paste a title, or describe the issue.')
    setError('')
    setInvestigation(null)
    setSelectedTags([])
    setRecommendedTags([])
    setShowAllTags(false)
    setTagsError('')
    setTagsSaved(false)
    void runInvestigateInBackground(value, opts)
  }

  function toggleTag(tag: string) {
    setTagsSaved(false)
    setSelectedTags(prev => (prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]))
  }

  function suggestTags() {
    const patternId = investigation?.auto_collected?.pattern_id
    if (!patternId) return
    void suggestTagsInBackground(patternId)
  }

  async function saveTags() {
    const patternId = investigation?.auto_collected?.pattern_id
    if (!patternId) return
    setTagsError('')
    setTagsBusy(true)
    try {
      const { error: updateError } = await supabaseClient()
        .from('community_patterns')
        .update({ tags: selectedTags })
        .eq('id', patternId)
      if (updateError) throw new Error(updateError.message)
      setTagsSaved(true)
    } catch (err) {
      setTagsError(errorMessage(err, 'Could not save tags.'))
    } finally {
      setTagsBusy(false)
    }
  }

  // Default view is AI-recommended tags only. "Show all tags" deliberately
  // reveals the full COMMUNITY_TAGS list; otherwise show recommendations plus
  // anything the operator already checked (so a manual pick made while the
  // full list was open doesn't vanish when they switch back).
  const visibleTags = showAllTags ? COMMUNITY_TAGS : [...new Set([...recommendedTags, ...selectedTags])]

  return (
    <div className="stack-lg">
      <Toaster />

      <div className="page-head">
        <h1>Dashboard</h1>
      </div>

      {searchFocused ? <div className="page-dim" /> : null}

      <div className="row search-bar-row">
        <div className="input-kbd-wrap dim-on-focus grow">
          <input
            ref={textInputRef}
            type="text"
            value={text}
            placeholder="Paste the post link, or describe the issue"
            spellCheck={false}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') run()
            }}
            onBlur={() => setSearchFocused(false)}
          />
          <KbdHint letter="K" />
        </div>
        <button type="button" className="btn primary" onClick={() => run()} disabled={busy}>
          {busy ? (
            <>
              <span className="spinner" /> Working
            </>
          ) : (
            'Go'
          )}
        </button>
        <button type="button" className="btn" onClick={clearDashboard} disabled={busy}>
          Clear
        </button>
      </div>

      {error ? <p className="error">{error}</p> : null}

      {investigation?.auto_collected ? (
        <div className="field">
          <div className="row">
            <label className="grow">Tags</label>
            <button type="button" className="btn quiet" onClick={() => setShowAllTags(v => !v)}>
              {showAllTags ? 'Show recommended' : 'Show all tags'}
            </button>
            <button type="button" className="btn" onClick={suggestTags} disabled={suggesting}>
              {suggesting ? 'Suggesting' : recommendedTags.length ? 'Re-suggest' : 'Suggest tags'}
            </button>
            <button type="button" className="btn" onClick={saveTags} disabled={tagsBusy}>
              {tagsBusy ? 'Saving' : tagsSaved ? 'Saved' : 'Save tags'}
            </button>
          </div>
          {visibleTags.length ? (
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              {visibleTags.map(tag => (
                <button
                  key={tag}
                  type="button"
                  className={`chip tag-chip${selectedTags.includes(tag) ? ' tag-chip-selected' : ''}`}
                  aria-pressed={selectedTags.includes(tag)}
                  onClick={() => toggleTag(tag)}
                >
                  {tag}
                </button>
              ))}
            </div>
          ) : suggesting ? (
            <p className="empty">Suggesting tags…</p>
          ) : !tagsError ? (
            <p className="empty">No tags suggested yet.</p>
          ) : null}
          {tagsError ? <p className="error">{tagsError}</p> : null}
        </div>
      ) : null}

      {busy && !investigation ? (
        <p className="investigating-status">
          <span className="spinner spinner-lg" /> Investigating
        </p>
      ) : null}

      {investigation ? <InvestigationPanel data={investigation} /> : null}
    </div>
  )
}
