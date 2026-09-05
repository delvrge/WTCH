// Shared extract+embed+dedup logic for turning a fetched community thread
// into an abstracted community_patterns row. Originally lived inline in
// extract-pattern/index.ts; pulled out here so run-watch/index.ts can reuse
// the exact same behavior instead of duplicating it.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import type { ThreadContent } from './community-sources.ts'
import type { GroundingBundle } from './grounding.ts'
import { snapSubtopic, snapTopic, TAXONOMY_PROMPT_BLOCK, UNCLUSTERED } from './topic-taxonomy.ts'
import { ISSUE_SUMMARY_CORE } from './normalize-issue.ts'
import { chatJSON, embed } from './ai-provider.ts'

export interface ExtractedPattern {
  issue_summary: string
  typical_approach: string
  tags: string[]
  surface: string
  severity: 'low' | 'medium' | 'high' | null
  topic: string
  subtopic: string
}

export interface ExtractPatternResult {
  action: 'inserted' | 'updated'
  id: string
}

// NOTE: `thread.body` and the assembled answers text (the raw source
// post/reply text) are used ONLY as input to the prompt below and are never
// written to the database — only the model's abstracted output
// (issue_summary / typical_approach / tags / cluster) is persisted.
// `thread.title` is the one exception: callers pass it through to
// `saveExtractedPattern` as `source_title`, stored verbatim so the Cases
// table can show the post's real title in its own language instead of an
// English abstraction. See the column comment in
// 20260819000100_pattern_source_title.sql.
//
// `groundingBlock`, when present, is prepended verbatim: it declares which
// sources may be asserted as fact and marks everything after it — including
// the thread text this function feeds in — as signal only.
function buildSystemPrompt(existingSurfaces: string[], groundingBlock?: string): string {
  const surfaceList = existingSurfaces.length
    ? existingSurfaces.map((s) => `  - ${s}`).join('\n')
    : '  (none yet — this is the first pattern for this watch)'

  const prompt = `You analyze a support forum thread and extract a GENERALIZED, ABSTRACTED support pattern from it — never verbatim text from the thread.

Rules:
- Output MUST always be in English, even if the thread is written in another language. Staff replies are always in English; use them as the primary source for the resolution approach.
- The thread TITLE is the highest-signal field for identifying what the issue actually is — weight it most heavily when writing issue_summary.
- issue_summary: ${ISSUE_SUMMARY_CORE}
- typical_approach: a short, general description of how this type of issue is typically resolved, based on the accepted/suggested answers.
  SPECIAL CASE — when the surface cannot be determined (see "surface" rule below, "unknown"): "unknown" is not a failure, it is a real triage bucket meaning the thread didn't give enough detail to identify the feature/workflow involved. In this case typical_approach must instead capture the CLARIFYING/DIAGNOSTIC QUESTIONS staff actually asked in the thread to narrow it down — e.g. which feature or workflow, the exact error text, browser/app version, whether it reproduces, job/request timestamps — and, if the replies eventually reveal it, what the issue usually turned out to be. Be specific and pull from what staff actually asked in THIS thread; do not output generic filler like "investigate further" or "ask the user for more information" with no specifics — the actual questions are the deliverable. This special case changes only how typical_approach is written; surface must still be returned as "unknown" per the rule below.
- tags: 2-6 short lowercase keyword tags categorizing the issue.
- Never use an em dash (—) anywhere in issue_summary or typical_approach; use a period, comma, or "and" instead.
- severity: how badly this blocks the user's work: "high" (cannot use the product / paid for something they cannot get / data loss), "medium" (a real problem with a workaround, or degraded but usable), "low" (cosmetic, minor confusion, or a question rather than a failure). Return null only when the thread genuinely gives no basis to judge.
- surface: a SHORT lowercase noun phrase naming what the user was doing / which feature failed (e.g. "video generation", "image generation", "image to video", "billing/credits", "account/login"). The thread TITLE is OFTEN GENERIC ("Something Went Wrong", "Help", "Bug", "Issue") and tells you nothing about which feature is involved — in those cases you MUST infer the surface from the post body and replies, never from the title alone. If it genuinely cannot be determined from the content, return "unknown".

  EXISTING SURFACE LABELS already used for this watch:
${surfaceList}

  Reuse an existing surface label verbatim whenever it fits, even loosely, and only invent a new one when truly none apply. Never reword an existing surface label. "unknown" remains the fallback when the surface genuinely cannot be determined — it is not a case for inventing a new label.
- topic and subtopic: classify this issue against the FIXED taxonomy below. Pick exactly one topic and exactly one of its subtopics, VERBATIM (exact spelling/case) — never invent, reword, or improve a topic or subtopic name; this list is locked and never grows.

${TAXONOMY_PROMPT_BLOCK}

  If the issue genuinely does not fit any topic above (e.g. pure praise, an off-topic post), return topic "${UNCLUSTERED}" and subtopic "${UNCLUSTERED}" — this is a real, honest outcome, not a failure. Do not force a fit you are not confident about.

Respond with ONLY a JSON object: { "issue_summary": string, "typical_approach": string, "tags": string[], "surface": string, "severity": "low" | "medium" | "high" | null, "topic": string, "subtopic": string }`

  return groundingBlock ? `${groundingBlock}\n\n${prompt}` : prompt
}

