import { getEnv } from './env.ts'
// Source helpers for a community forum running the inSided/Gainsight
// platform. All public pages, no auth needed.
//
// Host and board scope are deployment config, not hardcoded, set
// COMMUNITY_HOST (e.g. "community.example.com") and WATCHED_BOARDS (a
// comma-separated list of board slugs) as environment variables per
// deployment. WATCHED_BOARDS empty means "no board-scoping": every board
// the sitemap covers is a candidate.
//
// discoverTopics() and fetchThread() are intentionally isolated behind this
// module so that if/when the platform exposes an official community API,
// only the bodies of these two functions need to change, callers
// (community-search, extract-pattern) are unaffected.

const USER_AGENT = 'CommunityWatch/1.0'
export const COMMUNITY_HOST = getEnv('COMMUNITY_HOST') ?? 'community.example.com'
const SITEMAP_INDEX_URL = `https://${COMMUNITY_HOST}/sitemap.xml`
const TOPIC_FETCH_DELAY_MS = 300
const DEFAULT_DISCOVER_LIMIT = 25
// Each sitemap-topics-N.xml is ~4MB; scanning up to 30 of them serially
// (fetch + regex-parse each) was blowing past the edge function's
// CPU-time/wall-clock budget (HTTP 546 WORKER_LIMIT). Capped lower, the
// candidateCap break usually kicks in well before this anyway.
const MAX_TOPIC_SITEMAPS = 8
const DEFAULT_MAX_AGE_DAYS = 180
// How many candidates to accumulate (as a multiple of `limit`) before we
// stop scanning sitemaps and sort/slice. See discoverTopics() for the
// scan-order rationale.
const CANDIDATE_MULTIPLIER = 4
// Floor on the scored pool, so ranking has something to rank.
const MIN_CANDIDATE_POOL = 600
// Per-fetch network timeout so a single slow/hanging sitemap request can't
// eat the whole invocation's wall-clock budget.
const FETCH_TIMEOUT_MS = 8000
// Hard wall-clock budget for the whole discovery scan. Once exceeded we
// stop scanning further sitemaps and return whatever candidates were
// already collected, instead of pushing the invocation into a 546.
const DISCOVER_TIME_BUDGET_MS = 15000

