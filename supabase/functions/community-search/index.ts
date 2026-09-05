import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { getCorsHeaders } from '../_shared/cors.ts'
import { discoverTopics, fetchThread } from '../_shared/community-sources.ts'

// Shared team tool. Read-only toward the outside world: it issues HTTP
// GET to COMMUNITY_HOST and nothing else. It never posts, replies, submits
// or authenticates anywhere, and takes no action on the user's behalf.
//
// Auth shape: Bearer token -> auth.getUser(). A separate service-role
// client is used for DB work.
//
// Makes no Gemini call — this is a thin wrapper over the source helpers.

interface DiscoverRequestBody {
  mode: 'discover'
  keywords: string[]
  categories?: string[]
  limit?: number
}

interface ThreadRequestBody {
  mode: 'thread'
  url: string
}

type RequestBody = DiscoverRequestBody | ThreadRequestBody

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
    // Service-role client, kept for preamble parity with the other functions.
    // This endpoint reads and writes nothing in the database.
    const _supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)

    const body: RequestBody = await req.json()

    if (body.mode === 'discover') {
      const { keywords, categories, limit } = body
      if (!Array.isArray(keywords) || keywords.length === 0) {
        throw new Error('keywords must be a non-empty array')
      }
      const topics = await discoverTopics(keywords, categories, limit)
      return new Response(
        JSON.stringify({ success: true, topics }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    if (body.mode === 'thread') {
      const { url } = body
      if (typeof url !== 'string' || !url.trim()) throw new Error('url is required')
      const thread = await fetchThread(url)
      return new Response(
        JSON.stringify({ success: true, thread }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    throw new Error('mode must be "discover" or "thread"')

  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'An error occurred' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
