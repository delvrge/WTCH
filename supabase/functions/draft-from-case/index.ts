// Semi-manual reply auto-fill: when a case is marked Closed on the Cases
// screen, the operator has already resolved it by hand somewhere (their own
// reply, a screenshot session, whatever). This function does not decide
// anything was solved, the Closed status already said that. What it does is
// draft the reply text FOR the Replies screen so the operator's only step
// left is review + copy-paste to the platform, instead of typing the whole thing
// from scratch.
//
// Grounding priority, cheapest/most-authoritative first:
//   1. The case's own thread, if it has a marked Correct Answer or an
//      authority (staff/CE) reply, the case may have literally been solved
//      right there.
//   2. A solved thread elsewhere in the corpus describing the same problem
//      (same search findSolvedCases/investigate already use).
//   3. The pattern's own recorded typical_approach, if the system extracted
//      one.
// If none of the three exist, this returns success:false with a plain
// "nothing to ground a reply in" error rather than letting the model invent
// one, same rule investigate's evidence-only prompt already follows.
//
// Writes an UNVERIFIED (`verified: false`, `source: 'ai_draft'`) row to
// verified_answers, linked to the case via verified_answer_cases when the
// case is a 'pattern' row. The operator reviews/edits it on /replies and
// clicks Verify once they've confirmed it, same as any other AI draft.

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { getCorsHeaders } from '../_shared/cors.ts'
import { embedText, normalizeAndEmbed } from '../_shared/normalize-issue.ts'
import { findSolvedCases } from '../_shared/solved-cases.ts'
import { chatText } from '../_shared/ai-provider.ts'
import { PRODUCT_NAME } from '../_shared/product.ts'
import {
  citableAuthorityAnswers,
  fetchThread,
  titleTokensAnyLanguage,
} from '../_shared/community-sources.ts'

interface RequestBody {
  /** 'pattern:<uuid>' or 'verified:<uuid>', the Cases row id. */
  case_id: string
  title: string
  url: string | null
  /** community_patterns.typical_approach, when case_id is a pattern row. */
  typical_approach?: string | null
}

function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