// A platform's sitemap commonly covers every product community it hosts,
// not just yours. WATCHED_BOARDS (comma-separated env var) is the sole
// thing scoping discovery to your boards: the first path segment of a topic
// URL must be one of these slugs. Leave unset to scan every board the
// sitemap covers.
export const WATCHED_BOARDS = (getEnv('WATCHED_BOARDS') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

export interface DiscoveredTopic {
  url: string
  category: string
  board: string
  topicId: string
  slug: string
  lastmod: string | null
  /** Keyword-overlap strength from `scoreAgainstKeywords`. Higher is better. */
  score?: number
}

export interface ThreadAnswer {
  text: string
  author: string | null
  is_staff: boolean | null
  /** The badge text behind `is_staff`, e.g. "Community Expert". */
  badge?: string | null
  /**
   * True when the asker or a moderator marked THIS reply as the solution ,
   * the green "Correct Answer" box on the page.
   *
   * Set from the QAPage `acceptedAnswer` in the page's JSON-LD. Which schema
   * a thread serves is a property of the THREAD, not of the board: most
   * bug-reports-403 threads are `DiscussionForumPosting`, whose comments carry
   * no solved flag at all, but ones with an accepted solution have been
   * observed serving QAPage on that same board. So do not assume by board.
   *
   * Read `false` as "not known to be accepted", never as "not the answer":
   * `DiscussionForumPosting` shows the green box client-side only, invisible
   * to a fetch, so a genuinely solved thread can still report `false`.
   * `is_staff` remains the usable signal in that case.
   */
  is_accepted: boolean
  /** The replier's profile URL from JSON-LD, e.g.
   *  https://community.example.com/members/janedoe-259026. Stable per person, so it
   *  identifies a CM/CE more reliably than a display name, which can change. */
  author_url?: string | null
  /**
   * The answer's own `dateCreated`/`datePublished` from JSON-LD, when
   * present. Falls back to the THREAD's date when the answer carries none ,
   * deliberately conservative: a reply is always newer than its thread, so a
   * thread-date fallback can wrongly EXCLUDE a recent reply on an old
   * thread, but can never wrongly INCLUDE a stale one. `null` only when
   * neither the answer nor the thread has a date.
   */
  created_at: string | null
  /**
   * Screenshot/attachment URLs found in the answer's real HTML body.
   *
   * The JSON-LD `text` field above is the platform's plain-text rendering and never
   * carries images. The actual formatted HTML (images included) only exists
   * in the page's React hydration data, a `data-props="..."` blob elsewhere
   * on the page keyed by the same `publicReplyId` this answer's JSON-LD
   * `url` links to via `?postid=`. See extractReplyContentById below. Only
   * ordinary https:// attachments are kept; inline `data:` URIs seen in
   * practice are decorative signature graphics, not real screenshots.
   */
  images: string[]
}

export interface ThreadContent {
  title: string
  body: string
  created_at: string | null
  author: string | null
  answers: ThreadAnswer[]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Thrown by fetchText() on a non-OK HTTP response, carrying the status code
 * so callers can tell "page gone (404), normal, sitemap went stale" apart
 * from "the platform is rate-limiting/erroring (429/5xx), worth surfacing" without
 * parsing the message string.
 */
export class CommunityFetchError extends Error {
  readonly status: number
  readonly url: string
  constructor(status: number, url: string) {
    // 508 is used for a redirect loop or hop-limit exhaustion, which has no
    // real HTTP status of its own here.
    super(status === 508 ? `Redirect loop for ${url}` : `Fetch failed (${status}) for ${url}`)
    this.name = 'CommunityFetchError'
    this.status = status
    this.url = url
  }
}

/**
 * Percent-encoded, canonical form of a url.
 *
 * Thread slugs are the post title, so any post written in Chinese, Arabic,
 * Russian or similar carries non-ASCII characters in its path. Normalizing
 * every url through the URL parser means one consistent spelling is requested
 * and compared, instead of the raw and encoded forms being treated as two
 * different addresses.
 */
function canonicalUrl(raw: string): string {
  try {
    return new URL(raw).toString()
  } catch {
    return raw
  }
}

/**
 * Reinterprets a header value that is really UTF-8 but arrived decoded as
 * Latin-1.
 *
 * HTTP header values are ISO-8859-1 per spec, so a `Location` carrying a
 * non-ASCII path comes back as mojibake: the three bytes of 我 (E6 88 91) are
 * handed over as the three characters æ, <U+0088>, <U+0091>. Percent-encoding
 * THAT produces %C3%A6%C2%88%C2%91, a different address, which redirects
 * again, mangled a little further each hop, until the runtime gives up. This
 * is the real cause of the "Maximum number of redirects (20)" failures on
 * Chinese, Arabic and Cyrillic thread titles.
 *
 * Mapping each character back to its byte and decoding as UTF-8 recovers the
 * original. Pure-ASCII values pass through untouched, and a value that
 * already contains characters above U+00FF cannot be Latin-1-decoded bytes,
 * so it is left alone.
 */
function decodeLatin1AsUtf8(value: string): string {
  if (/[^\x00-\xFF]/.test(value)) return value
  try {
    const bytes = Uint8Array.from(value, (ch) => ch.charCodeAt(0))
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return decoded
  } catch {
    // Not valid UTF-8 once reinterpreted, so it really was Latin-1.
    return value
  }
}

/** Redirect hops allowed before a fetch is treated as looping. Threads moved
 *  between boards legitimately redirect once, occasionally twice. */
const MAX_REDIRECTS = 5

/**
 * Fetches a page, following redirects by hand.
 *
 * Redirects are NOT left to the runtime. When a community manager moves a
 * thread to another board, the site 301s to the new url, and for a
 * non-ASCII slug the `Location` header carries raw UTF-8. Deno's automatic
 * redirect handling then ping-pongs between the raw and percent-encoded
 * spellings of the same address until it gives up at 20 hops, and the whole
 * fetch fails with "Maximum number of redirects reached" on a thread that is
 * perfectly reachable. Observed on a real moved thread:
 * bug-reports-403 -> questions-404 with a Chinese title.
 *
 * Following hops manually and canonicalizing each one fixes that, caps the
 * work at MAX_REDIRECTS, and turns a genuine loop into an immediate, honest
 * error instead of twenty wasted requests against someone else's server.
 */
async function fetchText(url: string, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let current = canonicalUrl(url)
    const visited = new Set<string>()

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (visited.has(current)) throw new CommunityFetchError(508, current)
      visited.add(current)

      const res = await fetch(current, {
        headers: { 'User-Agent': USER_AGENT },
        redirect: 'manual',
        signal: controller.signal,
      })

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        if (!location) throw new CommunityFetchError(res.status, current)
        // Read the body so the connection is not left dangling.
        await res.text().catch(() => undefined)
        // Repair the header's encoding BEFORE resolving it, or the mojibake
        // gets baked into a percent-encoded url that points nowhere.
        // `location` is often relative, and resolving against `current` also
        // canonicalizes it.
        current = canonicalUrl(new URL(decodeLatin1AsUtf8(location), current).toString())
        continue
      }

      if (!res.ok) throw new CommunityFetchError(res.status, current)
      return await res.text()
    }

    throw new CommunityFetchError(508, current)
  } finally {
    clearTimeout(timer)
  }
}

