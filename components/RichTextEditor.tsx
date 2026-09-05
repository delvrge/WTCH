'use client'

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { fileToInlineImage, hasRichContent, plainTextFromEditable, sanitizePastedHtml } from '@/lib/richText'

export interface RichTextEditorHandle {
  /** Reads the live DOM at call time, text is always safe to store as-is
   * (grounding/citation/embedding read it); html is only set when the
   * content actually carries formatting, so a plain reply stays plain. */
  getContent: () => { text: string; html: string | null }
  focus: () => void
}

// Uncontrolled by design, a contenteditable fought over by React on every
// keystroke loses the caret position. initialHtml seeds the DOM once on
// mount; from then on this component owns its own content until the parent
// reads it back via the ref (on submit). Remount with a fresh `key` to reset
// it for a different row (Add vs. Edit, or switching which reply is being
// edited), the idiomatic way to reset an uncontrolled field in React.
const RichTextEditor = forwardRef<RichTextEditorHandle, { initialHtml: string; placeholder?: string }>(
  function RichTextEditor({ initialHtml, placeholder }, ref) {
    const contentRef = useRef<HTMLDivElement>(null)
    const savedRange = useRef<Range | null>(null)
    const fileInputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
      if (contentRef.current) contentRef.current.innerHTML = initialHtml
      // Seeded once per mount (see the key-remount note above), re-running
      // this on every initialHtml identity change would stomp on whatever
      // the operator has typed since.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useImperativeHandle(ref, () => ({
      getContent: () => {
        const el = contentRef.current
        if (!el) return { text: '', html: null }
        return {
          text: plainTextFromEditable(el),
          html: hasRichContent(el) ? el.innerHTML : null,
        }
      },
      focus: () => contentRef.current?.focus(),
    }))

    function captureRange() {
      const sel = window.getSelection()
      if (sel?.rangeCount && contentRef.current?.contains(sel.anchorNode)) {
        savedRange.current = sel.getRangeAt(0).cloneRange()
      }
    }

    function restoreRange() {
      const el = contentRef.current
      if (!el) return
      el.focus()
      const sel = window.getSelection()
      if (!sel) return
      sel.removeAllRanges()
      if (savedRange.current && el.contains(savedRange.current.startContainer)) {
        sel.addRange(savedRange.current)
      } else {
        const r = document.createRange()
        r.selectNodeContents(el)
        r.collapse(false)
        sel.addRange(r)
      }
    }

    function applyFormat(cmd: string) {
      contentRef.current?.focus()
      document.execCommand(cmd)
    }

    function insertLink() {
      const sel = window.getSelection()
      if (!sel?.rangeCount || !contentRef.current?.contains(sel.anchorNode) || sel.isCollapsed) return
      const url = window.prompt('Link URL:')
      if (!url) return
      contentRef.current.focus()
      document.execCommand('createLink', false, url)
    }

    function insertInlineCode() {
      const sel = window.getSelection()
      if (!sel?.rangeCount || !contentRef.current?.contains(sel.anchorNode) || sel.isCollapsed) return
      contentRef.current.focus()
      const escaped = sel
        .toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
      document.execCommand('insertHTML', false, `<code>${escaped}</code>`)
    }

    function clearFormat() {
      contentRef.current?.focus()
      document.execCommand('removeFormat')
      document.execCommand('unlink')
    }

    function insertImageAtCursor(dataUrl: string) {
      restoreRange()
      document.execCommand('insertHTML', false, `<div class="rte-img-wrap"><img src="${dataUrl}"></div>`)
      captureRange()
    }

    function openImagePicker() {
      captureRange()
      fileInputRef.current?.click()
    }

    async function handleImageFile(file: File) {
      try {
        const dataUrl = await fileToInlineImage(file)
        insertImageAtCursor(dataUrl)
      } catch {
        // A bad/corrupt image just doesn't insert, nothing else in the
        // reply is at risk, so this fails silently rather than blocking.
      }
    }

    function handlePaste(e: React.ClipboardEvent<HTMLDivElement>) {
      e.preventDefault()
      const items = e.clipboardData?.items
      const imageItem = items ? [...items].find(it => it.type.startsWith('image/')) : undefined
      if (imageItem) {
        const file = imageItem.getAsFile()
        // The paste cursor is still live at this exact point, but decoding
        // the image is async, capture it now (synchronously, same as the
        // image-picker button does before its dialog steals focus) so
        // insertImageAtCursor restores this exact spot instead of falling
        // back to appending at the end once the decode resolves.
        captureRange()
        if (file) void handleImageFile(file)
        return
      }
      const html = e.clipboardData.getData('text/html')
      if (html) {
        document.execCommand('insertHTML', false, sanitizePastedHtml(html))
        return
      }
      document.execCommand('insertText', false, e.clipboardData.getData('text/plain'))
    }

    // Tab/Shift+Tab nests or un-nests the current list item a level, same as
    // any other list editor, instead of tabbing focus away.
    function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
      if (e.key !== 'Tab') return
      let node = window.getSelection()?.anchorNode as Node | null
      while (node && node !== contentRef.current && (node as HTMLElement).nodeName !== 'LI') {
        node = node.parentNode
      }
      if (!node || (node as HTMLElement).nodeName !== 'LI') return
      e.preventDefault()
      document.execCommand(e.shiftKey ? 'outdent' : 'indent')
    }

    return (
      <div className="rte">
        <div className="rte-toolbar">
          <button type="button" className="rte-btn rte-btn-b" title="Bold" aria-label="Bold" onMouseDown={e => e.preventDefault()} onClick={() => applyFormat('bold')}>B</button>
          <button type="button" className="rte-btn rte-btn-i" title="Italic" aria-label="Italic" onMouseDown={e => e.preventDefault()} onClick={() => applyFormat('italic')}>I</button>
          <button type="button" className="rte-btn rte-btn-u" title="Underline" aria-label="Underline" onMouseDown={e => e.preventDefault()} onClick={() => applyFormat('underline')}>U</button>
          <button type="button" className="rte-btn" title="Numbered list" aria-label="Numbered list" onMouseDown={e => e.preventDefault()} onClick={() => applyFormat('insertOrderedList')}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="10" y1="6" x2="21" y2="6" /><line x1="10" y1="12" x2="21" y2="12" /><line x1="10" y1="18" x2="21" y2="18" /><path d="M4 6h1v4" /><path d="M4 10h2" /><path d="M4 18v-1a1 1 0 0 1 1-1h1" /><path d="M4 18h2" /></svg>
          </button>
          <button type="button" className="rte-btn" title="Bulleted list" aria-label="Bulleted list" onMouseDown={e => e.preventDefault()} onClick={() => applyFormat('insertUnorderedList')}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="10" y1="6" x2="21" y2="6" /><line x1="10" y1="12" x2="21" y2="12" /><line x1="10" y1="18" x2="21" y2="18" /><circle cx="4.5" cy="6" r="1.4" fill="currentColor" stroke="none" /><circle cx="4.5" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="4.5" cy="18" r="1.4" fill="currentColor" stroke="none" /></svg>
          </button>
          <button type="button" className="rte-btn" title="Link" aria-label="Link" onMouseDown={e => e.preventDefault()} onClick={insertLink}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
          </button>
          <button type="button" className="rte-btn" title="Code" aria-label="Code" onMouseDown={e => e.preventDefault()} onClick={insertInlineCode}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>
          </button>
          <button type="button" className="rte-btn" title="Clear formatting" aria-label="Clear formatting" onMouseDown={e => e.preventDefault()} onClick={clearFormat}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7V4h13" /><path d="M4 20h9" /><line x1="15" y1="4" x2="9" y2="20" /><line x1="4" y1="4" x2="20" y2="20" /></svg>
          </button>
          <span className="rte-sep" />
          <button type="button" className="rte-btn" title="Insert image" aria-label="Insert image" onMouseDown={e => e.preventDefault()} onClick={openImagePicker}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></svg>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={e => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) void handleImageFile(file)
            }}
          />
        </div>
        <div
          ref={contentRef}
          className="rte-content"
          contentEditable
          suppressContentEditableWarning
          data-placeholder={placeholder}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
        />
      </div>
    )
  },
)

export default RichTextEditor