// Normalizes a label for cosmetic-only comparison: trim, lowercase, collapse
// internal whitespace, drop trailing punctuation.
function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:!?]+$/, '')
}

// If `value` matches an entry in `existing` once cosmetically normalized,
// snap it to that entry's exact existing spelling so a formatting variant
// never becomes a de-facto new label alongside the real one.
function snapToExisting(value: string, existing: string[]): string {
  const normalized = normalizeLabel(value)
  const match = existing.find((e) => normalizeLabel(e) === normalized)
  return match ?? value
}

// ── thread dates ─────────────────────────────────────────────────────────
// `ThreadContent.created_at` comes off the thread's JSON-LD (dateCreated for
// QAPage, datePublished for DiscussionForumPosting) and used to be discarded.
// It is now persisted, so a pattern describing a since-fixed issue cannot
// silently read as current.

/**
 * Parses a thread date into a canonical ISO string, or null when it is
 * absent or unparseable. Everything written to `source_thread_dates` goes
 * through here, so the stored array is uniformly formatted and null never
 * enters it.
 */
function parseThreadDate(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = new Date(trimmed)
  const ms = parsed.getTime()
  if (Number.isNaN(ms)) return null
  return parsed.toISOString()
}

/** Normalizes a stored `source_thread_dates` array, dropping unusable entries. */
function normalizeThreadDates(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const out: string[] = []
  for (const value of values) {
    const iso = parseThreadDate(typeof value === 'string' ? value : null)
    if (iso) out.push(iso)
  }
  return out
}

/** The NEWEST date in the array, or null when the array holds none. */
function newestThreadDate(values: string[]): string | null {
  let newest: string | null = null
  let newestMs = -Infinity
  for (const value of values) {
    const ms = new Date(value).getTime()
    if (Number.isNaN(ms)) continue
    if (ms > newestMs) {
      newestMs = ms
      newest = value
    }
  }
  return newest
}

/**
 * Runs the model extraction + embedding step against a fetched thread.
 * Does not touch the database — call `saveExtractedPattern` with the
 * result to persist it.
 *
 * Pass `opts.grounding` so the verified answers / reference sections are
 * prepended to the system prompt and the thread text is framed as signal.
 */