// Extracts <loc>...</loc> values from a sitemap XML document via regex ,
// avoids pulling in a full XML parser dependency for this simple shape.
function extractLocs(xml: string): string[] {
  const matches = xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)
  return Array.from(matches, (m) => m[1])
}

// Extracts { loc, lastmod } pairs from a sitemap XML document, one per
// <url> element. Parsed per-<url> block (not via two independent global
// regexes) so loc/lastmod pairs can't be mis-paired if entries ever go
// missing one field or the other. `lastmod` is null when absent.
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

// Parses a topic URL of the shape:
// https://<COMMUNITY_HOST>/<category-slug>-<catId>/<topic-slug>-<topicId>
export function parseTopicUrl(url: string): { category: string; slug: string; topicId: string } | null {
  try {
    const path = new URL(url).pathname.replace(/^\/+|\/+$/g, '')
    const parts = path.split('/')
    if (parts.length < 2) return null
    const category = parts[0]
    const topicSegment = parts[parts.length - 1]
    const idMatch = topicSegment.match(/-(\d+)$/)
    if (!idMatch) return null
    return { category, slug: topicSegment, topicId: idMatch[1] }
  } catch {
    return null
  }
}

/**
 * Discover topic URLs matching keywords by walking the site's sitemap
 * index, newest-first, and returns the most recently updated matches.
 *
 * Ordering/limit tradeoff: because we now sort by `lastmod` DESCENDING
 * before applying `limit`, we can no longer stop the very first moment we
 * hit `limit` matches while walking sitemaps, a later-scanned sitemap
 * could still contain newer topics than ones already collected. To keep
 * this bounded without downloading all 30 sitemaps (~120MB), we exploit
 * the fact that higher-numbered sitemap-topics-N.xml files hold newer
 * topics: scan in REVERSE order (N=30 down to 1) and stop once we've
 * collected at least `limit * CANDIDATE_MULTIPLIER` candidates, or we run
 * out of sitemaps. Only then do we sort by lastmod and slice to `limit`.
 * This is a heuristic, not a guarantee of true global recency, but given
 * the reverse scan order and a generous multiplier, it's very unlikely to
 * miss a genuinely newer match.
 *
 * NOTE: this is a sitemap-based implementation. If the platform ever exposes
 * an official search/discovery API, replace this function's body only.
 */
