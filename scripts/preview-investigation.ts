// Runs the investigation walkthrough head-on against the live data and
// prints it, so the prompt can be tuned without a browser session.
//
//   npx tsx scripts/preview-investigation.ts "post title or body"
//   npx tsx scripts/preview-investigation.ts --sample 2
//
// --sample N pulls N real post titles straight out of community_patterns
// (source_title) and runs each, which is the fastest way to see whether the
// closeable / needs_investigation split is landing correctly on real cases.
//
// Read-only: the same buildInvestigation the edge function calls, which
// writes nothing.

import './topic-taxonomy/lib/load-env'
import { createClient } from '@supabase/supabase-js'
import { buildInvestigation } from '../supabase/functions/_shared/investigation'

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const geminiApiKey = process.env.GEMINI_API_KEY
const allowedUserId = process.env.ALLOWED_USER_ID

if (!supabaseUrl || !serviceRoleKey) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from .env.local')
if (!geminiApiKey) throw new Error('GEMINI_API_KEY missing from .env.local')

const supabase = createClient(supabaseUrl, serviceRoleKey)

async function resolveUserId(): Promise<string> {
  if (allowedUserId) return allowedUserId
  const { data, error } = await supabase.from('community_patterns').select('user_id').limit(1).single()
  if (error) throw error
  return (data as { user_id: string }).user_id
}

async function sampleTitles(n: number): Promise<string[]> {
  let query = supabase
    .from('community_patterns')
    .select('source_title')
    .not('source_title', 'is', null)
    .order('last_seen', { ascending: false })
    .limit(n)
  if (allowedUserId) query = query.eq('user_id', allowedUserId)
  const { data, error } = await query
  if (error) throw error
  return (data as { source_title: string }[]).map((r) => r.source_title)
}

async function sampleUrls(n: number): Promise<string[]> {
  let query = supabase
    .from('community_patterns')
    .select('source_urls')
    .not('source_urls', 'is', null)
    .order('last_seen', { ascending: false })
    .limit(n * 3)
  if (allowedUserId) query = query.eq('user_id', allowedUserId)
  const { data, error } = await query
  if (error) throw error
  const urls = (data as { source_urls: string[] | null }[])
    .flatMap((r) => r.source_urls ?? [])
  return urls.slice(0, n)
}

async function runOne(userId: string, text: string) {
  console.log('\n' + '='.repeat(72))
  console.log('POST: ' + text)
  console.log('='.repeat(72))

  const { investigation: inv, normalized_issue, similar, verified, trusted, solved, support, source, solved_dropped, errors } =
    await buildInvestigation(supabase as never, userId, text, geminiApiKey!)

  console.log(`\n  ${inv.case_kind.toUpperCase()}  (confidence: ${inv.confidence})`)
  console.log(`  ${inv.one_liner}`)
  if (source) console.log(`  fetched thread: ${source.title}`)
  console.log(`  matched on: ${normalized_issue}`)
  console.log(`  evidence: ${similar.length} past case(s), ${verified.length} verified answer(s), ${trusted.length} trusted repl(y/ies), ${solved.length} solved thread(s), ${support.length} support doc(s)`)

  if (solved.length) {
    console.log('\n  SOLVED THREADS')
    for (const c of solved) {
      const tag = c.reason === 'accepted_answer'
        ? 'CORRECT ANSWER'
        : c.reason === 'confirmed_by_asker' ? 'ASKER CONFIRMED' : 'looks like a fix'
      console.log(`   [${tag}] ${c.title}`)
      console.log(`      ${c.url}`)
      console.log(`      by ${c.answer.author ?? 'unknown'}${c.answer.badge ? ` (${c.answer.badge})` : ''}: ${c.answer.text.slice(0, 160).replace(/\s+/g, ' ')}…`)
    }
  }

  if (support.length) {
    console.log('\n  SUPPORT DOCS')
    for (const doc of support) {
      console.log(`   ${doc.title}`)
      console.log(`      ${doc.url}`)
      console.log(`      ${doc.excerpt.slice(0, 160).replace(/\s+/g, ' ')}…`)
    }
  }

  console.log('\n  STEPS')
  inv.steps.forEach((s, i) => {
    console.log(`   ${i + 1}. ${s.text}`)
    if (s.cite) {
      const id = s.cite.startsWith('[SD:') ? s.cite.slice(4, -1) : s.cite.slice(3, -1)
      const label = s.cite.startsWith('[C:')
        ? similar.find((p) => p.id === id)?.source_title ?? similar.find((p) => p.id === id)?.issue_summary
        : s.cite.startsWith('[S:')
          ? solved.find((c) => c.url === id)?.title
          : s.cite.startsWith('[SD:')
            ? support.find((d) => d.url === id)?.title
            : s.cite.startsWith('[T:')
              ? trusted.find((t) => t.id === id)?.question_summary
              : verified.find((v) => v.id === id)?.question_summary
      console.log(`      from: ${label ?? s.cite}`)
    }
  })

  if (inv.questions_to_ask.length) {
    console.log('\n  ASK THE CUSTOMER')
    inv.questions_to_ask.forEach((q) => console.log(`   - ${q.text}${q.why ? `  (${q.why})` : ''}`))
  }
  if (inv.watch_out.length) {
    console.log('\n  WATCH OUT')
    inv.watch_out.forEach((w) => console.log(`   - ${w}`))
  }
  if (solved_dropped.length) {
    console.log('\n  DROPPED CANDIDATES')
    for (const d of solved_dropped) console.log(`   - ${d.reason}\n     ${d.url}`)
  }
  if (errors.length) console.log('\n  ERRORS: ' + errors.join('; '))
}

async function main() {
  const args = process.argv.slice(2)
  const sampleArg = args.indexOf('--sample')
  const userId = await resolveUserId()

  // --sample-urls pulls real source_urls instead of titles, which is how the
  // link-paste path gets exercised without hunting for a url by hand.
  const urlArg = args.indexOf('--sample-urls')
  const texts = urlArg >= 0
    ? await sampleUrls(Number(args[urlArg + 1]) || 2)
    : sampleArg >= 0
      ? await sampleTitles(Number(args[sampleArg + 1]) || 2)
      : [args.join(' ').trim()]

  if (!texts.length || !texts[0]) {
    console.log('Pass a post title, or --sample N to pull real ones from the Library.')
    return
  }
  for (const text of texts) await runOne(userId, text)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
