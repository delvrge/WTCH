import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { getCorsHeaders } from '../_shared/cors.ts'
import { embed } from '../_shared/ai-provider.ts'

// Writes one reply the operator actually sent, and that actually worked, into
// verified_answers. That table is the highest authority in the grounding
// bundle, so this is the whole feedback loop: what is saved here outranks the
// reference docs and the forum text on every later extraction and synthesis.
//
// It writes to this project's own database only. It never sends the reply
// anywhere, posting to the community is the operator's manual action.

interface RequestBody {
  reply_text: string
  /** Rich HTML for reply_text, when the Replies editor's content actually carries formatting (bold/lists/links/inline images/etc). Null/omitted keeps the row plain, same as every reply saved before this existed. */
  answer_html?: string | null
  question_summary: string
  watch_id?: string | null
  /** community_patterns rows this reply answers, a reply can cover several cases (verified_answer_cases join table). The first id in the list fills in watch_id/source_url whenever those weren't given separately, same precedence the single pattern_id field used to have. Undefined leaves existing links untouched (an edit that doesn't mention linking shouldn't wipe it); [] explicitly clears all links. */
  pattern_ids?: string[]
  category?: string | null
  subcategory?: string | null
  source_note?: string | null
  source_url?: string | null
  /** Whether this grounds/gets cited in future drafts. Defaults true, off makes it a plain record (mirrors verified_answers.verified's DB default). Every call site reaching this function is itself a human action (a click, or the manual-entry form), so a human-saved row is verified by definition; stage-ai-drafts writes its own unverified rows directly, bypassing this function. */
  verified?: boolean
  /** Which path wrote this row. Defaults 'manual', every caller of this function is a human action. */
  source?: 'manual' | 'ai_draft'
  /** When set, re-embeds and updates this existing row instead of inserting a new one. */
  id?: string
}

