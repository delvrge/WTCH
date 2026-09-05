import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { getCorsHeaders } from '../_shared/cors.ts'
import { COMMUNITY_TAGS } from '../_shared/tags.ts'
import { chatJSON } from '../_shared/ai-provider.ts'
import { PRODUCT_NAME } from '../_shared/product.ts'

// Advisory only: reads one pattern's issue_summary/typical_approach and
// suggests which of the community platform's fixed tags (COMMUNITY_TAGS)
// apply. Never writes anything, the operator reviews and saves the tags
// themselves from PatternDetail, same as every other AI suggestion in this
// tool.

interface RequestBody {
  pattern_id: string
}

interface PatternRow {
  issue_summary: string
  typical_approach: string
  surface: string | null
}

function buildSystemPrompt(): string {
  return `You tag a community forum post about ${PRODUCT_NAME} with the tags that apply to it, out of this FIXED list, you may only use tags from this exact list, copied verbatim, never invent or rephrase one:

${COMMUNITY_TAGS.map((t) => `- ${t}`).join('\n')}

You are given the post's issue summary, typical resolution approach, and (if known) which product surface it involves. Pick every tag that genuinely applies, usually 1-4. Prefer the more specific tag over a vague one when both could fit. Only use a generic catch-all tag (e.g. "General", "How To") when nothing more specific fits.

Respond with ONLY a JSON object: { "tags": string[] }`
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
    const patternId = typeof body.pattern_id === 'string' ? body.pattern_id.trim() : ''
    if (!patternId) throw new Error('pattern_id is required')

    const apiKey = Deno.env.get('GEMINI_API_KEY')
    if (!apiKey) throw new Error('AI service not configured')

    const { data: pattern, error: patternError } = await supabaseAdmin
      .from('community_patterns')
      .select('issue_summary, typical_approach, surface')
      .eq('id', patternId)
      .single()
    if (patternError) throw patternError
    const patternRow = pattern as PatternRow
    if (!patternRow) throw new Error('Pattern not found')

    const userContent = JSON.stringify({
      issue_summary: patternRow.issue_summary,
      typical_approach: patternRow.typical_approach,
      surface: patternRow.surface,
    })

    const rawContent = await chatJSON({
      apiKey,
      systemPrompt: buildSystemPrompt(),
      userContent,
      temperature: 0.2,
    })

    let parsed: { tags?: unknown }
    try {
      parsed = JSON.parse(rawContent)
    } catch {
      throw new Error('AI returned unparseable JSON')
    }

    // The model's picks are a claim, not a fact, anything not an exact,
    // case-sensitive match to the fixed list is dropped rather than passed
    // through, since a near-miss tag is meaningless on the real board.
    const allowed = new Set(COMMUNITY_TAGS)
    const raw = Array.isArray(parsed.tags) ? parsed.tags : []
    const tags = [...new Set(raw.filter((t): t is string => typeof t === 'string' && allowed.has(t)))]

    return new Response(
      JSON.stringify({ success: true, tags }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )

  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'An error occurred' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
