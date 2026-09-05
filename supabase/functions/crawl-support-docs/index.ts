import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { getCorsHeaders } from '../_shared/cors.ts'
import {
  DOC_PATH_PREFIX,
  HOST,
  SEED_URL,
  extractDocLinks,
  extractTitle,
  fetchText,
  htmlToText,
  type SupportDocPage,
} from '../_shared/support-docs.ts'

// The wide, slow half of the support-doc pipeline. searchSupportDocs
// (_shared/support-docs.ts, called from draft-reply) used to crawl
// SUPPORT_DOCS_HOST live on the request path, which capped it at 25 pages and
// a 15s budget just to keep one draft-reply call fast. This function does
// the same kind of crawl — same HTML→text extraction, same in-tree link
// rules — but off the request path, walking hundreds of pages with no
// caller waiting on it, and upserts the result into support_docs.
// searchSupportDocs() then just reads that table.
//
// Run this manually (POST, Bearer service-role key or an authenticated
// session for ALLOWED_USER_ID — same two-caller auth shape as
// refine-clusters) or wire it to a cron job the same way refine-clusters is
// wired in 20260816000300_cluster_evolution.sql, at whatever cadence the
// operator wants the corpus refreshed.
//
// Read-only toward the outside world, same as support-docs.ts: HTTP GET to
// SUPPORT_DOCS_HOST only, never off-host, never outside SUPPORT_DOCS_PATH_PREFIX.

interface CrawlSummary {
  discovered: number
  fetched: number
  upserted: number
  skipped: number
  errors: string[]
  elapsed_ms: number
}

// Originally targeted 300-500 pages, but the isolate's own memory/compute
// ceiling turned out lower than that: a real run streaming-upserted 125
// pages cleanly (see the per-wave upsert above) and then still hit
// WORKER_RESOURCE_LIMIT mid-crawl. Dropped comfortably under that observed
// crash point rather than past it — still 4x the old request-path crawl's
// MAX_PAGES=25, and every run is idempotent (upsert on url), so raising
// this again later just needs another empirical check, not a redesign.
const MAX_PAGES = 100
// Generous relative to the old 15s request-path budget since nothing is
// waiting on this call — but still bounded, so a slow/hanging host can't
// turn this into a runaway invocation.
const DISCOVER_TIME_BUDGET_MS = 120_000
// Trimmed from 5 alongside MAX_PAGES — fewer HTML buffers alive at once
// lowers peak memory per wave, the same lever as the smaller page cap.
const CONCURRENCY = 3
// Politeness delay applied per fetch (i.e. per worker-slot), not once
// globally — the old sequential loop's DOC_FETCH_DELAY_MS, kept the same
// duration but now overlapping across CONCURRENCY workers instead of
// serializing the whole crawl behind it.
const WORKER_DELAY_MS = 300

// Extra known doc entry points beyond the single SEED_URL, for a doc tree
// deep/wide enough that BFS alone tends to miss pages — hub, get-started,
// FAQ, and troubleshooting pages found by walking the vendor's site once.
// Deployment-specific: set SUPPORT_DOCS_ADDITIONAL_SEEDS (comma-separated
// absolute URLs) as an env var. Harmless if any of these move or 404: a
// single bad seed is swallowed like any other failed fetch and just
// doesn't contribute a starting point, same as a broken link found
// mid-crawl.
const ADDITIONAL_SEEDS = (Deno.env.get('SUPPORT_DOCS_ADDITIONAL_SEEDS') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

// Tried before falling back to BFS-from-seeds. SUPPORT_DOCS_HOST's sitemap
// tree, if reachable, enumerates far more of the doc tree in one shot than
// any bounded link walk could discover on its own.
const SITEMAP_CANDIDATES = [`https://${HOST}/sitemap.xml`]
// A top-level sitemap index can point at sitemaps for the vendor's entire
// documentation domain (every product, every locale) — only follow nested
// sitemaps that look relevant to DOC_PATH_PREFIX by URL, and only up to
// this many, so one index page can't blow up the crawl into downloading
// the whole site's sitemap tree before a single doc page is fetched.
const MAX_NESTED_SITEMAPS = 10
// Bare keyword (no slashes) used to spot doc-tree-relevant nested sitemaps
// by URL, e.g. "/widgets/" -> "widgets". Falls back to matching everything
// when DOC_PATH_PREFIX has no meaningful keyword segment.
const SITEMAP_SCOPE_KEYWORD = DOC_PATH_PREFIX.replace(/\//g, '') || null

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── sitemap discovery ─────────────────────────────────────────────────────

function extractLocs(xml: string): string[] {
  return Array.from(xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g), (m) => m[1])
}

function inScope(rawUrl: string): string | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.hostname.toLowerCase() !== HOST) return null
  const path = url.pathname.toLowerCase()
  if (!path.startsWith(DOC_PATH_PREFIX) || !path.endsWith('.html')) return null
  return `https://${HOST}${url.pathname}`
}

