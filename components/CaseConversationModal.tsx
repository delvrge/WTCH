'use client'

import { useEffect, useState } from 'react'
import Modal from './Modal'
import { callWatchFn } from '@/lib/functions'
import { errorMessage } from '@/lib/supabase'
import type { CaseRow } from '@/lib/cases'
import type { SuggestFollowupResponse } from '@/lib/types'

/**
 * Opened from the Reply column's "New reply" action when a case has an
 * unread follow-up. Fetches lazily on open (not on every unread detection,
 * to avoid spending an Gemini call on a case nobody's looked at yet) and
 * lays the conversation out as a simple back-and-forth: their complaint, our
 * reply, their follow-up, then a grounded suggestion for what to say next.
 */
export default function CaseConversationModal({
  row,
  existingReply,
  onClose,
}: {
  row: CaseRow
  existingReply?: string
  onClose: () => void
}) {
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading')
  const [error, setError] = useState('')
  const [data, setData] = useState<SuggestFollowupResponse | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let active = true
    async function load() {
      if (!row.url) {
        setState('error')
        setError('No link on record for this case, set one from the Cases table first.')
        return
      }
      try {
        const res = await callWatchFn<SuggestFollowupResponse>('suggest-followup', {
          url: row.url,
          existing_reply: existingReply || null,
        })
        if (!active) return
        setData(res)
        setState('ready')
      } catch (err) {
        if (!active) return
        setError(errorMessage(err, 'Could not load the conversation.'))
        setState('error')
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [row.url, existingReply])

  function copySuggestion() {
    if (!data?.suggestion) return
    navigator.clipboard.writeText(data.suggestion).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <Modal onClose={onClose}>
      <div className="stack conversation-modal">
        <h2>{row.title}</h2>

        {state === 'loading' ? <p className="meta"><span className="spinner" /> Loading conversation…</p> : null}
        {state === 'error' ? <p className="error">{error}</p> : null}

        {state === 'ready' && data ? (
          <div className="stack" style={{ gap: 10 }}>
            <div className="chat-bubble chat-bubble-them">
              <span className="chat-bubble-label">Their complaint</span>
              <p>{data.complaint}</p>
            </div>
            {data.existing_reply ? (
              <div className="chat-bubble chat-bubble-us">
                <span className="chat-bubble-label">Our reply</span>
                <p>{data.existing_reply}</p>
              </div>
            ) : null}
            <div className="chat-bubble chat-bubble-them">
              <span className="chat-bubble-label">Their follow-up</span>
              <p>{data.user_reply}</p>
            </div>
            <div className="chat-bubble chat-bubble-suggestion">
              <span className="chat-bubble-label">Suggested next reply</span>
              <p>{data.suggestion}</p>
              <div className="row">
                <button type="button" className="btn" onClick={copySuggestion}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        <div className="modal-foot">
          <button type="button" className="btn quiet" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  )
}
