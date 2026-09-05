// Investigation walkthrough, an INTERNAL guide for the operator, not a
// customer-facing reply.
//
// The whole feature lives here rather than in the edge function so it can be
// run head-on from a script (scripts/preview-investigation.ts) without an
// operator browser session. investigate/index.ts is then only auth plus a
// call into buildInvestigation.
//
// draft-reply answers "what do I send this person". This answers a different
// question: "how do I work this case out". It takes the pasted post, finds
// past cases with the same underlying problem, and writes the operator a
// short diagnostic plan grounded in what actually resolved those cases.
//
// The two coexist and share nothing but their retrieval layer. Nothing here
// writes to the database, auto-collects, or drafts customer text.
//
// KEY DISTINCTION (case_kind)
// Some posts need no investigation at all: a subscription cancellation is
// answered and closed in one line, and forcing a diagnostic checklist onto
// it wastes the operator's time and reads as padding. Others (bug reports,
// generation failures) genuinely cannot be resolved until the operator has
// asked for specifics. The model classifies which kind it is FIRST, and the
// shape of the walkthrough follows from that: `closeable` cases get the
// answer and a close, `needs_investigation` cases get diagnostic questions
// before any conclusion.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { embedText, normalizeAndEmbed } from './normalize-issue.ts'
import { chatJSON } from './ai-provider.ts'
import { PRODUCT_NAME } from './product.ts'
import { searchPatterns } from './pattern-search.ts'
import type { PatternHit } from './pattern-search.ts'
import { findSolvedCases } from './solved-cases.ts'
import type { SolvedCase } from './solved-cases.ts'
import { searchSupportDocs } from './support-docs.ts'
import {
  extractCommunityUrl,
  fetchThread,
  normalizeSlugText,
  parseTopicUrl,
  titleTokensAnyLanguage,
} from './community-sources.ts'
import type { ThreadContent } from './community-sources.ts'

const PATTERN_RESULT_LIMIT = 6
const VERIFIED_RESULT_LIMIT = 4
const TRUSTED_RESULT_LIMIT = 4
const SUPPORT_RESULT_LIMIT = 3
// Same floor as draft-reply's tracker search, measured the same way, see
// TRACKER_MIN_SIMILARITY in draft-reply/index.ts.
const VERIFIED_MIN_SIMILARITY = 0.6
const TRUSTED_MIN_SIMILARITY = 0.6

export interface VerifiedHit {
  id: string
  question_summary: string
  answer_text: string
  source_url: string | null
  similarity: number
}

/** A real reply from a trusted Community Manager/Expert (see
 *  TRUSTED_AUTHORS), backfilled ahead of time rather than found live via
 *  the solved-threads search. Not the operator's own reply, so kept out of
 *  verified_answers, see the migration's header comment. */
export interface TrustedHit {
  id: string
  question_summary: string
  answer_text: string
  source_url: string
  source_author: string
  is_accepted: boolean
  similarity: number
}

export interface SupportDocHit {
  url: string
  title: string
  excerpt: string
}

/** Whether the case can be answered and closed now, or needs the operator to
 *  gather specifics first. Drives the entire shape of the walkthrough. */
export type CaseKind = 'closeable' | 'needs_investigation'

export interface Step {
  /** One concrete operator action, in order. */
  text: string
  /** `[C:<pattern id>]` / `[V:<verified answer id>]` / `[T:<trusted reply id>]`
   *  / `[S:<solved thread url>]` / `[SD:<support doc url>]` this step came
   *  from, or null when it is general procedure rather than something a past
   *  case established. */
  cite: string | null
}

export interface Question {
  text: string
  /** What the answer would tell the operator. Keeps the list from becoming
   *  a generic intake form. */
  why: string
}

export interface InvestigateResult {
  investigation: Investigation
  normalized_issue: string
  similar: PatternHit[]
  verified: VerifiedHit[]
  /** Real replies from trusted Community Managers/Experts, backfilled
   *  ahead of time (see trusted_replies). Distinct from `solved`: this tier
   *  does not require the underlying thread to have surfaced via the
   *  solved-threads search, just to have been pre-collected. */
  trusted: TrustedHit[]
  /** Past threads that match AND already carry an answer. Usually the most
   *  useful tier: the case being worked is typically still unanswered. */
  solved: SolvedCase[]
  /** Official support documentation passages, keyword-matched off the same
   *  post title/thread tokens used for the solved-thread search. */
  support: SupportDocHit[]
  /** Set when the operator pasted a link and the thread was fetched. Null for
   *  free text, or when the fetch failed and it fell back to the raw text. */
  source: { url: string; title: string } | null
  /** The full fetched thread behind `source`, when there is one. Exposed so
   *  investigate/index.ts can auto-collect it into the Library without a
   *  second fetch, buildInvestigation itself stays read-only (no DB
   *  writes), so scripts/preview-investigation.ts keeps costing nothing but
   *  model calls for prompt tuning. */
  thread: ThreadContent | null
  /** Candidate threads that were fetched and then rejected, with the reason.
   *  The tuning surface for the solved filter: if good threads are being
   *  thrown away, it shows up here before it shows up as a bad walkthrough. */
  solved_dropped: { url: string; reason: string }[]
  errors: string[]
}

