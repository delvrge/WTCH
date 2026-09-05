import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { getCorsHeaders } from '../_shared/cors.ts'
import { discoverTopics, fetchThread } from '../_shared/community-sources.ts'
import type { ThreadAnswer } from '../_shared/community-sources.ts'
import { chatJSON } from '../_shared/ai-provider.ts'
import { PRODUCT_NAME } from '../_shared/product.ts'

// Takes the title of a post the operator is currently handling — one that has
// no reply yet — and finds community threads asking the same thing that DO
// already carry an answer from a Community Manager or Community Expert. Those
// answers are the reusable material; the operator reads them and writes their
// own reply by hand.
//
// Read-only toward the outside world: HTTP GET to COMMUNITY_HOST and POST
// to the Gemini API, nothing else. It never posts, replies or submits anywhere.

// Each candidate costs one page fetch plus the politeness delay, so the number
// actually opened is capped well below the number discovered.
const DEFAULT_FETCH_LIMIT = 10
const MAX_FETCH_LIMIT = 16
const DISCOVER_MULTIPLIER = 4
// Wider than the 180 days run-watch uses: a Community Expert answer from a
// year ago is still the answer, even when the pattern itself has aged.
const DEFAULT_MAX_AGE_DAYS = 365
const ANSWER_EXCERPT_CHARS = 1200

interface RequestBody {
  text: string
  limit?: number
  max_age_days?: number
}

interface ThreadResult {
  url: string
  title: string
  category: string
  board: string
  created_at: string | null
  lastmod: string | null
  /** Answers carrying a Community Manager / Community Expert style badge. */
  answers: { text: string; author: string | null; badge: string | null }[]
  /** True when at least one answer matched a badge. Never false-negative-proof. */
  has_authority_answer: boolean
  /** Any answer at all, badge or not. */
  answer_count: number
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'it', 'its', 'this',
  'that', 'these', 'those', 'my', 'me', 'i', 'you', 'your', 'we', 'our', 'they',
  'do', 'does', 'did', 'can', 'cant', 'could', 'will', 'would', 'should', 'have',
  'has', 'had', 'not', 'no', 'why', 'how', 'what', 'when', 'where', 'help',
  'please', 'anyone', 'someone', 'question', 'issue', 'problem',
])

/** Fallback when the model is unavailable or returns nothing usable. */
function keywordsFromText(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  return [...new Set(words)].slice(0, 10)
}

/**
 * Turn a pasted post title into search keywords matched against thread titles
 * and URL slugs. Mirrors the prompt in suggest-keywords, but reads free text
 * rather than a stored watch.
 */
