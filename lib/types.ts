// Row shapes for the tables in supabase/migrations, plus the edge function
// request/response contracts.

export type ReviewStatus = 'unreviewed' | 'confirmed' | 'rejected'

export interface Watch {
  id: string
  user_id: string
  title: string
  keywords: string[]
  categories: string[]
  cover: string | null
  auto_run: boolean
  last_run_at: string | null
  last_run_status: string | null
  pattern_count: number
  order: number
  created_at: string
  updated_at: string
  /** Tallied client-side from community_patterns; not a column. */
  unreviewed_count?: number
}

export interface Pattern {
  id: string
  user_id: string
  watch_id: string | null
  cluster: string | null
  /** The source post's own title, verbatim and untranslated. Null on rows
   *  collected before the column existed. */
  source_title: string | null
  issue_summary: string
  typical_approach: string
  surface: string | null
  tags: string[]
  frequency: number
  source_url: string | null
  source_urls: string[]
  thread_created_at: string | null
  source_thread_dates: string[]
  review_status: ReviewStatus
  reviewed_at: string | null
  last_seen: string
  created_at: string
  severity: 'low' | 'medium' | 'high' | null
  /** Fixed taxonomy, see lib/topic-taxonomy.ts. Null on patterns extracted
   *  before the fixed taxonomy replaced the self-organizing cluster system. */
  topic: string | null
  subtopic: string | null
  /** First part of the email of whoever's session inserted this row (set by
   *  a DB trigger, not the app), shown in the Library so a shared
   *  workspace can tell cases apart by who added them. */
  added_by: string | null
}

export interface ContextDoc {
  id: string
  user_id: string
  title: string
  content: string
  sort_order: number
  created_at: string
  updated_at: string
}

export interface VerifiedAnswer {
  id: string
  user_id: string
  watch_id: string | null
  category: string | null
  subcategory: string | null
  question_summary: string
  answer_text: string
  /** Rich HTML for answer_text, set only when the reply actually carries formatting (bold/lists/links/inline images), the Replies screen renders/copies this when present, falling back to plain answer_text otherwise. */
  answer_html: string | null
  source_note: string | null
  /** The thread URL this answer was written for, when known. */
  source_url: string | null
  verified_at: string
  created_at: string
  /** Whether this reply is confirmed correct, grounds/gets cited in future drafts and gets the green "verified" treatment in the UI. An ai_draft row starts false until reviewed. */
  verified: boolean
  /** Which path wrote this row: a human action ('manual', the Add-reply form, or ReplyBlock's "Save to Replies"), or stage-ai-drafts writing a draft on its own ('ai_draft'). */
  source: 'manual' | 'ai_draft'
  /** First part of the email of whoever's session inserted this row (set by
   *  a DB trigger, not the app). */
  added_by: string | null
}

export interface VerifiedAnswerImage {
  id: string
  answer_id: string
  user_id: string
  storage_path: string
  content_type: string | null
  size_bytes: number | null
  created_at: string
}

/** One reply<->case pairing. A reply can answer many cases; a case can carry more than one reply over time. Replaces the old single verified_answers.pattern_id column. */
export interface VerifiedAnswerCase {
  id: string
  answer_id: string
  pattern_id: string
  user_id: string
  created_at: string
}

// ── Edge function contracts ────────────────────────────────────────────────

export interface DiscoveredTopic {
  url: string
  lastmod?: string | null
  board?: string | null
}

export interface SearchResponse {
  success: boolean
  topics?: DiscoveredTopic[]
}

export interface RunWatchResponse {
  success: boolean
  processed: number
  created: number
  bumped: number
  skipped: number
  errors: string[]
}

export interface PatternMatch {
  id: string
  issue_summary: string
  typical_approach: string
  frequency: number
  last_seen: string
  similarity: number
}

export interface MatchPatternResponse {
  success: boolean
  matches: PatternMatch[]
}

export interface SuggestKeywordsResponse {
  success: boolean
  keywords: string[]
}

export interface SuggestTagsResponse {
  success: boolean
  tags: string[]
}

export interface AuthorityAnswer {
  text: string
  author: string | null
  badge: string | null
}

export interface AnsweredThread {
  url: string
  title: string
  category: string
  board: string
  created_at: string | null
  lastmod: string | null
  answers: AuthorityAnswer[]
  has_authority_answer: boolean
  answer_count: number
}

export interface AnsweredThreadsResponse {
  success: boolean
  keywords: string[]
  /** True when the first keyword pass found nothing and the search was widened. */
  widened: boolean
  discovered: number
  opened: number
  results: AnsweredThread[]
  errors: string[]
}

export interface SaveVerifiedResponse {
  success: boolean
  id: string
}

export interface SuggestFollowupResponse {
  success: boolean
  complaint: string
  existing_reply: string | null
  user_reply: string
  suggestion: string
}