export interface Investigation {
  case_kind: CaseKind
  /** Plain statement of what this case actually is, in the operator's terms. */
  one_liner: string
  confidence: 'high' | 'medium' | 'low'
  steps: Step[]
  /** Empty for `closeable` cases by construction, nothing to ask. */
  questions_to_ask: Question[]
  watch_out: string[]
}

async function searchVerified(
  supabaseAdmin: SupabaseClient,
  userId: string,
  embedding: number[],
): Promise<VerifiedHit[]> {
  const { data, error } = await supabaseAdmin.rpc('match_verified_answers', {
    p_user_id: userId,
    p_embedding: embedding,
    p_match_count: VERIFIED_RESULT_LIMIT,
    p_min_similarity: VERIFIED_MIN_SIMILARITY,
  })
  if (error) throw error
  return ((data ?? []) as (VerifiedHit & { source_url: string | null })[])
    .sort((a, b) => b.similarity - a.similarity)
    .map((row) => ({
      id: row.id,
      question_summary: row.question_summary,
      answer_text: row.answer_text,
      source_url: row.source_url ?? null,
      similarity: row.similarity,
    }))
}

async function searchTrusted(
  supabaseAdmin: SupabaseClient,
  userId: string,
  embedding: number[],
): Promise<TrustedHit[]> {
  const { data, error } = await supabaseAdmin.rpc('match_trusted_replies', {
    p_user_id: userId,
    p_embedding: embedding,
    p_match_count: TRUSTED_RESULT_LIMIT,
    p_min_similarity: TRUSTED_MIN_SIMILARITY,
  })
  if (error) throw error
  return ((data ?? []) as TrustedHit[])
    .sort((a, b) => b.similarity - a.similarity)
    .map((row) => ({
      id: row.id,
      question_summary: row.question_summary,
      answer_text: row.answer_text,
      source_url: row.source_url,
      source_author: row.source_author,
      is_accepted: row.is_accepted,
      similarity: row.similarity,
    }))
}

/** Renders the retrieved cases as the model's only permitted source of fact,
 *  and returns the label -> row id map for reading its citations back.
 *
 *  Entries are labelled C1/C2/V1 rather than by their uuid on purpose: asked
 *  to copy a 36 character uuid into every citation, the model simply stops
 *  citing and returns null, so grounded steps came back looking ungrounded.
 *  Short labels it copies reliably. The uuid never has to leave the server. */
