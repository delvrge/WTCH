// Source helpers for the product's official support/documentation site.
// All public pages, no auth needed.
//
// Host, doc-tree prefix and crawl seed are deployment config, not hardcoded ,
// set SUPPORT_DOCS_HOST, SUPPORT_DOCS_PATH_PREFIX and SUPPORT_DOCS_SEED_URL
// as environment variables per deployment.
//
// Unlike community-sources.ts (which reads the community sitemap + JSON-LD
// QAPage/DiscussionForumPosting blocks), doc pages carry no structured data
// for their body content, so this module reads plain HTML and reduces it to
// text itself. searchSupportDocs() is intentionally the only export most
// callers need, if the vendor ever exposes an official docs API, only the
// discovery internals below need to change.
//
// Read-only toward the outside world: HTTP GET to SUPPORT_DOCS_HOST, nothing
// else. Never POSTs, never follows a link off-host, never follows a link
// outside SUPPORT_DOCS_PATH_PREFIX.
//
// searchSupportDocs() reads the support_docs TABLE (populated off the
// request path by the crawl-support-docs edge function, on its own cron/
// manual schedule) instead of crawling live. The bounded BFS crawl below
// (discoverDocPages() and friends) is kept as-is and used only as a
// fallback for the rare case the table hasn't been crawled yet, see
// getCorpus(). Several of its pieces (fetchText, htmlToText, extractTitle,
// extractDocLinks, and the HOST/DOC_PATH_PREFIX/SEED_URL constants) are
// exported so crawl-support-docs can reuse the exact same HTML→text
import { getEnv } from './env.ts'
// extraction instead of duplicating it, keeping the two crawl paths
// text-identical.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { normalizeSlugText, scoreAgainstKeywords } from './community-sources.ts'

export const USER_AGENT = 'CommunityWatch/1.0'
export const FETCH_TIMEOUT_MS = 8000

export const HOST = getEnv('SUPPORT_DOCS_HOST') ?? 'support.example.com'
export const DOC_PATH_PREFIX = getEnv('SUPPORT_DOCS_PATH_PREFIX') ?? '/docs/'
export const SEED_URL = getEnv('SUPPORT_DOCS_SEED_URL') ?? `https://${HOST}${DOC_PATH_PREFIX}`

const SUPPORT_DOCS_TABLE = 'support_docs'
// How many DB rows to pull as candidates for a given keyword search before
// applying the same local passage-level scoring the old crawl-and-scan path
// used. Generous relative to `limit` so a good passage lower in the
// Postgres-side ranking still has a chance to win the local re-score.
const DB_CANDIDATE_LIMIT = 60

// Same politeness delay community-sources.ts applies between sitemap fetches
// (TOPIC_FETCH_DELAY_MS), applied here between doc-page fetches per the spec's
// "apply the same politeness delay to the support-doc host" requirement.
const DOC_FETCH_DELAY_MS = 300

// Bounded discovery: a hard page cap and a wall-clock budget, the same shape
// as community-sources.ts's MAX_TOPIC_SITEMAPS / DISCOVER_TIME_BUDGET_MS ,
// stop scanning and return whatever was collected rather than risk pushing an
// invocation into a 546 WORKER_LIMIT, and never walk the whole domain.
const MAX_PAGES = 25
const DISCOVER_TIME_BUDGET_MS = 15000

// The discovery result is cached in module scope so a warm isolate reuses it
// across requests instead of re-walking SUPPORT_DOCS_HOST on every draft. This
// is extra politeness on top of the bounded discovery above, not a
// substitute for it, a cold isolate still fetches fresh, still bounded the
// same way.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 6 hours

const DEFAULT_SEARCH_LIMIT = 5
const EXCERPT_CHARS = 700
// Skip trivially short lines (nav crumbs, single-word labels, button text)
// when picking passages, they are never a useful citation source.
const MIN_PASSAGE_CHARS = 40

export interface SupportDocPage {
  url: string
  title: string
  text: string
}

/** One matched passage, ready to show the user and to feed a grounding block. */
export interface SupportDocMatch {
  url: string
  title: string
  /** The best-matching passage from the page, trimmed for display. */
  excerpt: string
  /**
   * The full plain text of the source page. Citation verification checks a
   * model's quoted excerpt against THIS, not against the (possibly
   * truncated) `excerpt` above, a quote just has to be verbatim somewhere
   * in the page, not inside the specific passage we chose to display.
   */
  pageText: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function fetchText(url: string, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal })
    if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${url}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

// ── HTML → text ─────────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name] ?? m)
}

