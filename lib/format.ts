// Display helpers. All of these run after data has loaded on the client, so
// Date.now()/locale use here cannot cause a hydration mismatch.

export function relativeTime(value: string | number | null | undefined): string {
  if (!value) return 'never'
  const ts = typeof value === 'number' ? value : new Date(value).getTime()
  if (!Number.isFinite(ts)) return 'unknown'
  const mins = Math.floor((Date.now() - ts) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

/** ISO calendar date, so a source date is never ambiguous. Used for sorting
 * and filenames (e.g. the Library CSV export), for on-screen display, use
 * usDate below instead. */
export function isoDate(value: string | null | undefined): string | null {
  if (!value) return null
  const ts = new Date(value).getTime()
  if (!Number.isFinite(ts)) return null
  return new Date(ts).toISOString().slice(0, 10)
}

/** MM-DD-YYYY, for on-screen display. */
export function usDate(value: string | null | undefined): string | null {
  const iso = isoDate(value)
  if (!iso) return null
  const [year, month, day] = iso.split('-')
  return `${month}-${day}-${year}`
}

/** "2026-03-04 · 12d ago", or null when the source carries no date. */
export function sourceDateLabel(value: string | null | undefined): string | null {
  const day = isoDate(value)
  if (!day) return null
  return `${day} · ${relativeTime(value)}`
}

// Board slug -> label, derived from a topic URL path segment. There is no DB
// column for this; it is computed at render time.
//
// The platform suffixes the board slug with a numeric id that varies by locale ,
// the English boards are bug-reports-403/feature-requests-405/questions-404,
// but a German or Portuguese post can sit on bug-reports-<other-id> etc.
// Matching on the base name (suffix stripped) rather than the full slug
// means every locale's version of the same three boards is still recognized.
const BOARD_BASE_LABELS: Record<string, string> = {
  'bug-reports': 'Bug Reports',
  'feature-requests': 'Feature Requests',
  questions: 'Questions',
}

function boardBaseName(slug: string): string {
  return slug.replace(/-\d+$/, '')
}

export function boardSlugFromUrl(sourceUrl: string | null | undefined): string | null {
  if (!sourceUrl) return null
  try {
    return new URL(sourceUrl).pathname.replace(/^\/+|\/+$/g, '').split('/')[0] || null
  } catch {
    return null
  }
}

export function boardLabel(sourceUrl: string | null | undefined): string | null {
  const seg = boardSlugFromUrl(sourceUrl)
  return seg ? BOARD_BASE_LABELS[boardBaseName(seg)] || null : null
}

export function boardLabelFromSlug(slug: string | null | undefined): string | null {
  if (!slug) return null
  return BOARD_BASE_LABELS[boardBaseName(slug)] || slug
}

/** Canonical board key ('bug-reports' | 'feature-requests' | 'questions'), or null when the slug doesn't match one of the three, used for filtering, independent of locale/display label. */
export function boardCategoryFromSlug(slug: string | null | undefined): string | null {
  if (!slug) return null
  const base = boardBaseName(slug)
  return BOARD_BASE_LABELS[base] ? base : null
}

export function boardCategoryFromUrl(sourceUrl: string | null | undefined): string | null {
  return boardCategoryFromSlug(boardSlugFromUrl(sourceUrl))
}

// CSS class carrying each board's color (see .chip-bug / .chip-question /
// .chip-feature in globals.css). Unrecognized boards keep the default
// neutral chip styling, null means "no color override".
const BOARD_BASE_CHIP_CLASSES: Record<string, string> = {
  'bug-reports': 'chip-bug',
  'feature-requests': 'chip-feature',
  questions: 'chip-question',
}

export function boardChipClass(slug: string | null | undefined): string | null {
  if (!slug) return null
  return BOARD_BASE_CHIP_CLASSES[boardBaseName(slug)] || null
}

// Discovered topics carry no title, fetching every thread just to read one
// would defeat the point of a lightweight discovery call, so derive a
// readable label from the URL slug: last path segment, trailing "-<id>"
// stripped, hyphens to spaces, first letter capitalised. This is a guess at
// the title, not the real thing.
export function titleFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '')
    const slug = path.split('/').pop() || ''
    const words = slug.replace(/-\d+$/, '').replace(/-/g, ' ').trim()
    if (!words) return 'Untitled thread'
    return words.charAt(0).toUpperCase() + words.slice(1)
  } catch {
    return 'Untitled thread'
  }
}

// The DB keeps the raw `surface` value ("unknown", null, ""), but the UI shows
// an actionable bucket rather than a failure state.
export function surfaceLabel(surface: string | null | undefined): string {
  const s = (surface || '').trim().toLowerCase()
  return s && s !== 'unknown' ? (surface as string) : 'Needs investigation'
}

export function plural(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${count === 1 ? singular : pluralForm || `${singular}s`}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Splits `text` into segments, marking which ones matched a search keyword ,
 * so a caller can highlight the reason a passage was picked without needing
 * a highlighting library. Longer keywords are tried first so a multi-word
 * phrase highlights as one span instead of fragmenting into its own words.
 */
export function highlightSegments(text: string, keywords: string[]): { text: string; hit: boolean }[] {
  const terms = [...new Set(keywords.map((k) => k.trim()).filter(Boolean))].sort((a, b) => b.length - a.length)
  if (!terms.length) return [{ text, hit: false }]

  const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi')
  const lowerTerms = new Set(terms.map((t) => t.toLowerCase()))
  return text
    .split(pattern)
    .filter((part) => part !== '')
    .map((part) => ({ text: part, hit: lowerTerms.has(part.toLowerCase()) }))
}
