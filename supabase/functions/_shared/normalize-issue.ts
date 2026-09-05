import { chatJSON, embed } from './ai-provider.ts'

// Query-side issue normalization — the counterpart to the ingest-side
// abstraction done in pattern-extract.ts.
//
// WHY THIS EXISTS
// Everything searchable in this project is stored as an embedding of an
// ABSTRACTED, English one-liner:
//   - community_patterns.embedding  ← embedding of `issue_summary`
//     (pattern-extract.ts, written by the model under ISSUE_SUMMARY_CORE)
//   - verified_answers.embedding    ← embedding of `question_summary`
//     (save-verified/index.ts, a short written summary of the question)
//
// Query text, by contrast, arrives as whatever the operator pasted: a raw
// post title/body, often in another language, full of one user's specific
// wording. Embedding that raw text and comparing it against abstracted
// English summaries compares two different KINDS of text, so cosine
// similarity reads low even when the underlying problem is identical — which
// is exactly the "two posts about the same bug, worded differently, don't
// match" failure this module fixes.
//
// So: run the query through the same abstraction the stored side went
// through, THEN embed. Same underlying problem, same shape of text, real
// similarity.
//
// ISSUE_SUMMARY_CORE is shared with pattern-extract.ts on purpose. The two
// sides must describe the same thing the same way or they drift apart again;
// keeping one string means a change to the definition cannot land on only
// one side.

/**
 * The definition of an abstracted issue description, shared verbatim between
 * the ingest side (`issue_summary` in pattern-extract.ts) and the query side
 * (`issue_description` below).
 *
 * Substituted back into pattern-extract's prompt it reproduces that prompt's
 * original `issue_summary` bullet byte for byte — deliberately, so the 38
 * existing community_patterns embeddings stay comparable to newly written
 * ones. Do not reword this without re-embedding the stored rows.
 */
export const ISSUE_SUMMARY_CORE =
  `a short, general description of the TYPE of issue (not this specific user's specifics — no names, no verbatim quotes, no order/case numbers). Generalize so it would match other users hitting the same underlying problem.`

const NORMALIZE_SYSTEM_PROMPT =
  `You read an incoming support post (in any language) and write a short, GENERALIZED, ABSTRACTED issue description of the type of problem it describes — never verbatim text from the post.

Rules:
- Output MUST always be in English, even if the post is written in another language.
- The post TITLE is the highest-signal field for identifying what the issue actually is — weight it most heavily. Generic titles ("Something Went Wrong", "Help", "Bug", "Issue") say nothing about the actual problem: when the title is one of those, infer the issue from the body instead.
- issue_description: ${ISSUE_SUMMARY_CORE}
- Write one or two plain sentences. No lists, no preamble, no restating the question back.
- Never use an em dash (—); use a period, comma, or "and" instead.

Respond with ONLY a JSON object: { "issue_description": string }`

/**
 * Abstracts raw post text down to a plain English description of the
 * underlying problem, stripped of this user's wording and language.
 *
 * Throws on an unusable model response rather than silently falling back to
 * the raw text: a fallback would put a raw-vs-abstracted comparison back
 * into the search path, which is the bug this module exists to remove.
 * Callers that must not fail hard should catch and decide for themselves.
 */
export async function normalizeIssue(text: string, apiKey: string): Promise<string> {
  const rawContent = await chatJSON({
    apiKey,
    systemPrompt: NORMALIZE_SYSTEM_PROMPT,
    userContent: text,
    temperature: 0.3,
  })

  let issueDescription: string
  try {
    const parsed = JSON.parse(rawContent)
    issueDescription = parsed.issue_description
  } catch {
    throw new Error('AI returned unparseable JSON')
  }
  if (typeof issueDescription !== 'string' || !issueDescription.trim()) {
    throw new Error('AI returned no issue_description')
  }
  return issueDescription.trim()
}

/** Embeds already-normalized text with the model/dimensions every stored
 *  embedding in this project uses. Nothing else may embed with different
 *  settings — the vectors would not be comparable. */
export async function embedText(text: string, apiKey: string): Promise<number[]> {
  return embed({ apiKey, text })
}

/**
 * The whole query-side entry point: raw pasted text in, one abstracted
 * description plus its embedding out. Call this ONCE per request and reuse
 * the embedding across every search — every stored embedding in this project
 * lives in the same vector space, so one embed call serves
 * match_community_patterns and match_verified_answers both.
 */
export async function normalizeAndEmbed(
  text: string,
  apiKey: string,
): Promise<{ issueDescription: string; embedding: number[] }> {
  const issueDescription = await normalizeIssue(text, apiKey)
  const embedding = await embedText(issueDescription, apiKey)
  return { issueDescription, embedding }
}