async function keywordsFromModel(text: string, apiKey: string): Promise<string[]> {
  const systemPrompt = `You generate search keywords used to find community forum threads about a specific topic in the ${PRODUCT_NAME} community. Keywords are matched against thread titles and URL slugs.

You are given the title of a forum post. Return 8-14 lowercase search keywords likely to match OTHER threads asking the same underlying question in DIFFERENT WORDS.

The same problem is described many ways, so cover the range:
- At least 4 must be SINGLE words — the core nouns and verbs someone would use no matter how they phrase it (e.g. "connector", "credits", "upscale"). These are what catch unexpected phrasings.
- The rest may be two words, for the specific pairing the post is about.
- Include synonyms, singular/plural variants, the vendor's own product name and the casual name users type instead, and common misspellings.
- Correct obvious typos in the input rather than repeating them.

Order the list broadest first, most specific last.

Keywords must be plain search terms only — no punctuation, no quotes, no boolean operators, all lowercase.

Respond with ONLY a JSON object: { "keywords": string[] }`

  const content = await chatJSON({
    apiKey,
    systemPrompt,
    userContent: text,
    temperature: 0.2,
  })

  const parsed = JSON.parse(content)
  const raw = Array.isArray(parsed?.keywords) ? parsed.keywords : []
  const cleaned = raw
    .filter((k: unknown): k is string => typeof k === 'string')
    .map((k: string) => k.trim().toLowerCase().replace(/["'.,;:!?]/g, '').replace(/\s+/g, ' '))
    .filter(Boolean)
  return [...new Set<string>(cleaned)]
}

function isAuthority(answer: ThreadAnswer): boolean {
  return answer.is_staff === true
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!

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
    const body: RequestBody = await req.json()
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) throw new Error('text is required')

    const limit = typeof body.limit === 'number' && body.limit > 0
      ? Math.min(Math.floor(body.limit), MAX_FETCH_LIMIT)
      : DEFAULT_FETCH_LIMIT
    const maxAgeDays = typeof body.max_age_days === 'number' && body.max_age_days > 0
      ? Math.floor(body.max_age_days)
      : DEFAULT_MAX_AGE_DAYS

    const apiKey = Deno.env.get('GEMINI_API_KEY')
    if (!apiKey) throw new Error('AI service not configured')

    // ── Title → keywords ────────────────────────────────────────────────────
    // A model failure here degrades to the plain word split rather than
    // failing the whole request: worse keywords still beat no results.
    let keywords: string[] = []
    try {
      keywords = await keywordsFromModel(text, apiKey)
    } catch (keywordError) {
      console.warn('keyword generation failed, falling back to word split:', keywordError)
    }
    if (!keywords.length) keywords = keywordsFromText(text)
    if (!keywords.length) throw new Error('Could not derive search keywords from that text')

    // ── Discover candidates, then open the most recent ones ──────────────────
    // Two passes, because "nothing found" is the one useless answer here. The
    // first uses the keywords as generated. If that comes back empty, the
    // second widens to the individual words behind them and doubles the age
    // window — a weaker lead still beats an empty screen.
    let widened = false
    let candidates = await discoverTopics(keywords, [], limit * DISCOVER_MULTIPLIER, maxAgeDays)

    if (!candidates.length) {
      const singleWords = [...new Set(
        keywords
          .flatMap((k) => k.split(/\s+/))
          .map((w) => w.trim())
          .filter((w) => w.length > 3 && !STOPWORDS.has(w)),
      )]
      if (singleWords.length) {
        widened = true
        candidates = await discoverTopics(singleWords, [], limit * DISCOVER_MULTIPLIER, maxAgeDays * 2)
      }
    }

    const toOpen = candidates.slice(0, limit)
    const results: ThreadResult[] = []
    const errors: string[] = []

    for (const topic of toOpen) {
      try {
        const thread = await fetchThread(topic.url)
        const authority = thread.answers.filter(isAuthority)
        results.push({
          url: topic.url,
          title: thread.title || topic.slug.replace(/-/g, ' '),
          category: topic.category,
          board: topic.board,
          created_at: thread.created_at,
          lastmod: topic.lastmod,
          answers: authority.map((a) => ({
            text: a.text.length > ANSWER_EXCERPT_CHARS
              ? `${a.text.slice(0, ANSWER_EXCERPT_CHARS)}…`
              : a.text,
            author: a.author,
            badge: a.badge ?? null,
          })),
          has_authority_answer: authority.length > 0,
          answer_count: thread.answers.length,
        })
      } catch (threadError) {
        // One unreadable thread must not lose the rest of the results.
        errors.push(
          `${topic.url}: ${threadError instanceof Error ? threadError.message : 'Could not read thread'}`,
        )
      }
    }

    // Threads with a badged answer first, then anything else that at least has
    // replies, then the rest. Ties break on the newest source date.
    results.sort((a, b) => {
      if (a.has_authority_answer !== b.has_authority_answer) return a.has_authority_answer ? -1 : 1
      if ((a.answer_count > 0) !== (b.answer_count > 0)) return a.answer_count > 0 ? -1 : 1
      const aDate = a.created_at || a.lastmod || ''
      const bDate = b.created_at || b.lastmod || ''
      return bDate.localeCompare(aDate)
    })

    return new Response(
      JSON.stringify({
        success: true,
        keywords,
        widened,
        discovered: candidates.length,
        opened: toOpen.length,
        results,
        errors,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )

  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'An error occurred' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
