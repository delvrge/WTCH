// Standalone scraping helpers for the one-off topic-taxonomy analysis.
// Deliberately a separate copy from supabase/functions/_shared/community-sources.ts
// rather than a shared import: that file lives in the Deno edge-function
// project (excluded from this repo's tsconfig, own deno.lock) and is scoped
// to keyword-driven discovery with an edge-function wall-clock budget. This
// script has neither constraint — it walks every sitemap once, unscored,
// bounded only by the 1-year date cutoff and the rate limits below.
//
// Same politeness contract as the rest of this tool: GET only, same
// User-Agent, never posts/replies toward the platform.

const USER_AGENT = 'CommunityWatch/1.0'
const COMMUNITY_HOST = process.env.COMMUNITY_HOST ?? 'community.example.com'
const SITEMAP_INDEX_URL = `https://${COMMUNITY_HOST}/sitemap.xml`
const FETCH_TIMEOUT_MS = 8000

export const WATCHED_BOARDS = (process.env.WATCHED_BOARDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
export type WatchedBoard = string

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class CommunityFetchError extends Error {
  readonly status: number
  readonly url: string
  constructor(status: number, url: string) {
    super(`Fetch failed (${status}) for ${url}`)
    this.name = 'CommunityFetchError'
    this.status = status
    this.url = url
  }
}

export async function fetchText(url: string, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal })
    if (!res.ok) throw new CommunityFetchError(res.status, url)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

function extractLocs(xml: string): string[] {
  const matches = xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)
  return Array.from(matches, (m) => m[1])
}

function extractUrlEntries(xml: string): { loc: string; lastmod: string | null }[] {
  const entries: { loc: string; lastmod: string | null }[] = []
  const urlBlocks = xml.matchAll(/<url>([\s\S]*?)<\/url>/g)
  for (const block of urlBlocks) {
    const body = block[1]
    const locMatch = body.match(/<loc>\s*([^<\s]+)\s*<\/loc>/)
    if (!locMatch) continue
    const lastmodMatch = body.match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/)
    entries.push({ loc: locMatch[1], lastmod: lastmodMatch ? lastmodMatch[1] : null })
  }
  return entries
}

function parseTopicUrl(url: string): { board: string; slug: string; topicId: string } | null {
  try {
    const path = new URL(url).pathname.replace(/^\/+|\/+$/g, '')
    const parts = path.split('/')
    if (parts.length < 2) return null
    const board = parts[0]
    const topicSegment = parts[parts.length - 1]
    const idMatch = topicSegment.match(/-(\d+)$/)
    if (!idMatch) return null
    return { board, slug: topicSegment, topicId: idMatch[1] }
  } catch {
    return null
  }
}

export interface CandidateTopic {
  url: string
  board: WatchedBoard
  lastmod: string | null
}

/**
 * Walks every sitemap-topics-N.xml (newest N first) and returns every
 * watched-board topic URL whose lastmod is within `maxAgeDays` OR has no
 * lastmod at all (kept, not dropped — the per-thread scrape step re-checks
 * the real creation date from the page's own JSON-LD, which is authoritative;
 * lastmod only bounds which sitemap files are worth reading).
 *
 * Stops opening further (older) sitemap files once an entire file produces
 * zero in-window candidates — sitemap files are roughly recency-bucketed, so
 * this is a real stopping signal, not an early truncation of the current
 * file's own entries.
 */
