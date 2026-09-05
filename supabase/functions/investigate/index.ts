// HTTP wrapper for the investigation walkthrough. Auth, the single-user
// gate, and request/response shape only, the feature itself lives in
// _shared/investigation.ts so it can also be run from
// scripts/preview-investigation.ts without a browser session.
//
// buildInvestigation() itself stays read-only, it never touches the
// database. This wrapper does two best-effort writes on top of it, neither
// of which may ever fail the response the operator is waiting on:
//
// 1. Auto-collect: the pasted case goes into the Library (community_patterns)
//    automatically, same extract+embed+dedup path as a manual Collect click
//    or run-watch. CORE BEHAVIOR, do not remove. When a link was pasted and
//    the thread fetched, that exact thread is collected (source_url set).
//    Otherwise (a bare title/description, or the fetch failed) the pasted
//    text itself is collected instead, with no source_url, flagged for the
//    operator to paste the real link in by hand later, but never dropped.
// 2. investigation_log: one row for the /coverage gap view (see migration
//    20260822000100).

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { getCorsHeaders } from '../_shared/cors.ts'
import { buildInvestigation } from '../_shared/investigation.ts'
import { extractPatternFromThread, saveExtractedPattern } from '../_shared/pattern-extract.ts'
import type { ThreadContent } from '../_shared/community-sources.ts'

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

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

    const body = await req.json()
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) throw new Error('text is required')
    // Library's "Rerun" re-investigates a case already sitting in
    // community_patterns, auto-collect must not touch it again (bumping
    // its frequency, re-extracting its fields) just because the operator
    // wanted a fresh walkthrough. The caller already knows the row's id.
    const skipAutoCollect = body.skip_auto_collect === true
    const knownPatternId = typeof body.pattern_id === 'string' ? body.pattern_id.trim() : ''

    const apiKey = Deno.env.get('GEMINI_API_KEY')
    if (!apiKey) throw new Error('AI service not configured')

    const result = await buildInvestigation(supabaseAdmin, userId, text, apiKey, {
      excludePatternId: knownPatternId || undefined,
    })
    const { thread, ...publicResult } = result

    // ── Auto-collect ─────────────────────────────────────────────────────
    // Best-effort: a failed collect must not lose the walkthrough the
    // operator is waiting on, only get reported as a note.
    let autoCollected: { url: string | null; pattern_id: string; action: 'inserted' | 'updated' | 'skipped' } | null = null
    const collectErrors: string[] = []
    if (skipAutoCollect) {
      // A rerun on a case that's already tracked, the id is already
      // known, so this stands in for the real collect without writing
      // anything, letting Tags still work off a real pattern_id.
      if (knownPatternId) autoCollected = { url: result.source?.url ?? null, pattern_id: knownPatternId, action: 'skipped' }
    } else try {
      // Same vocabulary lookup extract-pattern/draft-reply used to run before
      // extraction, existing surface labels for this (watchless) corpus, so
      // the model reuses "video generation" instead of inventing "video gen".
      const { data: vocabRows, error: vocabError } = await supabaseAdmin
        .from('community_patterns')
        .select('surface')
        .is('watch_id', null)
      if (vocabError) throw vocabError
      const existingSurfaces = [
        ...new Set((vocabRows ?? []).map((r) => r.surface).filter((s): s is string => !!s && s.toLowerCase() !== 'unknown')),
      ]

      const threadToCollect: ThreadContent = thread ?? { title: text, body: text, created_at: null, author: null, answers: [] }
      const extraction = await extractPatternFromThread(threadToCollect, apiKey, { existingSurfaces })
      const saved = await saveExtractedPattern(supabaseAdmin, userId, extraction.extracted, extraction.embedding, {
        source_url: result.source?.url ?? null,
        source_title: result.source?.title ?? text,
        thread_created_at: threadToCollect.created_at,
      })
      autoCollected = { url: result.source?.url ?? null, pattern_id: saved.id, action: saved.action }
    } catch (collectError) {
      collectErrors.push(`auto-collect: ${collectError instanceof Error ? collectError.message : 'failed'}`)
      console.warn('[investigate] auto-collect failed:', collectError)
    }

    // Best-effort: a coverage-gap read is not worth a failed walkthrough.
    try {
      const topPattern = result.similar[0]
      await supabaseAdmin.from('investigation_log').insert({
        user_id: userId,
        topic: topPattern?.topic ?? null,
        subtopic: topPattern?.subtopic ?? null,
        case_kind: result.investigation.case_kind,
        confidence: result.investigation.confidence,
        had_citation: result.investigation.steps.some((s) => s.cite !== null),
      })
    } catch (logError) {
      console.warn('[investigate] coverage log insert failed:', logError)
    }

    return new Response(
      JSON.stringify({
        success: true,
        ...publicResult,
        auto_collected: autoCollected,
        errors: [...publicResult.errors, ...collectErrors],
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )

  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'An error occurred' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