/**
 * Best-effort sitemap walk: tries each sitemap candidate, follows a sitemap
 * index into its doc-tree-relevant nested sitemaps, and returns every
 * in-tree doc URL found. Returns an empty array (never throws) when no
 * sitemap is reachable or none of it is in scope — callers fall back to
 * BFS-from-seeds in that case, exactly as if this function didn't exist.
 */
async function discoverViaSitemap(): Promise<string[]> {
  const collected: string[] = []

  for (const sitemapUrl of SITEMAP_CANDIDATES) {
    let xml: string
    try {
      xml = await fetchText(sitemapUrl)
    } catch {
      continue
    }

    const locs = extractLocs(xml)
    if (!locs.length) continue

    if (/<sitemapindex/i.test(xml)) {
      const nested = (SITEMAP_SCOPE_KEYWORD
        ? locs.filter((u) => u.toLowerCase().includes(SITEMAP_SCOPE_KEYWORD))
        : locs
      ).slice(0, MAX_NESTED_SITEMAPS)
      for (const nestedUrl of nested) {
        try {
          collected.push(...extractLocs(await fetchText(nestedUrl)))
        } catch {
          continue
        }
      }
    } else {
      collected.push(...locs)
    }
  }

  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of collected) {
    const normalized = inScope(raw)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
    if (out.length >= MAX_PAGES) break
  }
  return out
}

// ── bounded-concurrency crawl ─────────────────────────────────────────────

interface CrawlResult {
  pageCount: number
  discovered: number
  fetched: number
  errors: number
  skipped: number
  upserted: number
  upsertErrors: string[]
}

/**
 * Wave-based worker pool: each wave pulls up to CONCURRENCY URLs off the
 * shared queue and fetches them in parallel, then feeds any newly
 * discovered in-tree links back into the same queue before the next wave —
 * bounded concurrency with the queue itself as the only shared state, so
 * there's no race between "queue looks empty" and "a sibling fetch is
 * about to add more to it" the way a naive per-worker while-loop would hit.
 *
 * Each wave's pages are upserted immediately (via `onWave`) rather than
 * collected into one array for a single upsert at the end — holding up to
 * MAX_PAGES full page texts (each potentially ~1.4MB) in memory for the
 * whole crawl is what was tripping the isolate's WORKER_RESOURCE_LIMIT
 * before a single row ever got written. Peak memory is now bounded to one
 * wave's worth (CONCURRENCY pages), not the whole crawl's.
 */
