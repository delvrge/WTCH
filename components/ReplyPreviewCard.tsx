'use client'

import Link from 'next/link'
import type { CaseRow } from '@/lib/cases'

const REPLY_STATUS_LABEL: Record<CaseRow['replyStatus'], string> = {
  none: 'No reply',
  unverified: 'Reply',
  verified: 'Verified',
}

/**
 * Fixed-size reply preview shown in the Cases table's Reply column. Replaces
 * the old bare status chip: same size no matter how long the title or reply
 * text is, so a column of these reads as a clean grid rather than rows that
 * grow to fit their content. The reply text fades out at the bottom edge
 * (rather than a hard cut) when it overflows the box.
 *
 * Default click still goes to /replies (edit/copy the reply, unchanged
 * behavior), a case with an unread new reply additionally shows a small
 * "View conversation" action that opens the chat-bubble popup instead.
 */
export default function ReplyPreviewCard({
  row,
  previewText,
  onView,
  onOpenConversation,
}: {
  row: CaseRow
  /** The linked reply's answer_text, when known, undefined when replyStatus is 'none' or the text hasn't loaded. */
  previewText?: string
  onView: (row: CaseRow) => void
  onOpenConversation: (row: CaseRow) => void
}) {
  const unread = Boolean(row.unreadSince)

  // No reply on record yet, the plain chip, same as it always was. No
  // reserved height here: forcing one just to match a populated row made
  // rows LESS even (a short reply forced its row artificially tall next to
  // a longer title with no reply). Letting each row size to its own actual
  // content, capped below, is what makes the table read as even.
  if (row.replyStatus === 'none') {
    return (
      <Link
        href={`/replies?newFor=${encodeURIComponent(row.id)}`}
        className={`chip reply-status reply-status-${row.replyStatus}`}
        onClick={() => onView(row)}
      >
        {REPLY_STATUS_LABEL[row.replyStatus]}
      </Link>
    )
  }

  return (
    <div className={`reply-preview-card${unread ? ' reply-preview-card-unread' : ''}`}>
      <Link
        href={row.replyAnswerId ? `/replies?reply=${row.replyAnswerId}` : '/replies'}
        className="reply-preview-card-body"
        onClick={() => onView(row)}
      >
        <div className="reply-preview-card-head">
          <span className={`chip reply-status reply-status-${row.replyStatus}`}>
            {REPLY_STATUS_LABEL[row.replyStatus]}
            {row.replyCount > 1 ? <span className="reply-status-count">×{row.replyCount}</span> : null}
          </span>
        </div>
        {previewText ? <div className="reply-preview-card-text">{previewText}</div> : null}
      </Link>
      {unread ? (
        <button
          type="button"
          className="reply-preview-card-unread-btn"
          title="New reply, view the conversation"
          onClick={() => onOpenConversation(row)}
        >
          New reply · View conversation
        </button>
      ) : null}
    </div>
  )
}
