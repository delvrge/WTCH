// Recency window for the watch board.
//
// A pattern about a since-fixed bug must never silently read as current, so
// the board opens filtered to sources newer than 7 days and every row states
// its own source date. Widening is explicit. Rows whose source date is unknown
// cannot be asserted to fall inside a window, so they appear only under "All"
// and are counted in the hidden tally rather than vanishing.

export const DEFAULT_RECENCY_DAYS = 7

export const RECENCY_OPTIONS: { days: number; label: string }[] = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 0, label: 'All' },
]

export function withinRecency(date: string | null | undefined, days: number): boolean {
  if (days === 0) return true
  if (!date) return false
  const ts = new Date(date).getTime()
  if (!Number.isFinite(ts)) return false
  return Date.now() - ts <= days * 86400000
}
