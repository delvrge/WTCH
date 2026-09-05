'use client'

import { useState } from 'react'
import { callWatchFn } from '@/lib/functions'
import { errorMessage } from '@/lib/supabase'
import { toast } from '@/components/Toast'
import { resolveCite } from '@/lib/investigate'
import type { InvestigateResponse, SolvedReason } from '@/lib/investigate'
import type { SaveVerifiedResponse } from '@/lib/types'
import { plainTextToEditableHtml } from '@/lib/richText'

// The Dashboard's output: how to WORK the case. Deliberately plain and
// scannable — this gets read while the operator is mid-queue, not studied.
//
// `case_kind` is the first thing shown because it changes what the rest of
// the panel means: a closeable case is answered and closed, and carries no
// questions at all, while an investigation names what still has to be found
// out before anything can be concluded.

// How the thread earned its place in the list. Worth showing plainly: the
// operator should be able to tell "the asker said this worked" apart from
// "a model read it and thought it looked like a fix".
const SOLVED_LABEL: Record<SolvedReason, string> = {
  accepted_answer: 'Correct Answer',
  confirmed_by_asker: 'Asker confirmed',
  verified_fix: 'Looks like a fix',
}

const KIND_LABEL: Record<InvestigateResponse['investigation']['case_kind'], string> = {
  closeable: 'Answer and close',
  needs_investigation: 'Needs investigation',
}

// A community reply is always written to the person who originally asked, so
// its greeting names them by real name. Reused verbatim for a DIFFERENT
// customer, that name is simply wrong. Rather than guess-strip whatever
// greeting is there, replace it outright with a fixed "@user" placeholder the
// operator can spot and swap for the real name before sending — a standard
// shape instead of a name-detection problem. The blank line after it is a
// deliberate soft break (this app's replies use \n as Shift+Enter, not \n\n
// as a paragraph mark — see ReplyBlock's copy()), so "Hi @user," / blank /
// body renders exactly as typed.
//
// The comma/! is the required boundary, not a following newline: the
// platform's scraped text collapses paragraph breaks, so a real greeting is routinely
// glued straight onto the sentence after it ("Hi James123,Thanks for
// flagging...") with no whitespace at all.
const GREETING_RE = /^(hi|hello|hey|dear)[ \t]+[^,\n!]{1,60}[,!][ \t]*\n*/i

