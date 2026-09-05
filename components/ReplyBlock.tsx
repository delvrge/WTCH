'use client'

import { useEffect, useState } from 'react'
import { callWatchFn } from '@/lib/functions'
import { errorMessage } from '@/lib/supabase'
import type { SaveVerifiedResponse } from '@/lib/types'

// Typed structurally rather than imported from lib/types or lib/dashboard so
// this one component can render a reply from either contract: the Library's
// SuggestedReply (verified_answer | context_doc | ungrounded) and the
// Dashboard's Draft (verified_answer | support_doc | note | ungrounded) are
// both narrower unions than the `type: string` below, so either is
// assignable here without a shared type existing anywhere.
interface ReplyBlockGrounding {
  type: string
  ref: string | null
  excerpt: string | null
}

export interface ReplyBlockReply {
  reply: string
  grounding: ReplyBlockGrounding
}

function citationLabel(grounding: ReplyBlockGrounding): string {
  if (grounding.type === 'verified_answer') return 'Tracker'
  if (grounding.type === 'support_doc') return grounding.ref ? `Support doc: ${grounding.ref}` : 'Support doc'
  if (grounding.type === 'note') return grounding.ref ? `Note: ${grounding.ref}` : 'Note'
  return grounding.ref || 'Reference'
}

export default function ReplyBlock({
  reply,
  watchId,
  patternId,
  sourceUrl,
  questionSummary,
  className,
}: {
  reply: ReplyBlockReply
  watchId?: string | null
  /** The community_patterns row this reply answers, when known (e.g. the Dashboard's auto-collected self-match) — links the saved Tracker entry to that exact thread. */
  patternId?: string | null
  sourceUrl?: string | null
  questionSummary: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [error, setError] = useState('')
  const [text, setText] = useState(reply.reply)

  // reply.reply only changes when a genuinely new draft lands (a fresh
  // Dashboard search, a freshly-loaded cluster) — not on every render — so
  // resetting here never clobbers an in-progress edit of the current draft.
  useEffect(() => {
    setText(reply.reply)
    setSaveState('idle')
  }, [reply.reply])

  const grounded = reply.grounding.type !== 'ungrounded'
  const label = citationLabel(reply.grounding)

  // The draft's line breaks are meant as soft returns (Shift+Enter), not new
  // paragraphs — so plain-text copy is not enough: most rich-text targets
  // turn a plain "\n" from pasted text into a brand-new paragraph on its own
  // line, which is exactly the extra reformatting this is trying to avoid.
  // Copying real HTML with <br> for every line break preserves a soft break
  // on paste instead, so the reply drops in exactly as drafted.
  function copy() {
    const html = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .split('\n')
      .join('<br>')

    if (navigator.clipboard.write && typeof ClipboardItem !== 'undefined') {
      const item = new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      })
      navigator.clipboard.write([item]).catch(() => {
        navigator.clipboard.writeText(text).catch(() => {})
      })
    } else {
      navigator.clipboard.writeText(text).catch(() => {})
    }

    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  // The feedback loop: a reply the operator actually sent and that actually
  // worked is written to verified_answers, which outranks every other
  // grounding source on the next draft or synthesis run. It shows up
  // afterward on the Replies screen (/replies).
  async function markVerified() {
    if (saveState !== 'idle') return
    setError('')
    setSaveState('saving')
    try {
      await callWatchFn<SaveVerifiedResponse>('save-verified', {
        watch_id: watchId || null,
        pattern_ids: patternId ? [patternId] : [],
        source_url: sourceUrl || null,
        reply_text: text,
        question_summary: questionSummary,
        source_note: grounded ? `${label}${reply.grounding.excerpt ? `: ${reply.grounding.excerpt}` : ''}` : null,
      })
      setSaveState('saved')
    } catch (err) {
      setSaveState('idle')
      setError(errorMessage(err, 'Could not save.'))
    }
  }

  return (
    <div className={`reply${className ? ` ${className}` : ''}`}>
      <textarea
        className="reply-edit"
        value={text}
        onChange={e => setText(e.target.value)}
        rows={Math.max(3, text.split('\n').length)}
        spellCheck={true}
      />

      {grounded ? (
        <div className="stack" style={{ gap: 6 }}>
          <button type="button" className="grounding-toggle" onClick={() => setExpanded(v => !v)}>
            {label}
          </button>
          {expanded && reply.grounding.excerpt ? (
            <p className="excerpt">{reply.grounding.excerpt}</p>
          ) : null}
        </div>
      ) : null}

      <div className="row">
        <button type="button" className="btn" onClick={copy} disabled={!text.trim()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="btn" onClick={markVerified} disabled={saveState !== 'idle' || !text.trim()}>
          {saveState === 'saved' ? 'Saved to Replies' : saveState === 'saving' ? 'Saving' : 'Save to Replies'}
        </button>
      </div>

      {error ? <p className="error">{error}</p> : null}
    </div>
  )
}
