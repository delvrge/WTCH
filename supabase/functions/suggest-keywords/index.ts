import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { getCorsHeaders } from '../_shared/cors.ts'
import { loadGrounding } from '../_shared/grounding.ts'
import { chatJSON } from '../_shared/ai-provider.ts'
import { PRODUCT_NAME } from '../_shared/product.ts'

interface RequestBody {
  watch_id: string
}

interface WatchRow {
  id: string
  title: string
  keywords: string[] | null
}

interface PatternRow {
  issue_summary: string
  surface: string | null
}

// `groundingBlock`, when present, is prepended verbatim so the model reads
// the authoritative sources first and treats everything after them — the
// pattern sample below included — as signal only.
function buildSystemPrompt(hasPatterns: boolean, groundingBlock?: string): string {
  const base = `You generate search keywords used to find community forum threads about a specific topic in the ${PRODUCT_NAME} community. Keywords are matched against thread titles and URL slugs.

Return 5-12 lowercase single-or-two-word search keywords likely to match community thread titles about this topic. Include obvious synonyms, singular/plural variants, and common misspellings users actually type (e.g. for "Credits": credits, credit, generative credits, out of credits, credit refund).

Keywords must be plain search terms only — no punctuation, no quotes, no boolean operators, all lowercase.`

  const prompt = !hasPatterns
    ? `${base}

Derive the keywords purely from the watch title.

Respond with ONLY a JSON object: { "keywords": string[] }`
    : `${base}

You are also given a sample of existing abstracted patterns already found for this watch (issue_summary, surface). Mine the recurring vocabulary users actually used in those patterns so the keyword set gets sharper, in addition to deriving from the title.

Respond with ONLY a JSON object: { "keywords": string[] }`

  return groundingBlock ? `${groundingBlock}\n\n${prompt}` : prompt
}

function normalizeKeyword(k: string): string {
  return k.trim().toLowerCase().replace(/["'.,;:!?]/g, '').replace(/\s+/g, ' ')
}

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

    const body: RequestBody = await req.json()
    const { watch_id } = body
    if (typeof watch_id !== 'string' || !watch_id.trim()) throw new Error('watch_id is required')

    const apiKey = Deno.env.get('GEMINI_API_KEY')
    if (!apiKey) throw new Error('AI service not configured')

    // ── Load the watch, owned by the caller ─────────────────────────────────
    const { data: watch, error: watchError } = await supabaseAdmin
      .from('community_watches')
      .select('id, title, keywords')
      .eq('id', watch_id)
      .single()
    if (watchError) throw watchError
    const watchRow = watch as WatchRow
    if (!watchRow) throw new Error('Watch not found')

    // ── Load up to 40 existing patterns for this watch, if any ──────────────
    const { data: patterns, error: patternsError } = await supabaseAdmin
      .from('community_patterns')
      .select('issue_summary, surface')
      .eq('watch_id', watch_id)
      .limit(40)
    if (patternsError) throw patternsError

    const patternRows = (patterns ?? []) as PatternRow[]
    const hasPatterns = patternRows.length > 0

    // ── Grounding: verified answers + reference docs lead the prompt ────────
    const grounding = await loadGrounding(supabaseAdmin, userId, { watchId: watch_id })

    // ── Ask the model for keywords in one call ───────────────────────────────
    const systemPrompt = buildSystemPrompt(hasPatterns, grounding.block)
    const userContent = JSON.stringify({
      title: watchRow.title,
      patterns: hasPatterns
        ? patternRows.map((p) => ({ issue_summary: p.issue_summary, surface: p.surface }))
        : undefined,
    })

    const rawContent = await chatJSON({
      apiKey,
      systemPrompt,
      userContent,
      temperature: 0.3,
    })

    let parsed: { keywords: string[] }
    try {
      parsed = JSON.parse(rawContent)
    } catch {
      throw new Error('AI returned unparseable JSON')
    }
    if (!Array.isArray(parsed.keywords) || parsed.keywords.length === 0) {
      throw new Error('AI response missing keywords')
    }

    const keywords = Array.from(
      new Set(
        parsed.keywords
          .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
          .map(normalizeKeyword)
          .filter((k) => k.length > 0),
      ),
    )
    if (keywords.length === 0) throw new Error('AI response has no usable keywords')

    // ── Persist: replace this watch's keywords ───────────────────────────────
    const { error: updateError } = await supabaseAdmin
      .from('community_watches')
      .update({ keywords })
      .eq('id', watch_id)
    if (updateError) throw updateError

    return new Response(
      JSON.stringify({ success: true, keywords }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )

  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'An error occurred' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