// A named sign-off ("Cheers, Nate" / "Thanks,\nJane") at the very end. This
// is a template for a DIFFERENT case, so whichever CM answered the original
// thread should not appear to have signed this one.
const SIGNOFF_RE = /[ \t]*\n{0,2}\s*(cheers|regards|best regards|kind regards|warm regards|best|thanks|thank you|sincerely)[,!]?\s*\n?\s*[A-Za-zÀ-ÖØ-öø-ÿ'’.\- ]{0,40}[.!]?\s*$/i

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// The platform's scraped reply text often runs straight into the signature with no
// separator at all (paragraph breaks collapse in the source), so a keyword
// like "Cheers," is not always there to anchor on — see SIGNOFF_RE. When the
// author is known (every solved-thread/trusted-reply card carries one), a
// trailing occurrence of THEIR actual name is unambiguous and safe to strip
// even with no keyword in front of it, unlike a generic trailing-word guess.
function stripAuthorName(text: string, author: string | null): string {
  if (!author?.trim()) return text
  const full = author.trim()
  const first = full.split(/\s+/)[0]
  for (const name of [full, first]) {
    if (!name || name.length < 3) continue
    const re = new RegExp(`[\\s.,!]*${escapeRegExp(name)}[.!]?\\s*$`, 'i')
    if (re.test(text)) return text.replace(re, '').trimEnd()
  }
  return text
}

function cleanBody(text: string, author: string | null): string {
  // The platform's export leaves a stray zero-width space at the very start of some
  // replies (invisible, but it defeats .trim() and blocks GREETING_RE from
  // anchoring at ^).
  let body = text.replace(/^[\u200B\uFEFF]+/, '').trim()
  body = body.replace(SIGNOFF_RE, '').trimEnd()
  body = stripAuthorName(body, author)
  body = body.replace(GREETING_RE, '').trimStart()
  return body
}

function withStandardGreeting(text: string, author: string | null): string {
  return `Hi @user,\n\n${cleanBody(text, author)}`
}

// Same cleanup as withStandardGreeting, but for two or more solved-thread
// answers merged into a single reply: each answer is stripped of its own
// greeting/signoff/author independently (they came from different threads,
// so each carries its own), then joined under one shared greeting so the
// customer gets one coherent reply instead of two stitched-together emails.
function withCombinedGreeting(items: { text: string; author: string | null }[]): string {
  const bodies = items.map((item) => cleanBody(item.text, item.author))
  return `Hi @user,\n\n${bodies.join('\n\n---\n\n')}`
}

// The scraped answer's screenshots (see SolvedCase.answer.images) — real
// attachments, not the decorative signature graphics already filtered out
// server-side — appended after the text so a saved reply keeps them instead
// of silently dropping them the way plain reply_text always did.
function imagesToHtml(images: string[] | undefined | null): string {
  return (images ?? []).map((url) => `<p><img src="${url}" alt="Attached screenshot"></p>`).join('')
}

function bodyHtml(text: string, author: string | null, images: string[]): string {
  return `${plainTextToEditableHtml(`Hi @user,\n\n${cleanBody(text, author)}`)}${imagesToHtml(images)}`
}

function combinedBodyHtml(items: { text: string; author: string | null; images: string[] }[]): string {
  const bodies = items.map((item) => cleanBody(item.text, item.author))
  const html = plainTextToEditableHtml(`Hi @user,\n\n${bodies.join('\n\n---\n\n')}`)
  const images = items.flatMap((item) => item.images)
  return `${html}${imagesToHtml(images)}`
}

export default function InvestigationPanel({ data }: { data: InvestigateResponse }) {
  const { investigation: inv, similar, verified, trusted, solved, support } = data

  // Per-card save state, keyed so a solved thread and a trusted reply can
  // never collide.
  const [saveState, setSaveState] = useState<Record<string, 'saving' | 'saved' | 'error'>>({})

  // Solved-thread cards the operator has checked off to merge into one
  // reply, keyed the same way as saveState/the card's own key. Holding the
  // text+author here (not just the key) means the merge button doesn't need
  // to re-look-up which card each key belongs to.
  const [selected, setSelected] = useState<Record<string, { text: string; author: string | null; images: string[] }>>({})
  const [mergeState, setMergeState] = useState<'saving' | 'saved' | 'error' | null>(null)

  function toggleSelected(key: string, text: string, author: string | null, images: string[]) {
    setSelected((s) => {
      const next = { ...s }
      if (next[key]) delete next[key]
      else next[key] = { text, author, images }
      return next
    })
    setMergeState(null)
  }

  async function saveMergedToReplies() {
    const items = Object.values(selected)
    if (items.length < 2 || mergeState === 'saving' || mergeState === 'saved') return
    setMergeState('saving')
    try {
      await callWatchFn<SaveVerifiedResponse>('save-verified', {
        pattern_ids: patternId ? [patternId] : [],
        source_url: sourceUrl,
        reply_text: withCombinedGreeting(items),
        answer_html: combinedBodyHtml(items),
        question_summary: data.normalized_issue,
        source: 'ai_draft',
      })
      setMergeState('saved')
    } catch (err) {
      setMergeState('error')
      toast.error(errorMessage(err, 'Could not save.'))
    }
  }

  // The reply being saved is FOR the case just pasted, not for whichever past
  // thread the answer was copied from — so it links to THIS case's own
  // auto-collected pattern/url, same as the pre-removal Dashboard draft flow
  // did. Both are null when auto-collect itself failed; save-verified still
  // works with a null pattern/url, it just links nothing.
  const patternId = data.auto_collected?.pattern_id ?? null
  const sourceUrl = data.source?.url ?? null

  async function saveToReplies(key: string, answerText: string, author: string | null, images: string[]) {
    if (saveState[key] === 'saving' || saveState[key] === 'saved') return
    setSaveState((s) => ({ ...s, [key]: 'saving' }))
    try {
      await callWatchFn<SaveVerifiedResponse>('save-verified', {
        pattern_ids: patternId ? [patternId] : [],
        source_url: sourceUrl,
        reply_text: withStandardGreeting(answerText, author),
        answer_html: bodyHtml(answerText, author, images),
        question_summary: data.normalized_issue,
        source: 'ai_draft',
      })
      setSaveState((s) => ({ ...s, [key]: 'saved' }))
    } catch (err) {
      setSaveState((s) => ({ ...s, [key]: 'error' }))
      toast.error(errorMessage(err, 'Could not save.'))
    }
  }

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row">
        <span className={inv.case_kind === 'closeable' ? 'chip chip-question' : 'chip chip-bug'}>
          {KIND_LABEL[inv.case_kind]}
        </span>
        <span className="meta">confidence: {inv.confidence}</span>
        <span className="grow" />
        <span className="meta">
          {similar.length} past case{similar.length === 1 ? '' : 's'}
          {verified.length ? `, ${verified.length} verified answer${verified.length === 1 ? '' : 's'}` : ''}
          {trusted.length ? `, ${trusted.length} trusted repl${trusted.length === 1 ? 'y' : 'ies'}` : ''}
          {solved.length ? `, ${solved.length} solved thread${solved.length === 1 ? '' : 's'}` : ''}
          {support.length ? `, ${support.length} support doc${support.length === 1 ? '' : 's'}` : ''}
        </span>
      </div>

      {/* Proof the tool read the real post rather than the one line pasted.
          Absent when free text was pasted, or the fetch failed and it fell
          back — in which case the errors list below says so. */}
      {data.source ? (
        <p className="meta">
          Read from:{' '}
          <a href={data.source.url} target="_blank" rel="noreferrer noopener">{data.source.title}</a>
        </p>
      ) : null}

      <p className="row-title">{inv.one_liner}</p>

      {inv.watch_out.length ? (
        <div className="stack" style={{ gap: 4 }}>
          {inv.watch_out.map((w, i) => (
            <p key={i} className="muted">Watch out: {w}</p>
          ))}
        </div>
      ) : null}

      {inv.steps.length ? (
        <ol className="stack" style={{ gap: 8, paddingLeft: 20, margin: 0 }}>
          {inv.steps.map((step, i) => {
            const cite = resolveCite(step.cite, similar, verified, solved, support, trusted)
            return (
              <li key={i}>
                <span>{step.text}</span>
                {cite ? (
                  <div className="meta">
                    from:{' '}
                    {cite.url ? (
                      <a href={cite.url} target="_blank" rel="noreferrer noopener">{cite.label}</a>
                    ) : (
                      cite.label
                    )}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="muted">No steps returned.</p>
      )}

      {inv.questions_to_ask.length ? (
        <div className="stack" style={{ gap: 8 }}>
          <p className="card-title">Ask the customer</p>
          {inv.questions_to_ask.map((q, i) => (
            <div key={i} className="card">
              <p>{q.text}</p>
              {q.why ? <p className="meta">{q.why}</p> : null}
            </div>
          ))}
        </div>
      ) : null}

      {solved.length || support.length ? (
        <div className="dashboard-bottom">
          {solved.length ? (
            <div className="stack" style={{ gap: 8 }}>
              <div className="row">
                <p className="card-title grow">Solved threads</p>
                {Object.keys(selected).length >= 2 ? (
                  <button
                    type="button"
                    className="btn"
                    onClick={saveMergedToReplies}
                    disabled={mergeState === 'saving' || mergeState === 'saved'}
                  >
                    {mergeState === 'saved' ? 'Saved merged reply'
                      : mergeState === 'saving' ? 'Saving'
                      : `Merge ${Object.keys(selected).length} into one reply`}
                  </button>
                ) : null}
              </div>
              {solved.map((c) => {
                const key = `s-${c.url}`
                // Older investigate results — a sessionStorage-restored
                // Dashboard run, or a stale investigation_log replay — were
                // saved before `images` existed on this shape at all.
                const images = c.answer.images ?? []
                return (
                  <div key={c.url} className="card">
                    <div className="row">
                      <input
                        type="checkbox"
                        aria-label="Select for merged reply"
                        checked={Boolean(selected[key])}
                        onChange={() => toggleSelected(key, c.answer.text, c.answer.author, images)}
                      />
                      <a href={c.url} target="_blank" rel="noreferrer noopener" className="grow row-title">
                        {c.title}
                      </a>
                      <span className={c.reason === 'verified_fix' ? 'chip' : 'chip chip-question'}>
                        {SOLVED_LABEL[c.reason]}
                      </span>
                    </div>
                    <p className="excerpt">{c.answer.text}</p>
                    <p className="meta">
                      {c.answer.author ?? 'unknown'}
                      {c.answer.badge ? ` · ${c.answer.badge}` : ''}
                      {c.board ? ` · ${c.board}` : ''}
                      {images.length ? ` · 📎 ${images.length}` : ''}
                    </p>
                    <div className="row">
                      <button
                        type="button"
                        className="btn"
                        onClick={() => saveToReplies(key, c.answer.text, c.answer.author, images)}
                        disabled={saveState[key] === 'saving' || saveState[key] === 'saved'}
                      >
                        {saveState[key] === 'saved' ? 'Saved to Replies'
                          : saveState[key] === 'saving' ? 'Saving'
                          : 'Save to Replies'}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : null}

          {support.length ? (
            <div className="stack" style={{ gap: 8 }}>
              <p className="card-title">Support docs</p>
              {support.map((doc) => (
                <div key={doc.url} className="card">
                  <a href={doc.url} target="_blank" rel="noreferrer noopener" className="row-title">
                    {doc.title}
                  </a>
                  <p className="excerpt">{doc.excerpt}</p>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {similar.length ? (
        <div className="stack" style={{ gap: 8 }}>
          <p className="card-title">Similar past cases</p>
          {similar.map((p) => (
            <div key={p.id} className="card">
              <div className="row">
                {p.source_urls[0] ? (
                  <a href={p.source_urls[0]} target="_blank" rel="noreferrer noopener" className="grow row-title">
                    {p.source_title || p.issue_summary}
                  </a>
                ) : (
                  <span className="grow row-title">{p.source_title || p.issue_summary}</span>
                )}
                <span className="meta-strong">{Math.round(p.similarity * 100)}%</span>
              </div>
              <p className="excerpt">{p.typical_approach}</p>
              {p.topic ? <p className="meta">{p.topic}{p.subtopic ? ` / ${p.subtopic}` : ''}</p> : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="muted">
          Nothing in the Library matched this closely enough to ground a walkthrough.
        </p>
      )}

      {/* What the search actually ran on. When a walkthrough looks wrong,
          this line is usually the reason, so it stays visible rather than
          hidden behind a toggle. */}
      <p className="meta">Matched on: {data.normalized_issue}</p>

      {data.errors.length ? (
        <div className="stack" style={{ gap: 4 }}>
          {data.errors.map((e, i) => <p key={i} className="error">{e}</p>)}
        </div>
      ) : null}
    </div>
  )
}