export async function extractPatternFromThread(
  thread: ThreadContent,
  apiKey: string,
  opts: {
    existingSurfaces?: string[]
    grounding?: GroundingBundle
  } = {},
): Promise<{ extracted: ExtractedPattern; embedding: number[] }> {
  const existingSurfaces = opts.existingSurfaces ?? []

  const answersText = thread.answers
    .map((a, i) => {
      const authorPart = a.author ? ` (by ${a.author}${a.badge ? ` — ${a.badge}` : ''})` : ''
      return `Answer ${i + 1}${authorPart}: ${a.text}`
    })
    .join('\n\n')

  const systemPrompt = buildSystemPrompt(existingSurfaces, opts.grounding?.block)
  const userContent = `TITLE: ${thread.title}\n\nORIGINAL POST:\n${thread.body}\n\nANSWERS:\n${answersText || '(no answers recorded)'}`

  const rawContent = await chatJSON({
    apiKey,
    systemPrompt,
    userContent,
    temperature: 0.3,
  })

  let extracted: ExtractedPattern
  try {
    extracted = JSON.parse(rawContent)
  } catch {
    throw new Error('AI returned unparseable JSON')
  }
  if (!extracted.issue_summary || !extracted.typical_approach || !Array.isArray(extracted.tags) || !extracted.surface || !extracted.topic || !extracted.subtopic) {
    throw new Error('AI response missing required fields')
  }
  if (extracted.severity !== 'low' && extracted.severity !== 'medium' && extracted.severity !== 'high') {
    extracted.severity = null
  }

  // Last line of defence against drift: snap the model's surface guess to an
  // existing label if it's a cosmetic variant (case/whitespace/punctuation)
  // of one already in use — genuinely new wording is left untouched and
  // becomes a new surface label. Topic/subtopic, by contrast, are validated
  // against the FIXED taxonomy, not snapped to a growing vocabulary: a value
  // that doesn't match the list exactly (case-insensitively) falls back to
  // Unclustered rather than silently drifting into a near-miss string that
  // would violate the DB's CHECK constraint.
  extracted.surface = snapToExisting(extracted.surface, existingSurfaces)
  const snappedTopic = snapTopic(extracted.topic)
  const snappedSubtopic = snappedTopic ? snapSubtopic(snappedTopic, extracted.subtopic) : null
  extracted.topic = snappedTopic ?? UNCLUSTERED
  extracted.subtopic = snappedSubtopic ?? UNCLUSTERED

  const embedding = await embed({ apiKey, text: extracted.issue_summary })

  return { extracted, embedding }
}

/**
 * Matches the extracted pattern against the user's existing patterns via
 * embedding similarity, then either bumps the existing row's frequency or
 * inserts a new one. Mirrors extract-pattern's original insert/update
 * logic exactly; `extra` lets callers (run-watch) stamp
 * watch_id/source_url/thread_created_at on newly inserted rows without
 * extract-pattern having to know about them.
 *
 * `extra.thread_created_at` is the fetched thread's own `created_at`. Pass it
 * on every call: it is appended to `source_thread_dates` exactly the way
 * `source_url` is appended to `source_urls`, and `thread_created_at` is then
 * set to the NEWEST date in that array.
 */
