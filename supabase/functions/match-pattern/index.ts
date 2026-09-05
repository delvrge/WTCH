import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { getCorsHeaders } from '../_shared/cors.ts'
import { normalizeAndEmbed } from '../_shared/normalize-issue.ts'

// Takes an incoming support post, abstracts it to a generalized English issue
// description, embeds that, and returns the closest existing patterns.
//
// Read-only toward the outside world: it POSTs to the Gemini API and reads the
// user's own rows. It never posts, replies or submits anywhere, and returns
// text for the user to read and act on manually.

interface RequestBody {
  text: string
  matchCount?: number
  minSimilarity?: number
}

interface MatchResult {
  id: string
  issue_summary: string
  typical_approach: string
  frequency: number
  last_seen: string
  similarity: number
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

    // ── Single-user gate ────────────────────────────────────────────────────
    const ALLOWED_USER_ID = Deno.env.get('ALLOWED_USER_ID')
    if (!ALLOWED_USER_ID || userId !== ALLOWED_USER_ID) {
      return new Response(
        JSON.stringify({ success: false, error: 'Not authorized.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const body: RequestBody = await req.json()
    const { text, matchCount, minSimilarity } = body
    if (typeof text !== 'string' || !text.trim()) throw new Error('text is required')
    const pMatchCount = typeof matchCount === 'number' && matchCount > 0 ? Math.min(matchCount, 50) : 5
    const pMinSimilarity = typeof minSimilarity === 'number' ? minSimilarity : 0.5

    const apiKey = Deno.env.get('GEMINI_API_KEY')
    if (!apiKey) throw new Error('AI service not configured')

    // ── Abstract the incoming post, then embed it ─────────────────────────
    // Shares one implementation with every other query path (draft-reply)
    // and, through ISSUE_SUMMARY_CORE, one definition of "abstracted issue"
    // with the ingest side in pattern-extract.ts. This function used to
    // carry its own three-line variant of that prompt, which produced a
    // differently shaped summary than the one stored on
    // community_patterns.embedding and quietly depressed every similarity
    // score it computed.
    const { embedding } = await normalizeAndEmbed(text, apiKey)

    // ── Match against existing patterns for this user ───────────────────────
    const { data: matches, error: matchError } = await supabaseAdmin
      .rpc('match_community_patterns', {
        p_user_id: userId,
        p_embedding: embedding,
        p_match_count: pMatchCount,
        p_min_similarity: pMinSimilarity,
      })
    if (matchError) throw matchError

    const results: MatchResult[] = (matches ?? [])
      .sort((a: MatchResult, b: MatchResult) => b.similarity - a.similarity)

    return new Response(
      JSON.stringify({ success: true, matches: results }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )

  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'An error occurred' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