/**
 * Pulls the first COMMUNITY_HOST TOPIC url out of free text, or null when
 * there isn't one.
 *
 * Lets the operator paste a link where a title used to go, without adding a
 * second input: text that isn't a link falls through untouched, and a link with
 * a sentence around it still resolves. Board/profile/search urls return null on
 * purpose, only a topic can be fetched into thread content.
 */
export function extractCommunityUrl(text: string): string | null {
  const hostPattern = COMMUNITY_HOST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = text.match(new RegExp(`https?:\\/\\/${hostPattern}\\/[^\\s<>"')\\]]+`, 'gi'))
  if (!matches) return null
  for (const raw of matches) {
    // Trailing punctuation from prose ("see <url>.") is not part of the url.
    const cleaned = raw.replace(/[.,;:!?]+$/, '')
    if (parseTopicUrl(cleaned)) return cleaned
  }
  return null
}

/**
 * Slug text as words: hyphens and underscores become spaces, and the leading
 * and trailing space let callers test for whole words with `includes(' x ')`.
 */
export function normalizeSlugText(slug: string): string {
  return ` ${slug.toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()} `
}

/**
 * Word tokens straight out of arbitrary text, in whatever language it was
 * written, no translation, no stopword list. `\p{L}\p{N}` is Unicode-aware,
 * so this works the same for "cannot generate images", "no tengo acceso al
 * producto" and "не увеличивается изображение". Used alongside the
 * AI-generated (English-biased) keyword set so discovery still finds a
 * thread whose slug was never translated to English in the first place.
 */
export function titleTokensAnyLanguage(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []
  return [...new Set(words.filter((w) => w.length > 2))]
}

/**
 * How well one topic slug answers a keyword set.
 *
 * People describe the same problem with different words, so a keyword only
 * has to have all of ITS words somewhere in the slug, not adjacent, not in
 * order. "sync connector" therefore matches
 * "sync-connector-for-chat-gpt-stopped-working", and so does "connector
 * problems" via its "connector" half being present while "problems" is not…
 * which is why a partial hit scores lower than a whole one instead of being
 * thrown away. The result is a ranking, not a filter.
 */
export function scoreAgainstKeywords(slugText: string, lowerKeywords: string[]): number {
  let score = 0

  for (const keyword of lowerKeywords) {
    const words = keyword.split(/\s+/).filter(Boolean)
    if (!words.length) continue

    // Exact phrase, in order: the strongest signal available from a slug.
    if (slugText.includes(` ${words.join(' ')} `) || slugText.includes(words.join(' '))) {
      score += 3
      continue
    }

    const hits = words.filter((w) => slugText.includes(` ${w} `) || slugText.includes(` ${w}`)).length
    if (hits === words.length) {
      // Every word present, just not adjacent.
      score += 2
    } else if (hits > 0 && words.length > 1) {
      // Partial overlap still beats nothing, but must not outrank a real hit.
      score += 0.5
    }
  }

  return score
}