function buildEvidenceBlock(
  patterns: PatternHit[],
  verified: VerifiedHit[],
  trusted: TrustedHit[],
  solved: SolvedCase[],
  support: SupportDocHit[],
): { block: string; labels: Map<string, string> } {
  const labels = new Map<string, string>()

  const patternLines = patterns.length
    ? patterns.map((p, i) => {
      const label = `C${i + 1}`
      labels.set(label, `[C:${p.id}]`)
      const seen = p.frequency > 1 ? `, seen ${p.frequency} times` : ''
      const where = p.topic && p.subtopic ? `, ${p.topic} / ${p.subtopic}` : ''
      const title = p.source_title ? `\n    original post title: ${p.source_title}` : ''
      return `  [${label}] (similarity ${p.similarity.toFixed(2)}${seen}${where})
    issue: ${p.issue_summary}
    what was done: ${p.typical_approach}${title}`
    }).join('\n\n')
    : '  (none above the similarity floor)'

  const verifiedLines = verified.length
    ? verified.map((v, i) => {
      const label = `V${i + 1}`
      labels.set(label, `[V:${v.id}]`)
      return `  [${label}] (similarity ${v.similarity.toFixed(2)})
    question: ${v.question_summary}
    the answer that was actually sent: ${v.answer_text}`
    }).join('\n\n')
    : '  (none above the similarity floor)'

  const trustedLines = trusted.length
    ? trusted.map((t, i) => {
      const label = `T${i + 1}`
      labels.set(label, `[T:${t.id}]`)
      const strength = t.is_accepted ? ', marked as the correct answer' : ''
      return `  [${label}] (similarity ${t.similarity.toFixed(2)}${strength}, by ${t.source_author})
    question: ${t.question_summary}
    the answer: ${t.answer_text}`
    }).join('\n\n')
    : '  (none above the similarity floor)'

  // Answer text is capped: one long staff reply would otherwise crowd out the
  // other two tiers, and the fix is almost always in the first paragraphs.
  const solvedLines = solved.length
    ? solved.map((c, i) => {
      const label = `S${i + 1}`
      labels.set(label, `[S:${c.url}]`)
      const who = c.answer.author
        ? `${c.answer.author}${c.answer.badge ? `, ${c.answer.badge}` : ''}`
        : 'unknown'
      const strength = c.reason === 'accepted_answer'
        ? 'MARKED AS THE CORRECT ANSWER by the person who asked'
        : 'a reply from platform staff or a Community Expert, NOT formally marked as the solution'
      const excerpt = c.answer.text.length > 1200 ? `${c.answer.text.slice(0, 1200)}…` : c.answer.text
      return `  [${label}] ${c.title}
    strength: ${strength}
    answered by: ${who}
    the answer: ${excerpt}`
    }).join('\n\n')
    : '  (none found)'

  const supportLines = support.length
    ? support.map((doc, i) => {
      const label = `D${i + 1}`
      labels.set(label, `[SD:${doc.url}]`)
      return `  [${label}] ${doc.title}
    ${doc.excerpt}`
    }).join('\n\n')
    : '  (none found)'

  const block = `PAST CASES from the operator's own Library (community_patterns):
${patternLines}

VERIFIED ANSWERS the operator previously sent and confirmed worked (verified_answers):
${verifiedLines}

TRUSTED REPLIES from trusted Community Managers/Experts on past cases (not the operator, but proven-competent, citable as fact):
${trustedLines}

SOLVED THREADS on the community that describe a similar problem and already have an answer on them:
${solvedLines}

OFFICIAL SUPPORT DOCUMENTATION, highest authority, wins on direct conflict with any tier above:
${supportLines}`

  return { block, labels }
}

function buildSystemPrompt(evidence: string): string {
  return `You write a short INTERNAL investigation walkthrough for a support operator handling a community post about ${PRODUCT_NAME}. Your reader is the operator, never the customer. Never write customer-facing text, a greeting, or a reply to send: another tool does that.

The ONLY facts you may assert are the ones in the EVIDENCE block below. You may reason about the incoming post itself, but anything you state as "what usually causes this" or "what fixed this before" must come from a cited past case. If the evidence does not support a conclusion, say so plainly and make the walkthrough about finding out, rather than inventing a cause.

EVIDENCE
${evidence}

FIRST decide case_kind, because everything else follows from it:
- "closeable": the post can be answered and closed now, with no diagnosis. Account cancellations, refund requests, billing questions, "how do I do X" questions, anything where the answer does not depend on facts you do not have. For these, steps are the short sequence to resolve and close it. questions_to_ask MUST be empty: there is nothing to find out.
- "needs_investigation": the post cannot be resolved until the operator learns specifics that are not in it. Bug reports, generation failures, "it stopped working", anything where the cause is genuinely unknown. For these, the first steps are about gathering, and questions_to_ask carries the specific things to ask the customer.

Do NOT force a diagnostic checklist onto a closeable case. A one line answer with a close is the correct, complete output for those, and padding it is a failure.

Rules for the fields:
- one_liner: what this case actually is, in the operator's terms. One sentence, no restating the post back.
- confidence: "high" only when a cited entry clearly covers this same underlying problem. "low" when the evidence is thin or unrelated, and say why in watch_out.

About the SOLVED THREADS tier: the incoming post is usually NOT yet answered, so this tier is where an actual fix is most likely to be found. Prefer it when it is relevant. Respect the stated strength of each one: an entry marked as the correct answer can be presented as what resolved the issue, while a staff reply that was never marked as the solution may have been the staff member asking for more detail rather than solving anything, so read the answer text before treating it as a fix. A solved thread about a DIFFERENT problem must be ignored outright, never stretched to fit.
- steps: 2 to 6 concrete actions, in the order the operator should do them. Each step is one action, phrased as an instruction ("check whether the account is on the free plan", not "the operator could check"). When a step comes from a past case, a verified answer, a solved thread, or official documentation, set "cite" to that entry's label exactly as written above, for example "[C1]", "[V2]", "[T1]", "[S1]" or "[D1]". Use null only when the step is ordinary procedure that no listed entry established. A step that restates what a listed entry did and cites nothing is wrong: whenever the EVIDENCE block contains any entry, at least one step must cite one. Official documentation ([D1], [D2]...) outranks every other tier on direct conflict, if a support doc contradicts a past case or forum reply, follow the doc.
- questions_to_ask: for "needs_investigation" only, 0 to 5 entries. Each is a specific question for the customer plus why the answer matters to the diagnosis. No generic intake questions that would not change what the operator does next.
- watch_out: 0 to 3 short warnings. Use it for thin or conflicting evidence, for a past case that is old enough that the issue may already be fixed, or for a wrong turn the evidence suggests. Omit rather than pad.
- Never use an em dash (—) anywhere; use a period, comma, or "and" instead.

Respond with ONLY a JSON object:
{ "case_kind": "closeable" | "needs_investigation", "one_liner": string, "confidence": "high" | "medium" | "low", "steps": [{ "text": string, "cite": string | null }], "questions_to_ask": [{ "text": string, "why": string }], "watch_out": string[] }`
}