function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const apiKey = Deno.env.get('GEMINI_API_KEY')

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const token = authHeader.slice(7)
  const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
  const { data: { user }, error: userError } = await supabaseAuth.auth.getUser()
  if (userError || !user) {
    return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const userId = user.id

  try {
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)

    // ── Single-user gate ────────────────────────────────────────────────────
    const ALLOWED_USER_ID = Deno.env.get('ALLOWED_USER_ID')
    if (!ALLOWED_USER_ID || userId !== ALLOWED_USER_ID) {
      return new Response(
        JSON.stringify({ success: false, error: 'Not authorized.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const body: RequestBody = await req.json()

    const answerText = trimmedOrNull(body.reply_text)
    if (!answerText) throw new Error('reply_text is required')
    const questionSummary = trimmedOrNull(body.question_summary)
    if (!questionSummary) throw new Error('question_summary is required')
    const updateId = trimmedOrNull(body.id)

    // ── Resolve the referenced rows, and drop any that are not the caller's.
    // The FK is ON DELETE SET NULL, so a null here is a valid row, not an
    // error. community_clusters itself is retired (fixed 9-topic/27-subtopic
    // taxonomy replaces it, see lib/topic-taxonomy.ts), subcategory falls
    // back to the linked pattern's fixed subtopic instead of cluster.label,
    // resolved below once pattern_ids are validated.
    let subcategory = trimmedOrNull(body.subcategory)

    let watchId: string | null = null
    let category = trimmedOrNull(body.category)
    const requestedWatchId = trimmedOrNull(body.watch_id)
    if (requestedWatchId) {
      const { data: watch, error: watchError } = await supabaseAdmin
        .from('community_watches')
        .select('id, title, categories')
        .eq('id', requestedWatchId)
        .maybeSingle()
      if (watchError) throw watchError
      if (watch) {
        watchId = watch.id
        if (!category) category = trimmedOrNull(watch.categories?.[0]) ?? trimmedOrNull(watch.title)
      }
    }

    // Validate every requested pattern_id belongs to this user (dropping any
    // that don't, rather than failing the whole save over one bad id), same
    // trust-but-verify the single pattern_id field used to get. The first
    // valid one fills in watch_id/source_url whenever those weren't already
    // resolved above, same precedence category/subcategory has against
    // watch above.
    let sourceUrl = trimmedOrNull(body.source_url)
    let patternIds: string[] | undefined
    const requestedPatternIds = Array.isArray(body.pattern_ids)
      ? [...new Set(body.pattern_ids.map(id => trimmedOrNull(id)).filter((id): id is string => Boolean(id)))]
      : undefined
    if (requestedPatternIds !== undefined) {
      if (requestedPatternIds.length) {
        const { data: patterns, error: patternError } = await supabaseAdmin
          .from('community_patterns')
          .select('id, watch_id, source_url, subtopic')
          .in('id', requestedPatternIds)
        if (patternError) throw patternError
        patternIds = (patterns ?? []).map(p => p.id)
        const first = patterns?.[0]
        if (first) {
          if (!watchId) watchId = first.watch_id
          if (!sourceUrl) sourceUrl = trimmedOrNull(first.source_url)
          // The pattern's fixed subtopic is the finest-grained taxonomy this
          // tool has now (replaces the old cluster.label fallback).
          if (!subcategory) subcategory = trimmedOrNull(first.subtopic)
        }
      } else {
        patternIds = []
      }
    }

    const verified = typeof body.verified === 'boolean' ? body.verified : true
    const source = body.source === 'ai_draft' ? 'ai_draft' : 'manual'
    const answerHtml = trimmedOrNull(body.answer_html)

    // Embeds question_summary so draft-reply can retrieve this row by semantic
    // similarity (match_verified_answers RPC) instead of keyword overlap.
    // A failed embedding call must not block saving the verified answer
    // itself, it just leaves embedding null, same as a pre-migration row,
    // and gets picked up by the backfill script later.
    let embedding: number[] | null = null
    if (apiKey) {
      try {
        embedding = await embed({ apiKey, text: questionSummary })
      } catch (embedError) {
        console.warn('embedding request failed:', embedError)
      }
    }

    let saveError: { message: string } | null
    let saved: { id: string } | null

    if (updateId) {
      // A partial patch: watch_id/source_url are only touched when the
      // request actually named one, so editing just the text (the Replies
      // screen's edit form, which has no notion of these relationships)
      // never wipes out a link the row already had. pattern_ids/case links
      // are handled separately below, after the row itself is saved.
      const patch: Record<string, unknown> = {
        category,
        subcategory,
        question_summary: questionSummary,
        answer_text: answerText,
        answer_html: answerHtml,
        source_note: trimmedOrNull(body.source_note),
        verified,
        embedding,
      }
      if (body.watch_id !== undefined) patch.watch_id = watchId
      if (body.source_url !== undefined) patch.source_url = sourceUrl
      // Editing text is still an edit, not a re-origination, only stamp
      // `source` when the caller explicitly named one.
      if (body.source !== undefined) patch.source = source

      const res = await supabaseAdmin
        .from('verified_answers')
        .update(patch)
        .eq('id', updateId)
        .select('id')
        .single()
      saved = res.data
      saveError = res.error
    } else {
      const res = await supabaseAdmin
        .from('verified_answers')
        .insert([{
          user_id: userId,
          watch_id: watchId,
          category,
          subcategory,
          question_summary: questionSummary,
          answer_text: answerText,
          answer_html: answerHtml,
          source_note: trimmedOrNull(body.source_note),
          source_url: sourceUrl,
          verified,
          source,
          embedding,
        }])
        .select('id')
        .single()
      saved = res.data
      saveError = res.error
    }
    if (saveError) throw saveError
    if (!saved) throw new Error('Save failed.')
    const savedId = saved.id

    // Sync verified_answer_cases to the requested set, undefined (the
    // caller never mentioned linking, e.g. an in-place text-only edit)
    // leaves existing links alone; [] explicitly clears every link; a
    // non-empty list replaces the set (delete what's no longer there,
    // insert what's new). Delete-then-insert rather than a diff: at
    // single-user volume the extra round trip doesn't matter, and it can
    // never leave a stale link behind on a partial failure the way a diff
    // that skips unchanged rows could.
    if (patternIds !== undefined) {
      const { error: unlinkError } = await supabaseAdmin
        .from('verified_answer_cases')
        .delete()
        .eq('answer_id', savedId)
      if (unlinkError) throw unlinkError

      if (patternIds.length) {
        const { error: linkError } = await supabaseAdmin
          .from('verified_answer_cases')
          .insert(patternIds.map(patternId => ({
            answer_id: savedId,
            pattern_id: patternId,
            user_id: userId,
          })))
        if (linkError) throw linkError
      }
    }

    return new Response(
      JSON.stringify({ success: true, id: savedId }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )

  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'An error occurred' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
