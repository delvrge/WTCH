// Node-side counterpart to supabase/functions/_shared/ai-provider.ts, same
// Gemini models/shapes, but callable from tsx scripts (not Deno edge runtime).

const GEMINI_CHAT_MODEL = 'gemini-flash-latest'
const GEMINI_EMBED_MODEL = 'gemini-embedding-001'
/** Every stored embedding in this project is 1536-dim (from the OpenAI days).
 *  Gemini's embedding model supports truncating to this size, which keeps
 *  the existing `vector(1536)` columns valid without a schema migration. */
const EMBED_DIMENSIONS = 1536

export async function chatJSON(opts: {
  apiKey: string
  systemPrompt: string
  userContent: string
  temperature?: number
}): Promise<string> {
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
          responseMimeType: 'application/json',
        },
      }),
    },
  )
  if (!res.ok) throw new Error(`AI service error: ${await res.text()}`)
  const data = await res.json()
  const content: string | undefined = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!content) throw new Error('No response from AI')
  return content
}

/** Batched counterpart to embed(), one HTTP round-trip for many texts,
 *  via Gemini's batchEmbedContents endpoint. */
export async function embedBatch(opts: { apiKey: string; texts: string[] }): Promise<number[][]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED_MODEL}:batchEmbedContents?key=${opts.apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: opts.texts.map((text) => ({
          model: `models/${GEMINI_EMBED_MODEL}`,
          content: { parts: [{ text }] },
          outputDimensionality: EMBED_DIMENSIONS,
        })),
      }),
    },
  )
  if (!res.ok) throw new Error(`Embedding service error: ${await res.text()}`)
  const data = await res.json()
  const embeddings: { values: number[] }[] | undefined = data.embeddings
  if (!embeddings) throw new Error('No embeddings returned')
  return embeddings.map((e) => e.values)
}

export async function embed(opts: { apiKey: string; text: string }): Promise<number[]> {
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
  if (!res.ok) throw new Error(`Embedding service error: ${await res.text()}`)
  const data = await res.json()
  const values: number[] | undefined = data.embedding?.values
  if (!values) throw new Error('No embedding returned')
  return values
}
