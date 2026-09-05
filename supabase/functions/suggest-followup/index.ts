// Drafts a next-step reply for a case where the user answered back after the
// operator already replied (a 'user_replied' case — see check-case-replies).
// Grounds strictly in what's actually there: the thread's own post, the
// reply already on record for this case, and the user's own newest follow-up
// — never invents a new fix. Same evidence-only discipline as draft-from-case.
//
// Called lazily from CaseConversationModal, only when the operator actually
// opens the popup — not on every unread detection, so a case that never gets
// looked at never costs an Gemini call.

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { getCorsHeaders } from '../_shared/cors.ts'
import { fetchThread } from '../_shared/community-sources.ts'
import { chatText } from '../_shared/ai-provider.ts'
import { PRODUCT_NAME } from '../_shared/product.ts'

interface RequestBody {
  url: string
  /** The reply already on record for this case (verified_answers.answer_text), so the model knows what was already tried. */
  existing_reply: string | null
}

function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
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
    const apiKey = Deno.env.get('GEMINI_API_KEY')
    if (!apiKey) throw new Error('AI service not configured')

    const body: RequestBody = await req.json()
    const url = trimmedOrNull(body.url)
    if (!url) throw new Error('url is required')
    const existingReply = trimmedOrNull(body.existing_reply)

    const thread = await fetchThread(url)
    const nonStaffAnswers = thread.answers.filter(a => !a.is_staff)
    const userReply = nonStaffAnswers[nonStaffAnswers.length - 1]?.text ?? null
    if (!userReply) {
      throw new Error('No user reply found on this thread yet.')
    }

    const systemPrompt = `You write a short, friendly customer-facing follow-up reply for a ${PRODUCT_NAME} Community Manager. The user replied back after the CM's own earlier reply, and you are drafting what to say next.

THE ORIGINAL POST:
${thread.title}
${thread.body}

${existingReply ? `WHAT WE ALREADY TOLD THEM:\n${existingReply}\n` : 'We have no prior reply on record for this case.\n'}
THEIR FOLLOW-UP REPLY (what they just said):
${userReply}

Rules:
- Only use facts present above. Do not invent a new fix or troubleshooting step that isn't grounded in what we already told them or what they just said.
- If their follow-up says the fix worked, thank them and close it out briefly.
- If their follow-up says it did NOT work, or asks a new question, respond to exactly that — do not repeat the same advice verbatim if they said it didn't help.
- If their follow-up genuinely doesn't give you enough to say anything useful, say so plainly rather than padding with generic troubleshooting.
- Write in English, always, even when the post or their reply is in another language. Translate, don't quote the original wording.
- Plain, warm, professional support voice. No corporate filler.
- 2 to 5 sentences. No greeting, no sign-off — the operator adds those.
- Never use an em dash (—); use a period, comma, or "and" instead.

Respond with ONLY the reply text, nothing else.`

    const suggestion = (await chatText({
      apiKey,
      systemPrompt,
      userContent: 'Write the follow-up reply now.',
      temperature: 0.3,
    })).trim()
    if (!suggestion) throw new Error('No response from AI')

    return new Response(
      JSON.stringify({
        success: true,
        complaint: `${thread.title}\n\n${thread.body}`.trim(),
        existing_reply: existingReply,
        user_reply: userReply,
        suggestion,
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
