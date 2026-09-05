// Single place every AI call in this project goes through. Swapping models
// or providers means editing here only — callers never touch a provider URL.

const GEMINI_CHAT_MODEL = 'gemini-flash-latest'
const GEMINI_EMBED_MODEL = 'gemini-embedding-001'
/** Every stored embedding in this project is 1536-dim (from the OpenAI days).
 *  Gemini's embedding model supports truncating to this size, which keeps
 *  the existing `vector(1536)` columns valid without a schema migration. */
const EMBED_DIMENSIONS = 1536

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Gemini's flash-latest alias occasionally 503s under load ("high demand,
// try again later") — a capacity blip, not a real failure. Retried a couple
// times with backoff before giving up, so a transient spike doesn't surface
// as an error to the operator.
const RETRYABLE_STATUSES = new Set([429, 500, 503])
const MAX_RETRIES = 2

async function chat(opts: {
  apiKey: string
  systemPrompt: string
  userContent: string
  temperature?: number
  json: boolean
}): Promise<string> {
  let lastError = ''
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_CHAT_MODEL}:generateContent?key=${opts.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: opts.systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: opts.userContent }] }],
          generationConfig: {
            temperature: opts.temperature ?? 0.3,
            ...(opts.json ? { responseMimeType: 'application/json' } : {}),
          },
        }),
      },
    )
    if (res.ok) {
      const data = await res.json()
      const content: string | undefined = data.candidates?.[0]?.content?.parts?.[0]?.text
      if (!content) throw new Error('No response from AI')
      return content
    }
    lastError = await res.text()
    if (!RETRYABLE_STATUSES.has(res.status) || attempt === MAX_RETRIES) {
      throw new Error(`AI service error: ${lastError}`)
    }
    await sleep(500 * 2 ** attempt)
  }
  throw new Error(`AI service error: ${lastError}`)
}

/** Chat completion constrained to JSON output. Returns the raw JSON string
 *  the model wrote — callers parse it themselves, same as the OpenAI shape
 *  they were written against. */
export async function chatJSON(opts: {
  apiKey: string
  systemPrompt: string
  userContent: string
  temperature?: number
}): Promise<string> {
  return chat({ ...opts, json: true })
}

/** Chat completion returning plain text — for prompts that ask for prose,
 *  not a JSON object. */
export async function chatText(opts: {
  apiKey: string
  systemPrompt: string
  userContent: string
  temperature?: number
}): Promise<string> {
  return chat({ ...opts, json: false })
}

/** Embeds text at the fixed 1536 dimension every stored embedding in this
 *  project uses. Nothing else may embed with different settings — the
 *  vectors would not be comparable. */
export async function embed(opts: { apiKey: string; text: string }): Promise<number[]> {
  let lastError = ''
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED_MODEL}:embedContent?key=${opts.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: { parts: [{ text: opts.text }] },
          outputDimensionality: EMBED_DIMENSIONS,
        }),
      },
    )
    if (res.ok) {
      const data = await res.json()
      const values: number[] | undefined = data.embedding?.values
      if (!values) throw new Error('No embedding returned')
      return values
    }
    lastError = await res.text()
    if (!RETRYABLE_STATUSES.has(res.status) || attempt === MAX_RETRIES) {
      throw new Error(`Embedding service error: ${lastError}`)
    }
    await sleep(500 * 2 ** attempt)
  }
  throw new Error(`Embedding service error: ${lastError}`)
}
