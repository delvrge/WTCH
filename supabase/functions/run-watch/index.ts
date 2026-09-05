import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { getCorsHeaders } from '../_shared/cors.ts'
import { discoverTopics, fetchThread } from '../_shared/community-sources.ts'
import { loadGrounding } from '../_shared/grounding.ts'
import { extractPatternFromThread, saveExtractedPattern } from '../_shared/pattern-extract.ts'

// Runs one watch: discovers candidate topics, fetches each thread, extracts an
// abstracted pattern, and inserts or bumps the matching community_patterns row.
//
// Read-only toward the outside world: HTTP GET to COMMUNITY_HOST and POST
// to the Gemini API, nothing else. It never posts, replies or submits anywhere.

// Per-run cap on topics processed. Kept modest (rather than unbounded)
// because Supabase edge functions have a wall-clock execution limit and
// each topic costs one fetch plus two Gemini calls (extraction + a
// second pass). `community_seen_topics` tracks already-processed URLs so
// repeated runs resume from where the last run left off instead of
// redoing work.
const DEFAULT_RUN_LIMIT = 20
const DEFAULT_MAX_AGE_DAYS = 180

interface RequestBody {
  watch_id: string
  limit?: number
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
    const limit = typeof body.limit === 'number' && body.limit > 0 ? Math.floor(body.limit) : DEFAULT_RUN_LIMIT

    const apiKey = Deno.env.get('GEMINI_API_KEY')
    if (!apiKey) throw new Error('AI service not configured')

    // ── Load the watch (must belong to the caller) ──────────────────────────
    const { data: watch, error: watchError } = await supabaseAdmin
      .from('community_watches')
      .select('id, user_id, keywords, categories')
      .eq('id', watch_id)
      .single()
    if (watchError || !watch) {
      return new Response(
        JSON.stringify({ success: false, error: 'Watch not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    // ── Fetch the watch's existing surface vocabulary once, up front, so
    // extraction reuses stable labels instead of the LLM reinventing wording
    // per-topic (see pattern-extract.ts prompt). Topic/subtopic classify
    // against the fixed taxonomy now, not a learned vocabulary, so no query
    // is needed for them.
    const { data: vocabRows, error: vocabError } = await supabaseAdmin
      .from('community_patterns')
      .select('surface')
      .eq('watch_id', watch_id)
    if (vocabError) throw vocabError
    const existingSurfaces = [...new Set((vocabRows ?? []).map((r) => r.surface).filter((s): s is string => !!s && s.toLowerCase() !== 'unknown'))]

    // ── Grounding: verified answers + reference docs outrank forum text.
    // Loaded once per run rather than per topic, it is the same bundle for
    // every thread and each load is two DB reads.
    const grounding = await loadGrounding(supabaseAdmin, userId, { watchId: watch_id })

    let processed = 0
    let created = 0
    let bumped = 0
    let skipped = 0
    const errors: string[] = []

    try {
      // ── Discover candidate topics ──────────────────────────────────────────
      // Ask for more than `limit` since some will be filtered out as
      // already-seen below.
      const discovered = await discoverTopics(watch.keywords ?? [], watch.categories ?? [], limit * 3, DEFAULT_MAX_AGE_DAYS)

      // ── Filter out topics already processed for this watch ─────────────────
      const candidateUrls = discovered.map((t) => t.url)
      let seenUrls = new Set<string>()
      if (candidateUrls.length > 0) {
        const { data: seenRows, error: seenError } = await supabaseAdmin
          .from('community_seen_topics')
          .select('topic_url')
          .eq('watch_id', watch_id)
          .in('topic_url', candidateUrls)
        if (seenError) throw seenError
        seenUrls = new Set((seenRows ?? []).map((r) => r.topic_url))
      }

      const toProcess = discovered.filter((t) => !seenUrls.has(t.url)).slice(0, limit)
      skipped = discovered.length - toProcess.length

      // ── Process each topic, resilient to per-topic failures ─────────────────
      for (const topic of toProcess) {
        processed++

        try {
          const thread = await fetchThread(topic.url)
          const { extracted, embedding } = await extractPatternFromThread(thread, apiKey, {
            existingSurfaces,
            grounding,
          })
          // thread_created_at falls back to the sitemap's lastmod when the
          // thread page carries no JSON-LD date, so a pattern always knows how
          // old its sources are.
          const threadDate = thread.created_at ?? topic.lastmod ?? null
          const result = await saveExtractedPattern(supabaseAdmin, userId, extracted, embedding, {
            watch_id,
            source_url: topic.url,
            source_title: thread.title,
            thread_created_at: threadDate,
          })
          if (result.action === 'inserted') {
            created++
          } else {
            bumped++
          }

          const { error: seenInsertError } = await supabaseAdmin
            .from('community_seen_topics')
            .upsert([{ user_id: userId, watch_id, topic_url: topic.url }], { onConflict: 'watch_id,topic_url' })
          if (seenInsertError) {
            errors.push(`${topic.url}: processed but failed to record as seen: ${seenInsertError.message}`)
          }
        } catch (topicErr) {
          // One bad topic must not abort the whole run.
          errors.push(
            `${topic.url}: ${topicErr instanceof Error ? topicErr.message : 'Unknown error processing topic'}`,
          )
        }
      }
    } finally {
      // ── Update watch status regardless of how far the run got ───────────────
      const { count: patternCount } = await supabaseAdmin
        .from('community_patterns')
        .select('id', { count: 'exact', head: true })
        .eq('watch_id', watch_id)

      const status = errors.length > 0 && processed === 0
        ? 'error'
        : errors.length > 0
          ? 'completed_with_errors'
          : 'ok'

      await supabaseAdmin
        .from('community_watches')
        .update({
          last_run_at: new Date().toISOString(),
          last_run_status: status,
          pattern_count: patternCount ?? 0,
          updated_at: new Date().toISOString(),
        })
        .eq('id', watch_id)
    }

    return new Response(
      JSON.stringify({ success: true, processed, created, bumped, skipped, errors }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )

  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'An error occurred' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