export async function discoverTopics(
  keywords: string[],
  categories?: string[],
  limit: number = DEFAULT_DISCOVER_LIMIT,
  maxAgeDays: number = DEFAULT_MAX_AGE_DAYS,
  // Absolute Date.now()-style deadline (epoch ms) at which the scan must
  // stop, distinct from DISCOVER_TIME_BUDGET_MS. Defaults to "start a fresh
  // budget now" for existing callers (community-search, run-watch), which
  // each make exactly one call. Callers that may invoke discoverTopics more
  // than once per request (draft-reply: two searchCommunity passes plus
  // findSelfMatchThread) pass a single shared deadline instead, so the calls
  // don't each get their own fresh 15s and stack into a 546, see
  // draft-reply/index.ts's DISCOVERY_TIME_BUDGET_MS.
  deadlineMs?: number,
): Promise<DiscoveredTopic[]> {
  const lowerKeywords = keywords.map((k) => k.toLowerCase()).filter(Boolean)
  const lowerCategories = categories?.map((c) => c.toLowerCase())

  const indexXml = await fetchText(SITEMAP_INDEX_URL)
  const sitemapUrls = extractLocs(indexXml).filter((u) => /sitemap-topics-\d+\.xml/.test(u))

  if (sitemapUrls.length === 0) {
    throw new Error(`No topic sitemaps found in sitemap index: ${SITEMAP_INDEX_URL}`)
  }

  // Scan newest sitemaps first (highest N first).
  const orderedSitemapUrls = [...sitemapUrls].sort((a, b) => {
    const na = Number(a.match(/sitemap-topics-(\d+)\.xml/)?.[1] ?? 0)
    const nb = Number(b.match(/sitemap-topics-(\d+)\.xml/)?.[1] ?? 0)
    return nb - na
  })

  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  // Ranking is only as good as the pool it ranks. `limit * CANDIDATE_MULTIPLIER`
  // is 40 for a 10-result request, which the first sitemap fills within its
  // first few thousand entries, so the scan used to stop before ever seeing
  // the topics that actually match best. The time budget below is the real
  // guard; this cap only exists to stop unbounded memory growth.
  const candidateCap = Math.max(limit * CANDIDATE_MULTIPLIER, MIN_CANDIDATE_POOL)

  const candidates: DiscoveredTopic[] = []
  const deadline = deadlineMs ?? Date.now() + DISCOVER_TIME_BUDGET_MS

  // NOTE: candidateCap is the intended early-exit, but it only fires once a
  // candidate has actually SCORED (score > 0 in the loop below). Keywords in
  // a script the target site never uses (e.g. a non-English post title ,
  // see titleTokensAnyLanguage) score 0 against every English slug, so
  // candidateCap can never be reached and the deadline below becomes the
  // ONLY exit, the scan runs to its full budget on every such call instead
  // of short-circuiting early the way a well-matching English query does.
  for (let i = 0; i < Math.min(orderedSitemapUrls.length, MAX_TOPIC_SITEMAPS); i++) {
    if (candidates.length >= candidateCap) break
    // Bail out of the scan (not the whole request) once we're eating into
    // the invocation's wall-clock budget, return partial results rather
    // than risk a 546 WORKER_LIMIT.
    if (Date.now() >= deadline) break

    let sitemapXml: string
    try {
      sitemapXml = await fetchText(orderedSitemapUrls[i])
    } catch {
      // A single missing/broken topic sitemap shouldn't abort discovery ,
      // skip it and keep going.
      continue
    }

    // Parse and discard each sitemap's XML immediately (each is ~4MB) ,
    // only the small extracted entries are retained.
    const urlEntries = extractUrlEntries(sitemapXml)
    for (const { loc: url, lastmod } of urlEntries) {
      const parsed = parseTopicUrl(url)
      if (!parsed) continue

      // Hard scope: never widen beyond WATCHED_BOARDS, regardless of what
      // `categories` narrows to below. Empty WATCHED_BOARDS means no
      // board-scoping at all.
      if (WATCHED_BOARDS.length && !WATCHED_BOARDS.includes(parsed.category)) continue

      // `categories` is an OPTIONAL further narrowing within WATCHED_BOARDS ,
      // empty/omitted means "every watched board".
      if (lowerCategories?.length && !lowerCategories.some((c) => parsed.category.toLowerCase().includes(c))) {
        continue
      }

      // Slugs are hyphenated ("cant-generate-images-with-connector"), so a
      // raw substring test can never match a multi-word keyword like "image
      // connector". Compare against a space-normalised copy instead, and
      // score rather than accept/reject: a topic hitting four keywords is a
      // better lead than one hitting a single broad term.
      const slugText = normalizeSlugText(parsed.slug)
      const score = lowerKeywords.length === 0 ? 1 : scoreAgainstKeywords(slugText, lowerKeywords)
      if (score === 0) continue

      // Age cutoff: skip stale topics, but KEEP entries with no lastmod
      // (sorted last below rather than silently dropped).
      if (lastmod) {
        const ts = Date.parse(lastmod)
        if (!Number.isNaN(ts) && ts < cutoffMs) continue
      }

      candidates.push({ url, category: parsed.category, board: parsed.category, topicId: parsed.topicId, slug: parsed.slug, lastmod, score })
    }

    if (i < orderedSitemapUrls.length - 1 && candidates.length < candidateCap) {
      await sleep(TOPIC_FETCH_DELAY_MS)
    }
  }

  // Strongest keyword overlap first, then newest; entries with no lastmod
  // sort last within their score band.
  candidates.sort((a, b) => {
    const scoreDiff = (b.score ?? 0) - (a.score ?? 0)
    if (scoreDiff !== 0) return scoreDiff
    if (!a.lastmod && !b.lastmod) return 0
    if (!a.lastmod) return 1
    if (!b.lastmod) return -1
    return Date.parse(b.lastmod) - Date.parse(a.lastmod)
  })

  return candidates.slice(0, limit)
}