/** Resolves whatever the model wrote in `cite` to a canonical
 *  `[C:<id>]` / `[V:<id>]` / `[S:<url>]` / `[SD:<url>]` ref, or null when it
 *  names nothing that was actually retrieved.
 *
 *  Tolerant of format ("[C1]", "C1", "c1"), strict about existence: a label
 *  with no entry behind it is dropped rather than shown, which is the part
 *  that guards against a citation to a case that does not exist. */
function verifyCites(steps: Step[], labels: Map<string, string>): Step[] {
  return steps.map((step) => {
    const raw = typeof step.cite === 'string' ? step.cite.trim() : ''
    const label = raw.match(/[CVTSD]\s*\d+/i)?.[0].replace(/\s+/g, '').toUpperCase()
    return {
      text: String(step.text ?? '').trim(),
      cite: label ? labels.get(label) ?? null : null,
    }
  }).filter((step) => step.text.length > 0)
}

/** The whole walkthrough: retrieve, ground, write. Read-only, nothing here
 *  writes to the database. Throws only on an unusable model response; a
 *  failed retrieval degrades into an `errors` entry and thinner evidence. */
export async function buildInvestigation(
  supabaseAdmin: SupabaseClient,
  userId: string,
  text: string,
  apiKey: string,
  opts: {
    /** The case's own community_patterns id, when known (a Library
     *  "Rerun"), excluded from `similar` alongside the existing
     *  url-based check below, since a rerun often has no url to match on
     *  (the operator reran off the title) and would otherwise show the
     *  case matching itself. */
    excludePatternId?: string
  } = {},
): Promise<InvestigateResult> {
  const errors: string[] = []

  // ── Resolve what we are actually searching on ───────────────────────────
  // A pasted link is worth far more than a pasted title: fetching it gives the
  // poster's full description instead of one line. The thread's own REPLIES
  // are deliberately excluded, on the case being worked they are usually the
  // operator's own "please send a screenshot", which describes no problem and
  // would only blur the search.
  //
  // Every failure here is non-fatal and falls back to the raw text, so this
  // path can never be worse than pasting a title was.
  const url = extractCommunityUrl(text)
  let source: { url: string; title: string } | null = null
  let fetchedThread: ThreadContent | null = null
  let queryText = text
  let keywords: string[] = []

  if (url) {
    try {
      const thread = await fetchThread(url)
      fetchedThread = thread
      source = { url, title: thread.title }
      queryText = `${thread.title}\n\n${thread.body}`
      keywords = titleTokensAnyLanguage(thread.title)
    } catch (err) {
      errors.push(`thread fetch: ${err instanceof Error ? err.message : 'failed'}`)
      // Do not leave a bare url as the thing being searched on: normalized,
      // "https://community.example.com/bug-reports-403/i-cannot-generate-images-1"
      // becomes a description of broken links rather than of the issue. The
      // slug is the post's real title with hyphens, so fall back to that.
      const parsed = parseTopicUrl(url)
      if (parsed) queryText = normalizeSlugText(parsed.slug.replace(/-\d+$/, '')).trim()
    }
  }
  if (!keywords.length) keywords = titleTokensAnyLanguage(queryText)

  // ── Two embeddings, one per corpus shape ────────────────────────────────
  // Not redundant. community_patterns/verified_answers hold embeddings of
  // ABSTRACTED one-liners, so they are searched with the normalized issue
  // description. topic_taxonomy_posts holds embeddings of FULL post text, so it
  // is searched with the post text itself. Crossing the two reintroduces the
  // raw-vs-abstracted mismatch normalize-issue.ts exists to prevent.
  const { issueDescription, embedding } = await normalizeAndEmbed(queryText, apiKey)
  const fullTextEmbedding = await embedText(queryText, apiKey)

  const [patterns, verified, trusted, solvedResult, support] = await Promise.all([
    // One extra when a link was pasted: the pasted case is usually already in
    // the Library (draft-reply auto-collects it), so it matches ITSELF at the
    // top of this list. That row is dropped below, and asking for one more
    // keeps the section the same length.
    searchPatterns(supabaseAdmin, userId, embedding, PATTERN_RESULT_LIMIT + (url ? 1 : 0))
      .catch((err) => {
        errors.push(`patterns: ${err instanceof Error ? err.message : 'lookup failed'}`)
        return [] as PatternHit[]
      }),
    searchVerified(supabaseAdmin, userId, embedding)
      .catch((err) => {
        errors.push(`verified: ${err instanceof Error ? err.message : 'lookup failed'}`)
        return [] as VerifiedHit[]
      }),
    searchTrusted(supabaseAdmin, userId, embedding)
      .catch((err) => {
        errors.push(`trusted: ${err instanceof Error ? err.message : 'lookup failed'}`)
        return [] as TrustedHit[]
      }),
    findSolvedCases(supabaseAdmin, userId, fullTextEmbedding, {
      excludeUrl: url,
      keywords,
      apiKey,
    }),
    searchSupportDocs(supabaseAdmin, keywords, SUPPORT_RESULT_LIMIT)
      .then((docs) => docs.map((doc) => ({ url: doc.url, title: doc.title, excerpt: doc.excerpt })))
      .catch((err) => {
        errors.push(`support docs: ${err instanceof Error ? err.message : 'lookup failed'}`)
        return [] as SupportDocHit[]
      }),
  ])

  const solved = solvedResult.cases
  const solvedDropped = solvedResult.dropped
  errors.push(...solvedResult.errors)

  // Showing the operator their own open case back as a "similar past case" is
  // noise at best and misleading at worst: it looks like corroboration when it
  // is the same thread reflected. Matched on url, since that is what
  // auto-collect stores and a case can carry several, plus, when the caller
  // already knows the case's own pattern_id (a Library "Rerun", which often
  // has no url to match on since the operator reran off the title), matched
  // on that id directly.
  const patternsWithoutSelf = patterns.filter((p) => {
    if (opts.excludePatternId && p.id === opts.excludePatternId) return false
    if (url && p.source_urls.includes(url)) return false
    return true
  })

  const { block, labels } = buildEvidenceBlock(patternsWithoutSelf, verified, trusted, solved, support)
  const systemPrompt = buildSystemPrompt(block)
  const userContent = `INCOMING POST:\n${queryText}\n\nWHAT THIS POST IS ABOUT (normalized):\n${issueDescription}`

  const rawContent = await chatJSON({
    apiKey,
    systemPrompt,
    userContent,
    temperature: 0.3,
  })

  let parsed: Investigation
  try {
    parsed = JSON.parse(rawContent)
  } catch {
    throw new Error('AI returned unparseable JSON')
  }

  const caseKind: CaseKind = parsed.case_kind === 'closeable' ? 'closeable' : 'needs_investigation'
  const investigation: Investigation = {
    case_kind: caseKind,
    one_liner: String(parsed.one_liner ?? '').trim(),
    confidence: parsed.confidence === 'high' || parsed.confidence === 'low' ? parsed.confidence : 'medium',
    steps: verifyCites(Array.isArray(parsed.steps) ? parsed.steps : [], labels),
    // Enforced here rather than trusted from the model: a closeable case
    // with questions attached is the exact failure mode this feature exists
    // to avoid.
    questions_to_ask: caseKind === 'closeable' || !Array.isArray(parsed.questions_to_ask)
      ? []
      : parsed.questions_to_ask
        .filter((q) => q && typeof q.text === 'string' && q.text.trim())
        .map((q) => ({ text: q.text.trim(), why: typeof q.why === 'string' ? q.why.trim() : '' }))
        .slice(0, 5),
    watch_out: Array.isArray(parsed.watch_out)
      ? parsed.watch_out.filter((w): w is string => typeof w === 'string' && w.trim().length > 0).slice(0, 3)
      : [],
  }

  if (!investigation.one_liner) throw new Error('AI response missing one_liner')

  return {
    investigation,
    normalized_issue: issueDescription,
    similar: patternsWithoutSelf,
    verified,
    trusted,
    solved,
    support,
    source,
    thread: fetchedThread,
    solved_dropped: solvedDropped,
    errors,
  }
}
