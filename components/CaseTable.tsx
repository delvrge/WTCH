'use client'

import { useState } from 'react'
import Link from 'next/link'
import { boardChipClass, boardLabelFromSlug, boardSlugFromUrl, usDate } from '@/lib/format'
import { CASE_STATUS_OPTIONS, isInactiveAwaiting, type CaseRow, type CaseStatus } from '@/lib/cases'
import Modal from './Modal'
import ReplyPreviewCard from './ReplyPreviewCard'

export default function CaseTable({
  rows,
  replyPreviews,
  onStatusChange,
  onUrlChange,
  onTitleChange,
  onRemove,
  onView,
  onOpenConversation,
  highlightId,
}: {
  rows: CaseRow[]
  /** replyAnswerId -> answer_text, for the reply preview card. */
  replyPreviews: Map<string, string>
  onStatusChange: (row: CaseRow, status: CaseStatus) => void
  onUrlChange: (row: CaseRow, url: string | null) => void
  onTitleChange: (row: CaseRow, title: string | null) => void
  onRemove: (row: CaseRow) => void
  /** Clears the bell's unread flag — called when the operator actually looks at the case (opens the thread link or its reply). */
  onView: (row: CaseRow) => void
  /** Opens the chat-bubble conversation popup for a case with a new unread reply. */
  onOpenConversation: (row: CaseRow) => void
  /** Case id to scroll to and flash — set when arriving via the bell's "New replies" deep link. */
  highlightId?: string | null
}) {
  const [editingUrlId, setEditingUrlId] = useState<string | null>(null)
  const [urlDraft, setUrlDraft] = useState('')
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [pendingRemove, setPendingRemove] = useState<CaseRow | null>(null)

  if (rows.length === 0) {
    return <p className="empty">No cases in this window.</p>
  }

  function startUrlEdit(row: CaseRow) {
    setEditingUrlId(row.id)
    setUrlDraft(row.manualUrl ?? row.url ?? '')
  }

  function commitUrlEdit(row: CaseRow) {
    const trimmed = urlDraft.trim()
    setEditingUrlId(null)
    // Empty clears the override and reverts to the derived link; unchanged
    // values are still re-sent, which is harmless (upsert is idempotent).
    onUrlChange(row, trimmed || null)
  }

  function startTitleEdit(row: CaseRow) {
    setEditingTitleId(row.id)
    setTitleDraft(row.manualTitle ?? row.title ?? '')
  }

  function commitTitleEdit(row: CaseRow) {
    const trimmed = titleDraft.trim()
    setEditingTitleId(null)
    // Empty clears the override and reverts to the derived title; unchanged
    // values are still re-sent, which is harmless (upsert is idempotent).
    onTitleChange(row, trimmed || null)
  }

  return (
    <div className="case-card-list">
      {rows.map(row => {
        const boardSlug = boardSlugFromUrl(row.url)
        const board = boardLabelFromSlug(boardSlug)
        const boardClass = boardChipClass(boardSlug)

        return (
          <div
            key={row.id}
            data-case-id={row.id}
            className={`case-card${row.id === highlightId ? ' case-row-highlight' : ''}`}
          >
            <div className="case-card-head">
              <span
                className={`case-status-dot ${
                  isInactiveAwaiting(row) ? 'case-status-dot-inactive' : `case-status-dot-${row.status}`
                }${row.unreadSince ? ' case-status-dot-unread' : ''}`}
                title={
                  row.unreadSince
                    ? 'New reply since you last looked'
                    : isInactiveAwaiting(row)
                      ? 'Inactive — awaiting reply, no response in over a week'
                      : CASE_STATUS_OPTIONS.find(o => o.value === row.status)?.label || row.status
                }
              />
              <span className="case-card-num">#{row.caseNumber}</span>
              {board ? <span className={`chip${boardClass ? ` ${boardClass}` : ''}`}>{board}</span> : null}
              {row.subtopic ? (
                <span className="chip case-topic-chip" title={row.topic ? `${row.topic} — ${row.subtopic}` : row.subtopic}>
                  {row.subtopic}
                </span>
              ) : null}
              <span className="spacer" />
              <div className="case-card-actions">
                <Link
                  href={`/dashboard?text=${encodeURIComponent(row.url || row.title)}&run=1${
                    row.source === 'pattern' ? `&pattern_id=${encodeURIComponent(row.id.slice('pattern:'.length))}` : ''
                  }`}
                  className="btn quiet"
                  title="Re-run Investigate on this case — recommended cases, approach, tags — without re-adding it to the Library"
                  onClick={() => onView(row)}
                >
                  Rerun
                </Link>
                <button
                  type="button"
                  className="btn quiet"
                  title="Not my case — remove it from the tracker"
                  onClick={() => setPendingRemove(row)}
                >
                  Remove
                </button>
              </div>
            </div>

            {editingTitleId === row.id ? (
              <input
                type="text"
                autoFocus
                value={titleDraft}
                placeholder={row.derivedTitle || 'Case title'}
                onChange={e => setTitleDraft(e.target.value)}
                onBlur={() => commitTitleEdit(row)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitTitleEdit(row)
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setEditingTitleId(null)
                  }
                }}
              />
            ) : (
              <div className="case-card-title-row">
                <span className="case-card-title">
                  {row.url ? (
                    <a href={row.url} target="_blank" rel="noreferrer" onClick={() => onView(row)}>
                      {row.title}
                    </a>
                  ) : (
                    row.title
                  )}
                </span>
                <button
                  type="button"
                  className="case-edit-icon-btn"
                  aria-label="Edit title"
                  title="Edit title"
                  onClick={() => startTitleEdit(row)}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
                  </svg>
                </button>
              </div>
            )}

            <div className="case-card-meta">
              {editingUrlId === row.id ? (
                <input
                  type="text"
                  autoFocus
                  value={urlDraft}
                  placeholder={row.derivedUrl || 'https://…'}
                  onChange={e => setUrlDraft(e.target.value)}
                  onBlur={() => commitUrlEdit(row)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      commitUrlEdit(row)
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      setEditingUrlId(null)
                    }
                  }}
                />
              ) : (
                <>
                  {row.url ? (
                    <a className="case-link" href={row.url} target="_blank" rel="noreferrer">
                      Open{row.topicId ? ` #${row.topicId}` : ''}
                    </a>
                  ) : (
                    <span className="case-link-missing">No link on record</span>
                  )}
                  <button
                    type="button"
                    className="case-edit-link"
                    title={row.url ? 'Edit the link for this case' : 'Set a link for this case'}
                    onClick={() => startUrlEdit(row)}
                  >
                    {row.url ? 'Edit link' : 'Set link'}
                  </button>
                  {row.linkStatus === 'recheck' ? <span className="chip case-recheck">needs re-check</span> : null}
                  {usDate(row.caseDate) ? <span className="meta">{usDate(row.caseDate)}</span> : null}
                  {row.addedBy ? <span className="meta">Added by {row.addedBy}</span> : null}
                </>
              )}
              <select
                value={row.status}
                onChange={e => onStatusChange(row, e.target.value as CaseStatus)}
                className={`case-status case-status-${row.status}`}
              >
                {CASE_STATUS_OPTIONS.map(option => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className={`case-card-reply${row.replyStatus === 'verified' ? ' case-card-reply-verified' : ''}`}>
              <ReplyPreviewCard
                row={row}
                previewText={row.replyAnswerId ? replyPreviews.get(row.replyAnswerId) : undefined}
                onView={onView}
                onOpenConversation={onOpenConversation}
              />
            </div>
          </div>
        )
      })}
      {pendingRemove ? (
        <Modal onClose={() => setPendingRemove(null)}>
          <h2>Remove case?</h2>
          <p className="meta">
            Permanently deletes "{pendingRemove.title}" — the underlying record, not just this view. Cannot
            be undone.
          </p>
          <div className="modal-foot">
            <button type="button" className="btn quiet" onClick={() => setPendingRemove(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn danger"
              autoFocus
              onClick={() => {
                const row = pendingRemove
                setPendingRemove(null)
                if (row) onRemove(row)
              }}
            >
              Remove
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