// Chrome regions that are never real documentation content, dropped whole,
// tag and contents, before anything else runs.
const CHROME_BLOCK_RE = /<(script|style|nav|header|footer|aside|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi
// Block-level tags become line breaks so paragraph structure survives tag
// stripping, searchSupportDocs() splits passages on these breaks.
const BLOCK_TAG_RE = /<\/?(p|div|li|ul|ol|br|h[1-6]|section|article|tr|table|blockquote)\b[^>]*>/gi

/** Reduces a doc page's raw HTML to plain text, one passage per line. */
export function htmlToText(html: string): string {
  let text = html.replace(CHROME_BLOCK_RE, '\n')
  text = text.replace(BLOCK_TAG_RE, '\n')
  text = text.replace(/<[^>]+>/g, ' ')
  text = decodeEntities(text)
  const lines = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
  return lines.join('\n')
}

/** Page title from <title>, with a trailing " | Site Name" suffix dropped. */
export function extractTitle(html: string, url: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!match) return url
  const raw = decodeEntities(match[1]).replace(/\s+/g, ' ').trim()
  if (!raw) return url
  const pipeIdx = raw.indexOf('|')
  const trimmed = pipeIdx > 0 ? raw.slice(0, pipeIdx).trim() : raw
  return trimmed || raw
}