// Same floor investigate/draft-reply use for match_verified_answers, a
// standardized reply this close to an existing one is the same underlying
// problem, so the new case gets linked to it instead of forking a duplicate.
const VERIFIED_MIN_SIMILARITY = 0.6

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

    const apiKey = Deno.env.get('GEMINI_API_KEY')
    if (!apiKey) throw new Error('AI service not configured')

    const body: RequestBody = await req.json()
    const caseId = trimmedOrNull(body.case_id)
    if (!caseId) throw new Error('case_id is required')
    const title = trimmedOrNull(body.title)
    if (!title) throw new Error('title is required')
    const url = trimmedOrNull(body.url)
    const typicalApproach = trimmedOrNull(body.typical_approach ?? null)

    const [source, rawId] = caseId.includes(':') ? caseId.split(':', 2) : [null, caseId]
    const patternId = source === 'pattern' ? rawId : null

    // ── Standardize the problem, in English, once ───────────────────────────
    // Same abstraction community_patterns/verified_answers already store ,
    // not the raw post title (which may be in any language, and is specific
    // to this one poster's wording) so that the next post with the same
    // underlying problem matches this row instead of spawning a duplicate.
    const { issueDescription: questionSummary, embedding: queryEmbedding } = await normalizeAndEmbed(title, apiKey)

    // ── Reuse an existing standardized reply if one already covers this ────
    // A reply is meant to answer every post with the same problem, not just
    // the one that happened to close it first. If a verified answer already
    // sits above the floor, link this case to it instead of forking a near-
    // duplicate row.
    const { data: existingMatches, error: matchError } = await supabaseAdmin.rpc('match_verified_answers', {
      p_user_id: userId,
      p_embedding: queryEmbedding,
      p_match_count: 1,
      p_min_similarity: VERIFIED_MIN_SIMILARITY,
    })
    if (matchError) throw matchError
    const existing = (existingMatches ?? [])[0] as { id: string; similarity: number } | undefined
    if (existing) {
      if (patternId) {
        const { error: linkError } = await supabaseAdmin
          .from('verified_answer_cases')
          .insert([{ answer_id: existing.id, pattern_id: patternId, user_id: userId }])
        // A duplicate link (case already linked to this exact reply) is not
        // an error, same tolerance the manual "Link reply" picker has.
        if (linkError && linkError.code !== '23505') throw linkError
      }
      return new Response(
        JSON.stringify({ success: true, answer_id: existing.id, grounding: 'linked_existing' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    // ── Category/subcategory off the linked pattern's own fixed taxonomy ───
    let category: string | null = null
    let subcategory: string | null = null
    if (patternId) {
      const { data: pattern } = await supabaseAdmin
        .from('community_patterns')
        .select('topic, subtopic')
        .eq('id', patternId)
        .maybeSingle()
      if (pattern) {
        category = trimmedOrNull(pattern.topic)
        subcategory = trimmedOrNull(pattern.subtopic)
      }
    }

    // ── Gather grounding, cheapest/most-authoritative first ────────────────
    type Grounding = { kind: 'thread_answer' | 'solved_thread' | 'pattern'; label: string; text: string }
    let grounding: Grounding | null = null

    if (url) {
      try {
        const thread = await fetchThread(url)
        const authority = citableAuthorityAnswers(thread)[0]
        if (authority) {
          grounding = {
            kind: 'thread_answer',
            label: `this thread's own answer (${authority.author ?? 'staff/CE'})`,
            text: authority.text,
          }
        }
      } catch {
        // Non-fatal, falls through to the solved-thread search below.
      }
    }

    if (!grounding) {
      try {
        const keywords = titleTokensAnyLanguage(title)
        const fullTextEmbedding = await embedText(title, apiKey)
        const solvedResult = await findSolvedCases(supabaseAdmin, userId, fullTextEmbedding, {
          excludeUrl: url,
          keywords,
          apiKey,
        })
        const best = solvedResult.cases[0]
        if (best) {
          grounding = {
            kind: 'solved_thread',
            label: `a solved thread on the same problem (${best.url})`,
            text: best.answer.text,
          }
        }
      } catch {
        // Non-fatal, falls through to the pattern fallback below.
      }
    }

    if (!grounding && typicalApproach) {
      grounding = { kind: 'pattern', label: 'the fix recorded for this case', text: typicalApproach }
    }

    if (!grounding) {
      throw new Error('No solved thread, answered reply, or recorded fix to draft a reply from. Write this one by hand.')
    }

    // ── Synthesize the customer-facing reply ────────────────────────────────
    const systemPrompt = `You write a short, friendly customer-facing reply for a ${PRODUCT_NAME} Community Manager to send on a forum post. The post is already resolved; you are writing the reply text that explains the fix and closes it out.

The ONLY fact you may state is the one given below. Do not invent steps, do not add caveats that aren't in the source, do not pad with generic troubleshooting.

WHAT ACTUALLY FIXED IT (${grounding.label}):
${grounding.text}

Rules:
- Write in English, always, even when the post or the fix source above is in another language. Translate, don't quote the original wording.
- Plain, warm, professional support voice. No corporate filler ("We appreciate your patience").
- State the fix plainly, in the customer's terms, as something they can follow.
- 2 to 5 sentences. No greeting, no sign-off, no "Best regards", the operator adds those.
- Never use an em dash (—); use a period, comma, or "and" instead.

Respond with ONLY the reply text, nothing else.`

    const replyText = (await chatText({
      apiKey,
      systemPrompt,
      userContent: `THE POST:\n${title}\n\nTHE PROBLEM (standardized):\n${questionSummary}`,
      temperature: 0.3,
    })).trim()
    if (!replyText) throw new Error('No response from AI')

    const { data: saved, error: saveError } = await supabaseAdmin
      .from('verified_answers')
      .insert([{
        user_id: userId,
        category,
        subcategory,
        question_summary: questionSummary,
        answer_text: replyText,
        source_note: `AI draft from closed case, grounded in ${grounding.label}`,
        source_url: url,
        verified: false,
        source: 'ai_draft',
        embedding: queryEmbedding,
      }])
      .select('id')
      .single()
    if (saveError) throw saveError
    if (!saved) throw new Error('Save failed.')

    if (patternId) {
      const { error: linkError } = await supabaseAdmin
        .from('verified_answer_cases')
        .insert([{ answer_id: saved.id, pattern_id: patternId, user_id: userId }])
      if (linkError) throw linkError
    }

    return new Response(
      JSON.stringify({ success: true, answer_id: saved.id, grounding: grounding.kind }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'An error occurred' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
