'use client'

// Shared helpers for the reply rich-text editor (components/RichTextEditor.tsx).
// The approach mirrors Phraseory's macro editor (a plain contenteditable div
// driven by document.execCommand, not a third-party editor library) — same
// tool, same operator, same "just works in a Chromium browser" bar.

// Only present when the content actually carries formatting — gates whether
// a saved reply gets an answer_html at all, so a plain reply (the common
// case, and every pre-existing row) stays a plain string with no HTML to
// sanitize or render.
const RICH_CONTENT_SELECTOR = 'img, b, strong, i, em, u, ol, ul, a, code'

export function hasRichContent(el: HTMLElement): boolean {
  return Boolean(el.querySelector(RICH_CONTENT_SELECTOR))
}

// Derives the plain-text fallback (images become "[image]", lists become
// "- "/"1. " markers) stored as answer_text alongside answer_html. This is
// what grounding/citation/embedding actually reads — keeping it plain text
// means rich formatting never risks a citation excerpt failing to literally
// match its source.
export function plainTextFromEditable(el: HTMLElement): string {
  let out = ''
  const listStack: { ordered: boolean; index: number }[] = []
  function walk(node: ChildNode) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent || ''
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const tag = (node as HTMLElement).tagName
    if (tag === 'BR') {
      out += '\n'
      return
    }
    if (tag === 'IMG') {
      out += '[image]'
      return
    }
    if (tag === 'UL' || tag === 'OL') {
      listStack.push({ ordered: tag === 'OL', index: 0 })
      node.childNodes.forEach(walk)
      listStack.pop()
      if (out && !out.endsWith('\n')) out += '\n'
      return
    }
    const isBlock = tag === 'DIV' || tag === 'P' || tag === 'LI'
    if (isBlock && out && !out.endsWith('\n')) out += '\n'
    if (tag === 'LI' && listStack.length) {
      const level = listStack[listStack.length - 1]
      level.index += 1
      out += '  '.repeat(listStack.length - 1) + (level.ordered ? `${level.index}. ` : '- ')
    }
    node.childNodes.forEach(walk)
    if (isBlock && !out.endsWith('\n')) out += '\n'
  }
  el.childNodes.forEach(walk)
  return out.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '')
}

// Allowlist for pasted HTML — everything else is unwrapped (its children are
// kept, the tag itself dropped) rather than stripped outright, so pasting a
// Google Doc or a forum post keeps its text and basic structure without
// carrying over arbitrary styling, scripts, or tracking markup.
const PASTE_ALLOWED_TAGS = new Set([
  'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'A', 'CODE', 'UL', 'OL', 'LI', 'BR', 'P', 'DIV',
])

export function sanitizePastedHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  function clean(parent: Node) {
    ;[...parent.childNodes].forEach(node => {
      if (node.nodeType === Node.COMMENT_NODE) {
        node.remove()
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return
      clean(node)
      const el = node as HTMLElement
      if (!PASTE_ALLOWED_TAGS.has(el.tagName)) {
        while (el.firstChild) parent.insertBefore(el.firstChild, el)
        el.remove()
        return
      }
      const isLink = el.tagName === 'A'
      const href = isLink ? el.getAttribute('href') : null
      ;[...el.attributes].forEach(attr => el.removeAttribute(attr.name))
      if (isLink && /^https?:|^mailto:/i.test(href || '')) {
        el.setAttribute('href', href!)
        el.setAttribute('target', '_blank')
        el.setAttribute('rel', 'noopener noreferrer')
      } else if (isLink) {
        while (el.firstChild) parent.insertBefore(el.firstChild, el)
        el.remove()
      }
    })
  }
  clean(doc.body)
  return doc.body.innerHTML
}

// Downscales a picked/pasted image before it goes inline as a base64 data
// URI — this is the reply's permanent copy (the source Storage-backed
// system's signed URLs expire; a self-contained data URI never does), so
// keeping it small matters more than keeping it lossless. PNG/GIF sources
// keep their format (likely a screenshot or logo needing transparency);
// everything else compresses to JPEG like photo content.
const MAX_IMAGE_DIM = 900

export function fileToInlineImage(file: File): Promise<string> {
  const keepAlpha = file.type === 'image/png' || file.type === 'image/gif'
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      let { width, height } = img
      if (width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
        const scale = MAX_IMAGE_DIM / Math.max(width, height)
        width = Math.round(width * scale)
        height = Math.round(height * scale)
      }
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        URL.revokeObjectURL(url)
        reject(new Error('Canvas not available'))
        return
      }
      ctx.drawImage(img, 0, 0, width, height)
      URL.revokeObjectURL(url)
      resolve(keepAlpha ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.85))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Could not read that image'))
    }
    img.src = url
  })
}

// Legacy answer_text rows have no answer_html and were plain strings with
// real newlines — contenteditable collapses a raw "\n" visually, so opening
// one for editing needs it converted to the same per-line <div> shape typing
// Enter in the editor would itself produce.
export function plainTextToEditableHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return escaped
    .split('\n')
    .map(line => `<div>${line || '<br>'}</div>`)
    .join('')
}