/** In-domain, in-tree `.html` links found in a page, the only ones followed onward. */
export function extractDocLinks(html: string, baseUrl: string): string[] {
  const hrefs = Array.from(html.matchAll(/<a\b[^>]*\shref=["']([^"'#]+)["']/gi), (m) => m[1])
  const seen = new Set<string>()
  const out: string[] = []
  for (const href of hrefs) {
    let url: URL
    try {
      url = new URL(href, baseUrl)
    } catch {
      continue
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue
    if (url.hostname.toLowerCase() !== HOST) continue
    const path = url.pathname.toLowerCase()
    if (!path.startsWith(DOC_PATH_PREFIX)) continue
    if (!path.endsWith('.html')) continue
    const normalized = `https://${HOST}${url.pathname}`
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

// ── bounded discovery ─────────────────────────────────────────────────────

async function discoverDocPages(): Promise<SupportDocPage[]> {
  const visited = new Set<string>()
  const queued = new Set<string>([SEED_URL])
  const queue: string[] = [SEED_URL]
  const pages: SupportDocPage[] = []
  const startedAt = Date.now()

  while (queue.length > 0 && pages.length < MAX_PAGES) {
    if (Date.now() - startedAt >= DISCOVER_TIME_BUDGET_MS) break

    const url = queue.shift()!
    if (visited.has(url)) continue
    visited.add(url)

    let html: string
    try {
      html = await fetchText(url)
    } catch {
      // One unreadable page must not abort the whole discovery walk.
      continue
    }

    const text = htmlToText(html)
    if (text) pages.push({ url, title: extractTitle(html, url), text })

    if (pages.length < MAX_PAGES && Date.now() - startedAt < DISCOVER_TIME_BUDGET_MS) {
      for (const link of extractDocLinks(html, url)) {
        if (!visited.has(link) && !queued.has(link)) {
          queued.add(link)
          queue.push(link)
        }
      }
    }

    if (queue.length > 0 && pages.length < MAX_PAGES) {
      await sleep(DOC_FETCH_DELAY_MS)
    }
  }

  return pages
}

let cachedPages: SupportDocPage[] | null = null
let cachedAt = 0
let inFlight: Promise<SupportDocPage[]> | null = null

async function getCorpus(): Promise<SupportDocPage[]> {
  const now = Date.now()
  if (cachedPages && now - cachedAt < CACHE_TTL_MS) return cachedPages
  if (inFlight) return inFlight

  inFlight = discoverDocPages()
    .then((pages) => {
      cachedPages = pages
      cachedAt = Date.now()
      return pages
    })
    .finally(() => {
      inFlight = null
    })

  return inFlight
}

// ── DB-backed corpus ───────────────────────────────────────────────────
//
// crawl-support-docs (a separate edge function, off the request path) owns
// writing to support_docs. This module only ever reads it, via the
// service-role client the caller already has (see searchSupportDocs below) ,
// no Deno.env access of its own, so this module stays safe to pull into
// tsc's type-check graph from the Next.js side (see the note on
// allowImportingTsExtensions in tsconfig.json).

/**
 * Candidate pages for a keyword search, sourced from the support_docs
 * table. Returns `null` as a sentinel meaning "table has never been
 * crawled", distinct from "crawled, but nothing matched these keywords"
 * (a plain empty array), so the caller knows to fall back to a live crawl
 * only in the former case, never on an ordinary no-match search.
 */
async function queryCandidateRows(
  client: SupabaseClient,
  lowerKeywords: string[],
): Promise<SupportDocPage[] | null> {
  const { count, error: countError } = await client
    .from(SUPPORT_DOCS_TABLE)
    .select('url', { count: 'exact', head: true })
  if (countError) throw countError
  if (!count) return null

  // Quoted-phrase OR query: each keyword (which may itself be multiple
  // words) must match as a phrase, any keyword matching is enough. Matches
  // the "whole phrase is the strongest signal, but any keyword can win"
  // spirit of scoreAgainstKeywords below, just pushed into Postgres to
  // narrow the row set before the same local re-scoring runs.
  const tsQuery = lowerKeywords.map((k) => `"${k.replace(/"/g, ' ')}"`).join(' OR ')

  const { data, error } = await client
    .from(SUPPORT_DOCS_TABLE)
    .select('url, title, text')
    .textSearch('search_vector', tsQuery, { type: 'websearch' })
    .limit(DB_CANDIDATE_LIMIT)
  if (error) throw error

  return (data ?? []).map((row) => ({ url: row.url, title: row.title, text: row.text }))
}

// ── search ──────────────────────────────────────────────────────────────

/**
 * Scores every page in `corpus` against `lowerKeywords` and returns the top
 * `limit` matches, one passage per distinct page URL, best-scoring pages
 * first. Shared by both the DB-backed path and the crawl fallback below so
 * excerpt selection behaves identically regardless of corpus source.
 */
function rankAndSlice(
  corpus: SupportDocPage[],
  lowerKeywords: string[],
  limit: number,
): SupportDocMatch[] {
  const candidates: (SupportDocMatch & { score: number })[] = []

  for (const page of corpus) {
    const passages = page.text
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => p.length >= MIN_PASSAGE_CHARS)

    let best: { passage: string; score: number } | null = null
    for (const passage of passages) {
      // Reuses community-sources.ts's slug-vs-keyword scoring: whole-phrase
      // hits score highest, then all-words-present, then partial overlap.
      // It was written for slugs but works the same way on any lowercase,
      // whitespace-normalized text blob.
      const score = scoreAgainstKeywords(normalizeSlugText(passage), lowerKeywords)
      if (score > 0 && (!best || score > best.score)) best = { passage, score }
    }

    if (best) {
      candidates.push({
        url: page.url,
        title: page.title,
        excerpt: best.passage.length > EXCERPT_CHARS
          ? `${best.passage.slice(0, EXCERPT_CHARS)}…`
          : best.passage,
        pageText: page.text,
        score: best.score,
      })
    }
  }

  candidates.sort((a, b) => b.score - a.score)
  return candidates.slice(0, limit).map(({ url, title, excerpt, pageText }) => ({ url, title, excerpt, pageText }))
}

/**
 * Given search keywords, returns the most relevant documentation passages
 * across the support-doc corpus, one passage per distinct page URL,
 * best-scoring pages first. Callers get `pageText` alongside each `excerpt`
 * so a later citation check can verify a quote against the whole page.
 *
 * Reads the support_docs table (kept fresh off the request path by
 * crawl-support-docs) rather than crawling live. Only falls back to the
 * old in-place bounded crawl when the table has never been populated at
 * all (or `client` is null), so a fresh deploy never hard-breaks
 * support-doc grounding while waiting on the first crawl run.
 */
export async function searchSupportDocs(
  client: SupabaseClient | null,
  keywords: string[],
  limit: number = DEFAULT_SEARCH_LIMIT,
): Promise<SupportDocMatch[]> {
  const lowerKeywords = keywords.map((k) => k.toLowerCase().trim()).filter(Boolean)
  if (!lowerKeywords.length) return []

  if (client) {
    try {
      const rows = await queryCandidateRows(client, lowerKeywords)
      if (rows !== null) return rankAndSlice(rows, lowerKeywords, limit)
      console.warn('[support-docs] support_docs table is empty, falling back to live crawl')
    } catch (err) {
      console.warn('[support-docs] DB query failed, falling back to live crawl:', err)
    }
  }

  let corpus: SupportDocPage[]
  try {
    corpus = await getCorpus()
  } catch (err) {
    // A failed fetch degrades to "no support docs" rather than failing the
    // whole draft, the other two sources still stand on their own.
    console.warn('[support-docs] corpus fetch failed:', err)
    return []
  }

  return rankAndSlice(corpus, lowerKeywords, limit)
}
