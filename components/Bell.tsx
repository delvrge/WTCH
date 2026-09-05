'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { callWatchFn } from '@/lib/functions'
import { supabaseClient } from '@/lib/supabase'

// How often the bell re-checks while the tab is open. Client-driven on
// purpose, it rides the operator's own login session, the same auth path
// Library/Dashboard already use successfully, rather than the server-side
// cron+Vault chain that crawl-support-docs has been stuck on.
const POLL_INTERVAL_MS = 10 * 60 * 1000

interface UnreadCase {
  id: string
  title: string
}

async function resolveTitles(ids: string[]): Promise<Map<string, string>> {
  const patternIds = ids.filter(id => id.startsWith('pattern:')).map(id => id.slice('pattern:'.length))
  const verifiedIds = ids.filter(id => id.startsWith('verified:')).map(id => id.slice('verified:'.length))
  const titles = new Map<string, string>()

  if (patternIds.length) {
    const { data } = await supabaseClient()
      .from('community_patterns')
      .select('id, source_title, issue_summary')
      .in('id', patternIds)
    for (const p of (data ?? []) as { id: string; source_title: string | null; issue_summary: string }[]) {
      titles.set(`pattern:${p.id}`, p.source_title?.trim() || p.issue_summary)
    }
  }
  if (verifiedIds.length) {
    const { data } = await supabaseClient()
      .from('verified_answers')
      .select('id, question_summary, answer_text')
      .in('id', verifiedIds)
    for (const v of (data ?? []) as { id: string; question_summary: string; answer_text: string }[]) {
      titles.set(`verified:${v.id}`, v.question_summary?.trim() || v.answer_text)
    }
  }
  return titles
}

export default function Bell() {
  const [cases, setCases] = useState<UnreadCase[]>([])
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const loadUnread = useCallback(async () => {
    const { data } = await supabaseClient()
      .from('case_status')
      .select('case_id, unread_since')
      .not('unread_since', 'is', null)
      .order('unread_since', { ascending: false })
    const ids = ((data ?? []) as { case_id: string }[]).map(r => r.case_id)
    if (!ids.length) {
      setCases([])
      return
    }
    const titles = await resolveTitles(ids)
    setCases(ids.map(id => ({ id, title: titles.get(id) || id })))
  }, [])

  const check = useCallback(async () => {
    try {
      await callWatchFn('check-case-replies', {})
    } catch {
      // Best-effort, a failed check just means the badge doesn't update this
      // round; it never surfaces as an error to the operator.
    }
    await loadUnread()
  }, [loadUnread])

  useEffect(() => {
    void loadUnread()
    void check()
    const interval = window.setInterval(() => void check(), POLL_INTERVAL_MS)
    function onFocus() {
      void check()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!open) return
    function onClickOutside(event: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [open])

  return (
    <div className="bell-wrap" ref={wrapRef}>
      <button
        type="button"
        className="bell-btn"
        onClick={() => setOpen(v => !v)}
        aria-label={cases.length ? `${cases.length} cases with a new reply` : 'No new replies'}
        title="New replies"
      >
        <svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M8 1.5c-2 0-3.4 1.6-3.4 3.6v1.8c0 .5-.2 1-.5 1.4L3 9.8c-.4.5 0 1.2.6 1.2h8.8c.6 0 1-.7.6-1.2l-1.1-1.5a2.3 2.3 0 0 1-.5-1.4V5.1C11.4 3.1 10 1.5 8 1.5Z"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinejoin="round"
          />
          <path d="M6.3 12.2a1.8 1.8 0 0 0 3.4 0" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
        </svg>
        {cases.length ? <span className="bell-badge">{cases.length > 9 ? '9+' : cases.length}</span> : null}
      </button>
      {open ? (
        <div className="bell-dropdown">
          <div className="bell-dropdown-head">New replies</div>
          {cases.length ? (
            cases.map(c => (
              <Link
                key={c.id}
                href={`/library?q=${encodeURIComponent(c.id)}`}
                className="bell-dropdown-item"
                onClick={() => setOpen(false)}
              >
                {c.title}
              </Link>
            ))
          ) : (
            <p className="bell-dropdown-empty">Nothing new.</p>
          )}
        </div>
      ) : null}
    </div>
  )
}