// Pulls every JSON-LD <script> block from the page HTML.
function extractJsonLdBlocks(html: string): any[] {
  const blocks: any[] = []
  const matches = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/g)
  for (const m of matches) {
    try {
      blocks.push(JSON.parse(m[1].trim()))
    } catch {
      // Skip unparseable blocks, the QAPage block, if present, will still
      // be found among the others.
    }
  }
  return blocks
}

// Badge strings that mark an answer as carrying authority on the community:
// platform staff, and the recognised community roles (Community Expert /
// Professional) whose answers are the ones worth reusing. EXTRA_AUTHORITY_BADGES
// (comma-separated env var) appends any platform-specific badge text (e.g.
// a vendor's own "Staff"/"Champion" labels) on top of this generic default.
const AUTHORITY_BADGES = [
  'Community Manager',
  'Community Expert',
  'Community Professional',
  'Staff',
  'Employee',
  ...(getEnv('EXTRA_AUTHORITY_BADGES') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
]

// Operator-maintained list of known Community Managers / Community Experts,
// matched by exact name. Takes priority over the badge-proximity guess
// below. Set via the TRUSTED_AUTHORS env var (comma-separated names) ,
// empty by default. Adding a name requires redeploying the functions that
// import this module.
export const TRUSTED_AUTHORS = (getEnv('TRUSTED_AUTHORS') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

function normalizeAuthorName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

const TRUSTED_AUTHORS_NORMALIZED = new Set(TRUSTED_AUTHORS.map(normalizeAuthorName))

export function isTrustedAuthor(authorName: string | null): boolean {
  if (!authorName) return false
  return TRUSTED_AUTHORS_NORMALIZED.has(normalizeAuthorName(authorName))
}

// How old a staff (CM/CE) reply may be and still be promoted into the
// citable authority tier (see _shared/grounding.ts's [CM:...] section). The
// operator trusts platform staff replies more than their own past answers, but
// only while the guidance is still likely to be current.
export const AUTHORITY_MAX_AGE_MONTHS = 12

/**
 * Whether `createdAt` is within `AUTHORITY_MAX_AGE_MONTHS` of `now`.
 *
 * An unknown date (`null`, or a string that doesn't parse) returns `false` ,
 * unknown age is NOT citable, never assumed recent. Never throws on a
 * malformed date string.
 */
export function isRecentEnough(createdAt: string | null, now: Date = new Date()): boolean {
  if (!createdAt) return false
  const ts = Date.parse(createdAt)
  if (Number.isNaN(ts)) return false
  const cutoff = new Date(now)
  cutoff.setMonth(cutoff.getMonth() - AUTHORITY_MAX_AGE_MONTHS)
  return ts >= cutoff.getTime()
}

/**
 * Staff (CM/CE) answers on `thread` that are recent enough to be promoted
 * into the citable authority tier: `is_staff === true` (confirmed staff, not
 * merely `null`/unknown) AND within `AUTHORITY_MAX_AGE_MONTHS`.
 */
export function citableAuthorityAnswers(thread: ThreadContent): ThreadAnswer[] {
  return thread.answers.filter((a) => a.is_staff === true && isRecentEnough(a.created_at))
}

// Best-effort: look for one of the badge strings above near an author's name
// in the raw HTML. This is NOT reliable, the JSON-LD has no role field at
// all, so callers must treat `is_staff === null` as "unknown", not "false".
function guessIsStaff(html: string, authorName: string | null): boolean | null {
  if (!authorName) return null
  if (isTrustedAuthor(authorName)) return true
  const escaped = authorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const nearbyWindow = new RegExp(`${escaped}[\\s\\S]{0,200}?(${AUTHORITY_BADGES.join('|')})`, 'i')
  if (nearbyWindow.test(html)) return true
  return null
}

/**
 * The badge text found next to an author, when there is one. Same
 * best-effort matching as `guessIsStaff`, but returns the label itself so
 * the UI can show "Community Expert" rather than a generic flag.
 */
export function authorityBadge(html: string, authorName: string | null): string | null {
  if (!authorName) return null
  const escaped = authorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = html.match(new RegExp(`${escaped}[\\s\\S]{0,200}?(${AUTHORITY_BADGES.join('|')})`, 'i'))
  if (isTrustedAuthor(authorName)) return match ? match[1] : 'Community Manager'
  return match ? match[1] : null
}

// Decodes the small fixed set of HTML entities the platform's pages use when
// embedding a JSON blob inside an HTML attribute (its own quotes arrive as
// &quot;, etc.). Order matters: &amp; must be decoded last, or an
// already-escaped "&amp;quot;" would wrongly collapse to a literal quote.
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function collectReplyContent(node: unknown, byId: Map<string, string>): void {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) collectReplyContent(item, byId)
    return
  }
  const rec = node as Record<string, unknown>
  if (typeof rec.publicReplyId === 'string' && typeof rec.content === 'string') {
    byId.set(rec.publicReplyId, rec.content)
  }
  for (const value of Object.values(rec)) collectReplyContent(value, byId)
}