export async function saveExtractedPattern(
  supabaseAdmin: SupabaseClient,
  userId: string,
  extracted: ExtractedPattern,
  embedding: number[],
  extra: {
    watch_id?: string | null
    source_url?: string | null
    source_title?: string | null
    thread_created_at?: string | null
  } = {},
): Promise<ExtractPatternResult> {
  // "Something Went Wrong" failure mode: generically-titled threads can
  // describe completely different underlying issues (error while
  // generating video vs. generating an image vs. converting image to
  // video). Cosine similarity alone would collapse all three into one
  // pattern and destroy that distinction. So a candidate may only merge
  // into an existing pattern when BOTH the embedding similarity clears the
  // bar AND the two patterns agree on `surface` (case-insensitive). An
  // 'unknown' surface never matches anything — including another
  // 'unknown' — so vague, unresolved cases stay separate rather than
  // being wrongly merged together.
  const newSurface = (extracted.surface || 'unknown').trim().toLowerCase()
  const newThreadDate = parseThreadDate(extra.thread_created_at)
  const newTitle = extra.source_title?.trim() || null

  const { data: matches, error: matchError } = await supabaseAdmin
    .rpc('match_community_patterns', {
      p_user_id: userId,
      p_embedding: embedding,
      p_match_count: 5,
      p_min_similarity: 0.85,
    })
  if (matchError) throw matchError

  let existing:
    | {
      id: string
      typical_approach: string
      frequency: number
      surface: string | null
      source_urls: string[] | null
      source_thread_dates: string[] | null
      thread_created_at: string | null
      source_title: string | null
    }
    | null = null

  if (newSurface !== 'unknown' && matches?.length) {
    for (const candidate of matches) {
      const { data: fullRow, error: rowError } = await supabaseAdmin
        .from('community_patterns')
        .select('id, typical_approach, frequency, surface, source_urls, source_thread_dates, thread_created_at, source_title')
        .eq('id', candidate.id)
        .single()
      if (rowError) throw rowError
      if (fullRow.surface && fullRow.surface.trim().toLowerCase() === newSurface) {
        existing = fullRow
        break
      }
    }
  }

  if (existing) {
    // Refine typical_approach by merging existing text with the new
    // observation rather than blindly overwriting it.
    const mergedApproach = existing.typical_approach === extracted.typical_approach
      ? existing.typical_approach
      : `${existing.typical_approach} ${extracted.typical_approach}`.trim()

    const newUrl = extra.source_url ?? null
    const existingUrls = existing.source_urls ?? []
    const mergedUrls = newUrl && !existingUrls.includes(newUrl)
      ? [...existingUrls, newUrl]
      : existingUrls

    // Same append rule as source_urls, on the canonical ISO form so a value
    // already stored in Postgres' own formatting still compares equal.
    const existingDates = normalizeThreadDates(existing.source_thread_dates)
    const mergedDates = newThreadDate && !existingDates.includes(newThreadDate)
      ? [...existingDates, newThreadDate]
      : existingDates

    // thread_created_at always holds the NEWEST date in the array. Fall back
    // to the stored value only when the array is empty, so a bump can never
    // erase a date that is already there.
    const newestDate = newestThreadDate(mergedDates) ?? existing.thread_created_at ?? null

    const { error: updateError } = await supabaseAdmin
      .from('community_patterns')
      .update({
        frequency: existing.frequency + 1,
        last_seen: new Date().toISOString(),
        typical_approach: mergedApproach,
        source_urls: mergedUrls,
        source_thread_dates: mergedDates,
        thread_created_at: newestDate,
        // Content changed (bumped/refined), so any prior manual
        // confirmation no longer applies — the operator must re-verify.
        review_status: 'unreviewed',
        reviewed_at: null,
        severity: extracted.severity ?? undefined,
        // The title belongs to the thread that FIRST produced this pattern,
        // so a later bump from a different thread must not rewrite it — the
        // operator would see the case they are tracking silently retitled.
        // Only filled in when there is nothing there yet (rows created
        // before this column existed).
        source_title: existing.source_title ?? newTitle,
      })
      .eq('id', existing.id)
    if (updateError) throw updateError

    return { action: 'updated', id: existing.id }
  }

  const insertDates = newThreadDate ? [newThreadDate] : []

  const { data: inserted, error: insertError } = await supabaseAdmin
    .from('community_patterns')
    .insert([{
      user_id: userId,
      source_title: newTitle,
      issue_summary: extracted.issue_summary,
      typical_approach: extracted.typical_approach,
      tags: extracted.tags,
      embedding,
      watch_id: extra.watch_id ?? null,
      source_url: extra.source_url ?? null,
      source_urls: extra.source_url ? [extra.source_url] : [],
      source_thread_dates: insertDates,
      thread_created_at: newestThreadDate(insertDates),
      surface: newSurface,
      severity: extracted.severity,
      topic: extracted.topic,
      subtopic: extracted.subtopic,
    }])
    .select('id')
    .single()
  if (insertError) throw insertError

  return { action: 'inserted', id: inserted.id }
}
