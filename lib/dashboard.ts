// Types shared with the investigate contract (lib/investigate.ts). No other
// file should need to define these.

/**
 * A past case from the Library (community_patterns) that matched the pasted
 * post semantically. Mirrors PatternHit in
 * supabase/functions/_shared/pattern-search.ts.
 */
export interface PatternHit {
  id: string
  issue_summary: string
  typical_approach: string
  tags: string[]
  frequency: number
  last_seen: string | null
  similarity: number
  surface: string | null
  topic: string | null
  subtopic: string | null
  /** The source post's real title, in its own language. */
  source_title: string | null
  source_urls: string[]
  thread_created_at: string | null
}
