import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { getCorsHeaders } from '../_shared/cors.ts'
import { fetchThread } from '../_shared/community-sources.ts'

// The bell's poller. Called from the browser (Bell.tsx), not a cron — the
// operator's own login session drives it, same auth path as every other
// button in the app, so it never depends on the Vault service-role secret
// the crawl-support-docs cron has been stuck on.
//
// For every tracked case sitting in 'awaiting_reply' or 'cm_replied_waiting'
// with a resolvable thread link, re-fetches the thread and compares its
// non-staff answer count to the count last seen (case_status.last_reply_count).
// A rising count means someone (the original poster, not platform staff) replied
// since the last check — this alone flips status to 'user_replied', no manual
// "CM replied" step required first. Sending your own reply happens by hand,
// outside this app, so there's no reliable signal to gate on besides the OP's
// own reply landing.
//
// Read-only toward the platform, same as every other fetch in this app — this only
// ever GETs a thread page, never posts.

const DEFAULT_LIMIT = 60

interface PatternRow {
  id: string
  source_url: string | null
  source_urls: string[] | null
}

interface VerifiedRow {
  id: string
  source_url: string | null
}

interface CaseStatusRow {
  case_id: string
  status: string
  url: string | null
  last_reply_count: number
}

function derivedPatternUrl(p: PatternRow): string | null {
  if (p.source_url) return p.source_url
  if (p.source_urls?.length) return p.source_urls[p.source_urls.length - 1]
  return null
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

    let limit = DEFAULT_LIMIT
    try {
      const body = await req.json()
      if (typeof body?.limit === 'number' && body.limit > 0) limit = Math.floor(body.limit)
    } catch {
      // No body / not JSON — use the default limit.
    }

    // ── Load the tracked, still-open cases worth polling ────────────────────
    const { data: statusRows, error: statusError } = await supabaseAdmin
      .from('case_status')
      .select('case_id, status, url, last_reply_count')
      .in('status', ['awaiting_reply', 'cm_replied_waiting'])
      .limit(limit)
    if (statusError) throw statusError

    const cases = (statusRows ?? []) as CaseStatusRow[]

    const patternIds = cases
      .filter(c => c.case_id.startsWith('pattern:'))
      .map(c => c.case_id.slice('pattern:'.length))
    const verifiedIds = cases
      .filter(c => c.case_id.startsWith('verified:'))
      .map(c => c.case_id.slice('verified:'.length))

    const patternsById = new Map<string, PatternRow>()
    if (patternIds.length) {
      const { data, error } = await supabaseAdmin
        .from('community_patterns')
        .select('id, source_url, source_urls')
        .in('id', patternIds)
      if (error) throw error
      for (const p of (data ?? []) as PatternRow[]) patternsById.set(p.id, p)
    }

    const verifiedById = new Map<string, VerifiedRow>()
    if (verifiedIds.length) {
      const { data, error } = await supabaseAdmin
        .from('verified_answers')
        .select('id, source_url')
        .in('id', verifiedIds)
      if (error) throw error
      for (const v of (data ?? []) as VerifiedRow[]) verifiedById.set(v.id, v)
    }

    let checked = 0
    let newReplies = 0
    let skipped = 0
    const errors: string[] = []

    for (const c of cases) {
      const [source, rawId] = c.case_id.includes(':') ? c.case_id.split(':', 2) : [null, c.case_id]
      const derivedUrl =
        source === 'pattern'
          ? derivedPatternUrl(patternsById.get(rawId) ?? { id: rawId, source_url: null, source_urls: null })
          : source === 'verified'
            ? verifiedById.get(rawId)?.source_url ?? null
            : null
      const url = c.url || derivedUrl
      if (!url) {
        skipped++
        continue
      }

      checked++
      try {
        const thread = await fetchThread(url)
        const replyCount = thread.answers.filter(a => !a.is_staff).length

        if (replyCount > c.last_reply_count) {
          newReplies++
          const nowIso = new Date().toISOString()
          const update: Record<string, unknown> = {
            last_reply_count: replyCount,
            unread_since: nowIso,
            status: 'user_replied',
            updated_at: nowIso,
          }
          const { error: updateError } = await supabaseAdmin
            .from('case_status')
            .update(update)
            .eq('case_id', c.case_id)
          if (updateError) throw updateError
        } else if (replyCount !== c.last_reply_count) {
          // Count dropped (e.g. a reply was deleted upstream) — resync the
          // baseline without touching unread_since/status.
          const { error: updateError } = await supabaseAdmin
            .from('case_status')
            .update({ last_reply_count: replyCount })
            .eq('case_id', c.case_id)
          if (updateError) throw updateError
        }
      } catch (caseErr) {
        // One bad thread must not abort the whole check.
        errors.push(`${c.case_id}: ${caseErr instanceof Error ? caseErr.message : 'Unknown error'}`)
      }
    }

    return new Response(
      JSON.stringify({ success: true, checked, newReplies, skipped, errors }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'An error occurred' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