/**
 * Maps `publicReplyId -> raw content HTML` for every reply embedded in the
 * page's React hydration data (one or more `data-props="..."` attributes).
 * This is the only place on the page a reply's real formatted body ,
 * screenshots included, actually lives; the JSON-LD `fetchThread` otherwise
 * relies on only ever carries plain text. Best-effort: a `data-props` blob
 * that isn't valid JSON once decoded is silently skipped rather than failing
 * the whole fetch, since this is a supplementary lookup, not the primary
 * source fetchThread already works without.
 */
function extractReplyContentById(html: string): Map<string, string> {
  const byId = new Map<string, string>()
  const attrRe = /data-props="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = attrRe.exec(html))) {
    try {
      collectReplyContent(JSON.parse(decodeHtmlEntities(m[1])), byId)
    } catch {
      // Not every data-props blob on the page carries reply content (most
      // don't), an unparseable one is simply not that blob.
    }
  }
  return byId
}

// Real attachments arrive as ordinary https:// <img> tags; the large inline
// data: URIs seen in practice are decorative signature graphics/badges, not
// something worth carrying into a saved reply.
function extractImageUrls(contentHtml: string): string[] {
  const urls: string[] = []
  const imgRe = /<img[^>]*\bsrc="(https?:\/\/[^"]+)"/gi
  let m: RegExpExecArray | null
  while ((m = imgRe.exec(contentHtml))) urls.push(m[1])
  return urls
}

// The JSON-LD answer's own `url` links to the same reply via
// `?postid=<publicReplyId>#post<publicReplyId>`, the join key back into
// extractReplyContentById's map.
function replyIdFromAnswerUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null
  return url.match(/[?&]postid=(\d+)/)?.[1] ?? null
}

/**
 * Fetch a topic page and parse its QAPage JSON-LD block into structured
 * thread content.
 *
 * NOTE: this is a page-fetch-based implementation. If the platform ever exposes an
 * official thread-content API, replace this function's body only.
 */