async function crawlPages(
  initialSeeds: string[],
  onWave: (pages: SupportDocPage[]) => Promise<{ upserted: number; error?: string }>,
): Promise<CrawlResult> {
  const visited = new Set<string>()
  const queued = new Set<string>(initialSeeds)
  const queue: string[] = [...queued]
  let pageCount = 0
  let errors = 0
  let skipped = 0
  let upserted = 0
  const upsertErrors: string[] = []
  const startedAt = Date.now()

  const budgetLeft = () => Date.now() - startedAt < DISCOVER_TIME_BUDGET_MS

  while (queue.length > 0 && pageCount < MAX_PAGES && budgetLeft()) {
    const batch: string[] = []
    while (batch.length < CONCURRENCY && queue.length > 0 && pageCount + batch.length < MAX_PAGES) {
      const url = queue.shift()!
      if (visited.has(url)) continue
      visited.add(url)
      batch.push(url)
    }
    if (!batch.length) break

    const results = await Promise.all(
      batch.map(async (url) => {
        try {
          const html = await fetchText(url)
          return { url, html, ok: true as const }
        } catch (err) {
          return { url, ok: false as const, message: err instanceof Error ? err.message : 'fetch failed' }
        } finally {
          // Per-worker politeness delay — applied whether the fetch
          // succeeded or failed, so a run of failures can't turn into a
          // tight retry-free hammering loop against the host.
          await sleep(WORKER_DELAY_MS)
        }
      }),
    )

    const wavePages: SupportDocPage[] = []
    for (const r of results) {
      if (!r.ok) {
        errors++
        continue
      }
      const text = htmlToText(r.html)
      if (!text) {
        skipped++
        continue
      }
      wavePages.push({ url: r.url, title: extractTitle(r.html, r.url), text })

      if (pageCount + wavePages.length < MAX_PAGES && budgetLeft()) {
        for (const link of extractDocLinks(r.html, r.url)) {
          if (!visited.has(link) && !queued.has(link)) {
            queued.add(link)
            queue.push(link)
          }
        }
      }
    }
    pageCount += wavePages.length

    if (wavePages.length) {
      const waveResult = await onWave(wavePages)
      upserted += waveResult.upserted
      if (waveResult.error) upsertErrors.push(waveResult.error)
    }
  }

  return { pageCount, discovered: queued.size, fetched: visited.size, errors, skipped, upserted, upsertErrors }
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const ALLOWED_USER_ID = Deno.env.get('ALLOWED_USER_ID')

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
  const token = authHeader.slice(7)

  // Same two-caller shape as refine-clusters: a cron job (or any other
  // service-role caller) authenticates with the service-role key directly;
  // an interactive session resolves through a real user. Both must still
  // land on the single allowed user.
  let userId: string
  if (token === serviceRoleKey) {
    if (!ALLOWED_USER_ID) {
      return new Response(JSON.stringify({ success: false, error: 'Not authorized.' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    userId = ALLOWED_USER_ID
  } else {
    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    })
    const { data: { user }, error: userError } = await supabaseAuth.auth.getUser()
    if (userError || !user) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    userId = user.id
  }

  const startedAt = Date.now()
  try {
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)

    let sitemapSeeds: string[] = []
    try {
      sitemapSeeds = await discoverViaSitemap()
    } catch {
      // discoverViaSitemap already swallows its own per-fetch errors; this
      // is only a last-resort guard so a genuinely unexpected failure still
      // degrades to seed-only BFS rather than failing the whole run.
      sitemapSeeds = []
    }

    const initialSeeds = [...new Set([SEED_URL, ...ADDITIONAL_SEEDS, ...sitemapSeeds])]

    const onWave = async (wavePages: SupportDocPage[]): Promise<{ upserted: number; error?: string }> => {
      const nowIso = new Date().toISOString()
      const { error } = await supabaseAdmin
        .from('support_docs')
        .upsert(
          wavePages.map((p) => ({ url: p.url, title: p.title, text: p.text, fetched_at: nowIso })),
          { onConflict: 'url' },
        )
      if (error) return { upserted: 0, error: `upsert wave failed: ${error.message}` }
      return { upserted: wavePages.length }
    }

    const { discovered, fetched, errors: fetchErrors, skipped, upserted, upsertErrors } =
      await crawlPages(initialSeeds, onWave)

    const errors: string[] = [...upsertErrors]
    if (fetchErrors > 0) errors.push(`${fetchErrors} page fetch(es) failed`)

    const summary: CrawlSummary = {
      discovered,
      fetched,
      upserted,
      skipped,
      errors,
      elapsed_ms: Date.now() - startedAt,
    }

    return new Response(
      JSON.stringify({ success: true, ...summary }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'An error occurred',
        elapsed_ms: Date.now() - startedAt,
      }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