export async function discoverAllWatchedTopics(
  maxAgeDays: number,
  sitemapDelayMs: number,
  onProgress?: (msg: string) => void,
): Promise<CandidateTopic[]> {
  const indexXml = await fetchText(SITEMAP_INDEX_URL)
  const sitemapUrls = extractLocs(indexXml).filter((u) => /sitemap-topics-\d+\.xml/.test(u))
  if (sitemapUrls.length === 0) {
    throw new Error(`No topic sitemaps found in sitemap index: ${SITEMAP_INDEX_URL}`)
  }

  const orderedSitemapUrls = [...sitemapUrls].sort((a, b) => {
    const na = Number(a.match(/sitemap-topics-(\d+)\.xml/)?.[1] ?? 0)
    const nb = Number(b.match(/sitemap-topics-(\d+)\.xml/)?.[1] ?? 0)
    return nb - na
  })

  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  const seen = new Set<string>()
  const results: CandidateTopic[] = []

  for (let i = 0; i < orderedSitemapUrls.length; i++) {
    let xml: string
    try {
      xml = await fetchText(orderedSitemapUrls[i])
    } catch (err) {
      onProgress?.(`skip sitemap ${orderedSitemapUrls[i]}: ${(err as Error).message}`)
      continue
    }

    const entries = extractUrlEntries(xml)
    let inWindowThisFile = 0

    for (const { loc: url, lastmod } of entries) {
      const parsed = parseTopicUrl(url)
      if (!parsed) continue
      if (WATCHED_BOARDS.length && !WATCHED_BOARDS.includes(parsed.board)) continue
      if (lastmod) {
        const ts = Date.parse(lastmod)
        if (!Number.isNaN(ts) && ts < cutoffMs) continue
      }
      if (seen.has(url)) continue
      seen.add(url)
      results.push({ url, board: parsed.board, lastmod })
      inWindowThisFile++
    }

    onProgress?.(
      `sitemap ${i + 1}/${orderedSitemapUrls.length}: +${inWindowThisFile} candidates (total ${results.length})`,
    )

    // Roughly-recency-bucketed sitemaps: an entire file with nothing in the
    // window (and we're past the first couple of files, which can be sparse
    // for other reasons) means we've walked past the 1-year boundary.
    if (inWindowThisFile === 0 && i >= 2) {
      onProgress?.(`stopping: sitemap ${i + 1} had zero in-window candidates`)
      break
    }

    if (i < orderedSitemapUrls.length - 1) {
      await sleep(sitemapDelayMs)
    }
  }

  return results
}

export interface ScrapedThread {
  title: string
  body: string
  created_at: string | null
}

// Pulls every JSON-LD <script> block from the page HTML.
function extractJsonLdBlocks(html: string): any[] {
  const blocks: any[] = []
  const matches = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/g)
  for (const m of matches) {
    try {
      blocks.push(JSON.parse(m[1].trim()))
    } catch {
      // Skip unparseable blocks.
    }
  }
  return blocks
}

/**
 * Fetch a topic page and pull title/body/created_at out of its QAPage or
 * DiscussionForumPosting JSON-LD block — same two schemas as the live
 * scraper (questions-404 uses QAPage, bug-reports/feature-requests use
 * DiscussionForumPosting). Only the original post is kept; replies are out
 * of scope for taxonomy clustering.
 */
export async function fetchThreadForTaxonomy(url: string): Promise<ScrapedThread> {
  const html = await fetchText(url)
  const blocks = extractJsonLdBlocks(html)

  const hasType = (b: any, t: string) =>
    b && (b['@type'] === t || (Array.isArray(b['@type']) && b['@type'].includes(t)))

  const qaBlock = blocks.find((b) => hasType(b, 'QAPage'))
  const forumBlock = blocks.find((b) => hasType(b, 'DiscussionForumPosting'))

  if (qaBlock) {
    const mainEntity = qaBlock.mainEntity
    if (!mainEntity?.name || !mainEntity?.text) {
      throw new Error(`QAPage mainEntity for ${url} is missing name/text`)
    }
    return { title: mainEntity.name, body: mainEntity.text, created_at: mainEntity.dateCreated ?? null }
  }

  if (forumBlock) {
    const title = forumBlock.headline
    const body = forumBlock.text || forumBlock.articleBody
    if (!title || !body) {
      throw new Error(`DiscussionForumPosting for ${url} is missing headline/text`)
    }
    return { title, body, created_at: forumBlock.datePublished ?? null }
  }

  throw new Error(`No QAPage or DiscussionForumPosting JSON-LD block found for ${url}`)
}