export async function fetchThread(url: string): Promise<ThreadContent> {
  const html = await fetchText(url)
  const blocks = extractJsonLdBlocks(html)

  const hasType = (b: any, t: string) =>
    b && (b['@type'] === t || (Array.isArray(b['@type']) && b['@type'].includes(t)))

  // This platform uses two different schemas depending on the board:
  //   questions-404                     -> QAPage / Question + acceptedAnswer/suggestedAnswer
  //   bug-reports-403, feature-requests-405 -> DiscussionForumPosting + comment[]
  // Normalize both into the same ThreadContent shape.
  const qaBlock = blocks.find((b) => hasType(b, 'QAPage'))
  const forumBlock = blocks.find((b) => hasType(b, 'DiscussionForumPosting'))

  let title: string | undefined
  let body: string | undefined
  let authorName: string | null = null
  let createdAt: string | null = null
  const rawAnswers: any[] = []

  if (qaBlock) {
    const mainEntity = qaBlock.mainEntity
    if (!mainEntity || typeof mainEntity !== 'object') {
      throw new Error(`QAPage JSON-LD for ${url} has no mainEntity`)
    }
    title = mainEntity.name
    body = mainEntity.text
    if (!title || !body) {
      throw new Error(`QAPage mainEntity for ${url} is missing name/text, cannot build thread content`)
    }
    authorName = mainEntity.author?.name ?? null
    createdAt = mainEntity.dateCreated ?? null

    // acceptedAnswer is the green "Correct Answer" box. It used to be pushed
    // into the same flat array as suggestedAnswer, throwing away the single
    // highest-value signal on the page. Tagged instead.
    if (mainEntity.acceptedAnswer) {
      const accepted = Array.isArray(mainEntity.acceptedAnswer)
        ? mainEntity.acceptedAnswer
        : [mainEntity.acceptedAnswer]
      for (const a of accepted) rawAnswers.push({ ...a, __accepted: true })
    }
    if (Array.isArray(mainEntity.suggestedAnswer)) rawAnswers.push(...mainEntity.suggestedAnswer)
    else if (mainEntity.suggestedAnswer) rawAnswers.push(mainEntity.suggestedAnswer)
  } else if (forumBlock) {
    title = forumBlock.headline
    body = forumBlock.text || forumBlock.articleBody
    if (!title || !body) {
      throw new Error(`DiscussionForumPosting for ${url} is missing headline/text, cannot build thread content`)
    }
    authorName = forumBlock.author?.name ?? null
    createdAt = forumBlock.datePublished ?? null

    const comments = forumBlock.comment
    if (Array.isArray(comments)) rawAnswers.push(...comments)
    else if (comments) rawAnswers.push(comments)
  } else {
    throw new Error(`No QAPage or DiscussionForumPosting JSON-LD block found for ${url}, page structure may have changed`)
  }

  const replyContentById = extractReplyContentById(html)

  const answers: ThreadAnswer[] = rawAnswers
    .filter((a) => a && typeof a.text === 'string')
    .map((a) => {
      const aAuthor: string | null = a.author?.name ?? null
      // The answer/comment's own date, when JSON-LD carries one; otherwise
      // fall back to the thread's date (see ThreadAnswer.created_at doc).
      const ownDate: string | null = a.dateCreated ?? a.datePublished ?? null
      const replyId = replyIdFromAnswerUrl(a.url)
      const content = replyId ? replyContentById.get(replyId) : undefined
      return {
        text: a.text,
        author: aAuthor,
        is_staff: guessIsStaff(html, aAuthor),
        badge: authorityBadge(html, aAuthor),
        is_accepted: a.__accepted === true,
        author_url: typeof a.author?.url === 'string' ? a.author.url : null,
        created_at: ownDate ?? createdAt,
        images: content ? extractImageUrls(content) : [],
      }
    })

  return {
    title,
    body,
    created_at: createdAt,
    author: authorName,
    answers,
  }
}
