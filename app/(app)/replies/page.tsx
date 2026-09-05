'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { errorMessage, supabaseClient } from '@/lib/supabase'
import { callWatchFn } from '@/lib/functions'
import { usDate, plural } from '@/lib/format'
import { TOPIC_TAXONOMY, TOPICS } from '@/lib/topic-taxonomy'
import RichTextEditor, { type RichTextEditorHandle } from '@/components/RichTextEditor'
import { plainTextToEditableHtml } from '@/lib/richText'
import { deleteReplyImage, imagesAsDataUris, signImagePaths } from '@/lib/replyImages'
import type { SaveVerifiedResponse, VerifiedAnswer, VerifiedAnswerCase, VerifiedAnswerImage } from '@/lib/types'

interface ReplyForm {
  category: string
  subcategory: string
  question_summary: string
  source_url: string
  verified: boolean
  /** The community_patterns rows (open cases) this reply answers — a reply can cover more than one (verified_answer_cases). Empty = unlinked. */
  pattern_ids: string[]
}

const EMPTY_FORM: ReplyForm = {
  category: '',
  subcategory: '',
  question_summary: '',
  source_url: '',
  verified: true,
  pattern_ids: [],
}

interface CaseOption {
  id: string
  label: string
  url: string | null
}

// Rows with no category at all are collected under one trailing group
// instead of being scattered or hidden.
const UNCLUSTERED_KEY = '__unclustered__'

// A row that has a category but no subcategory still needs a Level-2 tile to
// live under — this is that catch-all subcategory within a given category,
// distinct from the top-level Uncategorized bucket (which is for no category
// at all).
const NO_SUBCATEGORY_KEY = '__no_subcategory__'

// The taxonomy stopped being enforced by the database (see the
// subcategory_free_text migration) — category and subcategory are now both
// plain text. The dropdowns still seed the fixed 9 topics/27 subtopics
// (existingCategories / existingSubcategoriesByCategory) so Context and
// Replies always offer the same set, but a reply isn't restricted to
// it — "+ Add new" introduces anything the fixed list doesn't cover, from a
// reply's own Category/Subcategory fields.
const ADD_NEW = '__add_new__'

// A reply already filed under a category shows only that category plus this
// option in its Category dropdown — the full list only appears once this is
// picked. Prevents a card already inside "Video Generation" from looking
// like it can casually be dropped onto "Image Generation" at a glance; the
// operator has to deliberately ask to see other categories first.
const MOVE_TO_OTHER = '__move_to_other__'

function optionsWithCurrent(existing: string[], current: string): string[] {
  const set = new Set(existing)
  if (current) set.add(current)
  return [...set]
}

// Reply text is operator-written prose, but it still goes into an HTML
// clipboard payload, so anything that looks like markup has to be neutralised
// or it would alter the pasted result.
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

interface ReplyGroup {
  key: string
  label: string
  /** Parent topic, off TOPIC_BY_SUBTOPIC — null for Unclustered. */
  topic: string | null
  rows: VerifiedAnswer[]
}

// Seeds the rich editor when opening an existing reply. A row with
// answer_html reopens exactly as formatted; a plain legacy row (or an
// AI-drafted one — stage-ai-drafts/generate-replies never set answer_html)
// gets its real newlines converted to the same per-line <div> shape typing
// Enter in the editor would itself produce, so it doesn't collapse into one
// run the moment it's opened for editing.
function editableHtmlFromRow(row: VerifiedAnswer): string {
  return row.answer_html || plainTextToEditableHtml(row.answer_text)
}

// Checkbox list standing in for a native multi-select. Shows only the
// currently-linked cases by default — at 45+ open cases, a flat list of
// everything is nothing an operator can scan — and only searches the full
// case list once something is typed, so linking a new case is "search, then
// check" rather than "scroll the whole thing".
function CaseMultiSelect({
  caseOptions,
  selected,
  onToggle,
}: {
  caseOptions: CaseOption[]
  selected: string[]
  onToggle: (patternId: string, checked: boolean) => void
}) {
  const [query, setQuery] = useState('')
  const trimmed = query.trim().toLowerCase()
  const selectedSet = new Set(selected)
  const visible = trimmed
    ? caseOptions.filter(c => c.label.toLowerCase().includes(trimmed))
    : caseOptions.filter(c => selectedSet.has(c.id))

  // caseOptions arrives newest-first (last_seen desc), so its first not-yet-
  // linked entry is the most recently added open case — a one-click shortcut
  // for the common "link the case I was just looking at" save, without
  // typing anything into the search box. Hidden the moment a search is
  // typed, so it never fights the actual filtered results.
  const suggestion = !trimmed ? caseOptions.find(c => !selectedSet.has(c.id)) : undefined

  return (
    <div className="stack" style={{ gap: 6 }}>
      {caseOptions.length ? (
        <input
          type="text"
          className="case-multiselect-filter"
          placeholder={`Search ${caseOptions.length} cases to link...`}
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
      ) : null}
      {suggestion ? (
        <button
          type="button"
          className="case-multiselect-suggestion"
          onClick={() => onToggle(suggestion.id, true)}
          title="Most recently added open case"
        >
          + Link last added: {suggestion.label}
        </button>
      ) : null}
      <div className="case-multiselect">
        {caseOptions.length ? (
          visible.length ? (
            visible.map(c => (
              <label key={c.id} className="case-multiselect-option">
                <input
                  type="checkbox"
                  checked={selectedSet.has(c.id)}
                  onChange={e => onToggle(c.id, e.target.checked)}
                />
                <span>{c.label}</span>
              </label>
            ))
          ) : trimmed ? (
            <p className="meta">No cases match "{query}".</p>
          ) : (
            <p className="meta">No cases linked yet. Search above to add one.</p>
          )
        ) : (
          <p className="meta">No open cases to link.</p>
        )}
      </div>
    </div>
  )
}

// One reply, always shown in its full editable shape (Category, Subcategory,
// Question, Answer, Linked cases) — there is no separate "view" mode to
// click into Edit from. Local state seeds once from `row` and `linkedIds` on
// mount (this instance is keyed by row.id in the parent list, so a genuinely
// different reply gets a fresh instance) and Save persists all of it in one
// save-verified call, same endpoint the old Add/Edit forms used.
function ReplyCard({
  row,
  linkedIds,
  caseOptions,
  existingCategories,
  existingSubcategoriesByCategory,
  images,
  signedUrls,
  imageError,
  highlighted,
  copied,
  setRef,
  onToggleVerified,
  onToggleCase,
  onCopy,
  onDelete,
  onRemoveImage,
  onSaved,
}: {
  row: VerifiedAnswer
  linkedIds: string[]
  caseOptions: CaseOption[]
  /** Every category a reply already carries — what the Category dropdown offers, not the fixed taxonomy. */
  existingCategories: string[]
  /** Same, one subcategory list per category, off the same live reply data. */
  existingSubcategoriesByCategory: Map<string, string[]>
  images: VerifiedAnswerImage[]
  signedUrls: Map<string, string>
  imageError?: string
  highlighted: boolean
  copied: boolean
  setRef: (el: HTMLDivElement | null) => void
  onToggleVerified: () => void
  /** Links/unlinks a case immediately (its own write, not part of Save) — see the parent's toggleCaseLink doc comment. */
  onToggleCase: (patternId: string, checked: boolean) => void
  onCopy: () => void
  onDelete: () => void
  onRemoveImage: (image: VerifiedAnswerImage) => void
  onSaved: () => Promise<void>
}) {
  const editorRef = useRef<RichTextEditorHandle>(null)
  const [category, setCategory] = useState(row.category || '')
  // A legacy row can carry a category with no subcategory at all — every
  // reply should be filed under a real subcategory, so default to the
  // category's first known one rather than leaving this blank.
  const [subcategory, setSubcategory] = useState(
    row.subcategory || existingSubcategoriesByCategory.get(row.category || '')?.[0] || '',
  )
  // Whether the Category dropdown is showing the full list of categories to
  // move this reply into, rather than just its current one — see MOVE_TO_OTHER.
  const [pickingCategory, setPickingCategory] = useState(false)
  const [questionSummary, setQuestionSummary] = useState(row.question_summary)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSave() {
    const { text: answerText, html: answerHtml } = editorRef.current?.getContent() ?? { text: '', html: null }
    const answer_text = answerText.trim()
    const question_summary = questionSummary.trim()
    if (!question_summary || !answer_text) {
      setError('Question and answer are both required.')
      return
    }
    setError('')
    setSaving(true)
    try {
      await callWatchFn<SaveVerifiedResponse>('save-verified', {
        id: row.id,
        category: category.trim() || null,
        subcategory: subcategory.trim() || null,
        question_summary,
        reply_text: answer_text,
        answer_html: answerHtml,
        // pattern_ids omitted on purpose — linked cases now save immediately
        // via onToggleCase, not as part of this button. Sending it here
        // would re-sync against whatever this instance's props say, which is
        // redundant at best and a stale overwrite at worst.
        verified: row.verified,
      })
      await onSaved()
    } catch (err) {
      setError(errorMessage(err, 'Could not save.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      ref={setRef}
      className={`reply-item stack${row.verified ? ' reply-item-verified' : ''}${highlighted ? ' reply-item-highlight' : ''}`}
    >
      <div className="row">
        <button
          type="button"
          className={`verify-toggle${row.verified ? ' verify-toggle-on' : ''}`}
          role="switch"
          aria-checked={row.verified}
          title={row.verified ? 'Verified — click to unverify' : 'Not verified — click to verify'}
          onClick={onToggleVerified}
        >
          <span className="verify-toggle-knob" />
        </button>
        <span className="meta">{row.verified ? 'Verified' : 'Unverified'}</span>
        <span className="meta">{usDate(row.verified_at)}</span>
        {row.added_by ? <span className="meta">Added by {row.added_by}</span> : null}
        <span className="spacer" />
        <button type="button" className="btn" onClick={onCopy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="btn" onClick={onDelete}>
          Delete
        </button>
      </div>

      <div className="row">
        <div className="field field-inline">
          <label htmlFor={`${row.id}-category`}>Category</label>
          <select
            id={`${row.id}-category`}
            value={category}
            onChange={e => {
              const next = e.target.value
              if (next === MOVE_TO_OTHER) {
                setPickingCategory(true)
                return
              }
              if (next === ADD_NEW) {
                const typed = window.prompt('New category name:')?.trim()
                if (typed) setCategory(typed)
                setPickingCategory(false)
                return
              }
              setCategory(next)
              setPickingCategory(false)
              // A leftover subcategory from the previous category would
              // silently point at the wrong one. Default to the new
              // category's first known subcategory instead of leaving this
              // blank — there is no "None" to fall back to.
              const subtopics = existingSubcategoriesByCategory.get(next) ?? []
              if (!subtopics.includes(subcategory)) setSubcategory(subtopics[0] ?? '')
            }}
          >
            {pickingCategory ? (
              <>
                <option value="">None</option>
                {optionsWithCurrent(existingCategories, category).map(t => <option key={t} value={t}>{t}</option>)}
                <option value={ADD_NEW}>+ Add new category…</option>
              </>
            ) : (
              <>
                <option value={category}>{category || 'None'}</option>
                <option value={MOVE_TO_OTHER}>Move to another category…</option>
              </>
            )}
          </select>
        </div>
        <div className="field field-inline">
          <label htmlFor={`${row.id}-subcategory`}>Subcategory</label>
          <select
            id={`${row.id}-subcategory`}
            value={subcategory}
            onChange={e => {
              const next = e.target.value
              if (next === ADD_NEW) {
                const typed = window.prompt('New subcategory name:')?.trim()
                if (typed) setSubcategory(typed)
                return
              }
              setSubcategory(next)
            }}
            disabled={!category}
          >
            {category ? (
              <>
                {optionsWithCurrent(existingSubcategoriesByCategory.get(category) ?? [], subcategory).map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
                <option value={ADD_NEW}>+ Add new subcategory…</option>
              </>
            ) : (
              <option value="">Pick a category first</option>
            )}
          </select>
        </div>
      </div>

      <div className="field">
        <label htmlFor={`${row.id}-question`}>Question / issue</label>
        <textarea
          id={`${row.id}-question`}
          rows={2}
          value={questionSummary}
          onChange={e => setQuestionSummary(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor={`${row.id}-answer`}>Answer</label>
        <RichTextEditor ref={editorRef} initialHtml={editableHtmlFromRow(row)} placeholder="The reply that actually worked" />
      </div>

      <div className="field">
        <label>Linked cases</label>
        <CaseMultiSelect caseOptions={caseOptions} selected={linkedIds} onToggle={onToggleCase} />
      </div>

      {error ? <p className="error">{error}</p> : null}

      <div className="row">
        <button type="button" className="btn primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving' : 'Save'}
        </button>
      </div>

      {images.length ? (
        <div className="reply-images">
          {images.map(img => {
            const url = signedUrls.get(img.storage_path)
            return (
              <div key={img.id} className="reply-image-thumb">
                {url ? (
                  <a href={url} target="_blank" rel="noreferrer noopener">
                    <img src={url} alt="Attached screenshot" />
                  </a>
                ) : null}
                <button
                  type="button"
                  className="reply-image-remove"
                  onClick={() => onRemoveImage(img)}
                  title="Remove image"
                >
                  ✕
                </button>
              </div>
            )
          })}
        </div>
      ) : null}
      {imageError ? <p className="error">{imageError}</p> : null}
    </div>
  )
}

export default function RepliesPage() {
  const [rows, setRows] = useState<VerifiedAnswer[]>([])
  // Open cases (community_patterns) to link a reply to — the Library screen
  // is pure case tracking now, so this is the only place left to associate a
  // reply with the post it answers, other than the automatic pattern_id a
  // saved Dashboard draft or a staged AI draft already arrives with.
  const [caseOptions, setCaseOptions] = useState<CaseOption[]>([])
  // Raw verified_answer_cases rows — the many-to-many link between a reply
  // and the case(s) it answers. patternIdsByAnswerId below is the shape
  // everything else actually reads.
  const [caseLinks, setCaseLinks] = useState<VerifiedAnswerCase[]>([])
  const [imagesByAnswer, setImagesByAnswer] = useState<Map<string, VerifiedAnswerImage[]>>(new Map())
  const [signedUrls, setSignedUrls] = useState<Map<string, string>>(new Map())
  const [error, setError] = useState('')

  // Categories created via "Add category" ahead of any reply using them —
  // reply_categories rows. Merged into existingCategories below alongside
  // whatever verified_answers.category already has in use, so a freshly
  // created one is immediately pickable in the Category dropdown.
  const [createdCategories, setCreatedCategories] = useState<string[]>([])
  const [addingCategory, setAddingCategory] = useState(false)


  // Manual entry — a reply the operator already knows works (answered
  // elsewhere, remembered from experience) with no AI draft or thread
  // behind it. Goes through save-verified (same function ReplyBlock's "Save
  // to Replies" calls) rather than a raw insert, so the question_summary
  // gets embedded — without that, match_verified_answers never surfaces the
  // row and it's saved but effectively unsearchable. `tracked` gates
  // whether it also grounds/gets cited in future drafts — a plain personal
  // record doesn't have to become a source.
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState<ReplyForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const addEditorRef = useRef<RichTextEditorHandle>(null)

  // Two-level nav: the top grid is Categories (topics); clicking one opens
  // its Subcategories (subtopics); clicking one of those opens its replies.
  // null openTopicKey = showing the category grid. null openBoxKey (with a
  // topic open) = showing that topic's subcategory grid. Both set = showing
  // one subcategory's replies.
  const [openTopicKey, setOpenTopicKey] = useState<string | null>(null)
  const [openBoxKey, setOpenBoxKey] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [imageErrors, setImageErrors] = useState<Record<string, string>>({})

  // Deep-link support: Cases' Reply chip links here as /replies?reply=<id> so
  // clicking "Verified" lands on the actual reply text, not just the grid.
  // highlightId drives a brief visual flash so the operator's eye finds it
  // immediately inside a tile that may hold several replies. dataReady gates
  // the effect that resolves the deep link until rows have actually loaded.
  const [dataReady, setDataReady] = useState(false)
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const deepLinkApplied = useRef(false)
  const newForApplied = useRef(false)
  const replyRefs = useRef(new Map<string, HTMLDivElement>())

  const load = useCallback(async () => {
    setError('')
    try {
      const { data, error: readError } = await supabaseClient()
        .from('verified_answers')
        .select('*')
        .order('verified_at', { ascending: false })
      if (readError) throw new Error(readError.message)
      const loaded = (data || []) as VerifiedAnswer[]
      setRows(loaded)

      const { data: links, error: linksError } = await supabaseClient()
        .from('verified_answer_cases')
        .select('*')
      if (!linksError && links) {
        setCaseLinks(links as VerifiedAnswerCase[])
      } else {
        setCaseLinks([])
      }

      const { data: categoryRows, error: categoryError } = await supabaseClient()
        .from('reply_categories')
        .select('name')
        .order('name', { ascending: true })
      if (!categoryError && categoryRows) {
        setCreatedCategories((categoryRows as { name: string }[]).map(c => c.name))
      } else {
        setCreatedCategories([])
      }

      // Open cases to offer in the "Linked cases" picker — same inclusion
      // rule as the Library's case list (not rejected), newest first.
      const { data: patternRows, error: patternError } = await supabaseClient()
        .from('community_patterns')
        .select('id, source_title, issue_summary, source_url, source_urls, review_status, last_seen')
        .neq('review_status', 'rejected')
        .order('last_seen', { ascending: false })
      if (!patternError && patternRows) {
        setCaseOptions(
          (patternRows as {
            id: string
            source_title: string | null
            issue_summary: string
            source_url: string | null
            source_urls: string[] | null
          }[]).map(p => ({
            id: p.id,
            label: p.source_title?.trim() || p.issue_summary,
            url: p.source_url || (p.source_urls?.length ? p.source_urls[p.source_urls.length - 1] : null),
          })),
        )
      } else {
        setCaseOptions([])
      }

      const answerIds = loaded.map(r => r.id)
      if (answerIds.length) {
        const { data: images, error: imagesError } = await supabaseClient()
          .from('verified_answer_images')
          .select('*')
          .in('answer_id', answerIds)
          .order('created_at', { ascending: true })
        if (!imagesError && images) {
          const grouped = new Map<string, VerifiedAnswerImage[]>()
          for (const img of images as VerifiedAnswerImage[]) {
            const list = grouped.get(img.answer_id)
            if (list) list.push(img)
            else grouped.set(img.answer_id, [img])
          }
          setImagesByAnswer(grouped)
        } else {
          setImagesByAnswer(new Map())
        }
      } else {
        setImagesByAnswer(new Map())
      }
    } catch (err) {
      setRows([])
      setError(errorMessage(err, 'Could not load replies.'))
    } finally {
      setDataReady(true)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Signed URLs are generated on load and never persisted (the bucket is
  // private) — re-derive whenever the set of known image paths changes.
  const allPaths = useMemo(() => {
    const paths: string[] = []
    for (const list of imagesByAnswer.values()) {
      for (const img of list) paths.push(img.storage_path)
    }
    return paths
  }, [imagesByAnswer])

  useEffect(() => {
    let active = true
    const missing = allPaths.filter(p => !signedUrls.has(p))
    if (!missing.length) return
    signImagePaths(missing).then(map => {
      if (!active) return
      setSignedUrls(prev => {
        const next = new Map(prev)
        for (const [path, url] of map) next.set(path, url)
        return next
      })
    })
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allPaths])

  const patternIdsByAnswerId = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const link of caseLinks) {
      const list = map.get(link.answer_id)
      if (list) list.push(link.pattern_id)
      else map.set(link.answer_id, [link.pattern_id])
    }
    return map
  }, [caseLinks])

  // What the Category/Subcategory dropdowns actually offer — every category
  // and subcategory a reply already carries, live off `rows`, not the fixed
  // 9/27 taxonomy. New ones only enter this set via "+ Add new…" on a
  // reply's own fields, then show up here once saved and reloaded.
  const existingCategories = useMemo(() => {
    const set = new Set<string>()
    for (const name of TOPICS) set.add(name)
    for (const row of rows) if (row.category) set.add(row.category)
    for (const name of createdCategories) set.add(name)
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [rows, createdCategories])

  const existingSubcategoriesByCategory = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const { topic, subtopics } of TOPIC_TAXONOMY) map.set(topic, [...subtopics])
    for (const row of rows) {
      if (!row.category || !row.subcategory) continue
      const set = map.get(row.category)
      if (set) {
        if (!set.includes(row.subcategory)) set.push(row.subcategory)
      } else {
        map.set(row.category, [row.subcategory])
      }
    }
    return map
  }, [rows])

  // Keyed by the actual category+subcategory pair a reply carries (both free
  // text now — see the subcategory_free_text/reply_categories migrations),
  // not the old fixed 9/27 taxonomy. A row with a category but no
  // subcategory still needs somewhere to live under that category (see
  // NO_SUBCATEGORY_KEY); only a row with NO category at all falls all the
  // way out to the top-level Uncategorized bucket.
  const groups = useMemo<ReplyGroup[]>(() => {
    const map = new Map<string, { category: string; subcategory: string; rows: VerifiedAnswer[] }>()
    const unclustered: VerifiedAnswer[] = []
    for (const row of rows) {
      if (!row.category) {
        unclustered.push(row)
        continue
      }
      const subcategory = row.subcategory || NO_SUBCATEGORY_KEY
      const key = `${row.category}::${subcategory}`
      const entry = map.get(key)
      if (entry) entry.rows.push(row)
      else map.set(key, { category: row.category, subcategory, rows: [row] })
    }

    const populated: ReplyGroup[] = [...map.values()].map(({ category, subcategory, rows: groupRows }) => ({
      key: `${category}::${subcategory}`,
      label: subcategory === NO_SUBCATEGORY_KEY ? 'General' : subcategory,
      topic: category,
      rows: groupRows,
    }))

    // Rows arrive newest-first from the query and group insertion preserves
    // that order, so each group's first row is already its most recent reply.
    populated.sort((a, b) => (b.rows[0]?.verified_at || '').localeCompare(a.rows[0]?.verified_at || ''))

    return [...populated, { key: UNCLUSTERED_KEY, label: 'Uncategorized', topic: null, rows: unclustered }]
  }, [rows])

  // Resolved fresh from groups each render so an open box reflects edits,
  // deletes and moves immediately. Falls back to the grid if the box it
  // pointed at is gone.
  const openBox = openBoxKey ? groups.find(g => g.key === openBoxKey) || null : null

  // Top-level grid: one tile per topic that has at least one populated
  // subtopic, plus Unclustered — same shape as before subcategories existed
  // one level down. Unclustered has no subcategories of its own, so its tile
  // leads straight to its replies rather than to an empty subcategory grid.
  interface CategoryGroup {
    key: string
    label: string
    replyCount: number
    subtopicCount: number
  }
  const categoryGroups = useMemo<CategoryGroup[]>(() => {
    const byTopic = new Map<string, { replyCount: number; subtopicCount: number }>()
    // Every Context category (the fixed 9-topic taxonomy) gets a tile up
    // front, even with zero replies — Context and Replies must show the same
    // set of categories, not just whichever ones happen to have a reply yet.
    for (const name of TOPICS) byTopic.set(name, { replyCount: 0, subtopicCount: 0 })
    // Every category created via "Add category" gets a tile up front too,
    // even with zero replies — that's the whole point of registering one
    // ahead of time (see the reply_categories migration).
    for (const name of createdCategories) if (!byTopic.has(name)) byTopic.set(name, { replyCount: 0, subtopicCount: 0 })
    for (const g of groups) {
      if (g.key === UNCLUSTERED_KEY || !g.topic) continue
      const entry = byTopic.get(g.topic) ?? { replyCount: 0, subtopicCount: 0 }
      entry.replyCount += g.rows.length
      entry.subtopicCount += 1
      byTopic.set(g.topic, entry)
    }
    const populated = [...byTopic.entries()]
      .map(([topic, v]) => ({ key: topic, label: topic, ...v }))
      .sort((a, b) => a.label.localeCompare(b.label))
    const unclustered = groups.find(g => g.key === UNCLUSTERED_KEY)
    return [
      ...populated,
      { key: UNCLUSTERED_KEY, label: 'Uncategorized', replyCount: unclustered?.rows.length ?? 0, subtopicCount: 0 },
    ]
  }, [groups, createdCategories])

  // Subcategory tiles for whichever topic is open — Unclustered never
  // reaches this view (its tile opens replies directly), so this only ever
  // renders for a real topic.
  // Same "seed from the fixed taxonomy, overlay real rows" shape as
  // categoryGroups above — a fixed subtopic gets its tile the moment its
  // parent category is open, not just once a reply lands in it.
  const subtopicGroups = useMemo(() => {
    if (!openTopicKey) return []
    const bySubcategory = new Map<string, ReplyGroup>()
    for (const name of existingSubcategoriesByCategory.get(openTopicKey) ?? []) {
      bySubcategory.set(name, { key: `${openTopicKey}::${name}`, label: name, topic: openTopicKey, rows: [] })
    }
    for (const g of groups) {
      if (g.topic === openTopicKey) bySubcategory.set(g.label, g)
    }
    return [...bySubcategory.values()]
  }, [groups, openTopicKey, existingSubcategoriesByCategory])

  function openCategory(key: string) {
    if (key === UNCLUSTERED_KEY) {
      setOpenTopicKey(UNCLUSTERED_KEY)
      setOpenBoxKey(UNCLUSTERED_KEY)
    } else {
      setOpenTopicKey(key)
      setOpenBoxKey(null)
    }
  }

  function backToCategories() {
    setOpenTopicKey(null)
    setOpenBoxKey(null)
  }

  function backToSubcategories() {
    setOpenBoxKey(null)
  }

  // Reads ?reply=<verified_answers.id> from the URL once groups are ready,
  // opens the box that reply lives in (plus its parent category, so the
  // back button lands somewhere sensible) and flags it to flash+scroll into
  // view. A ref (not state) gates this to a single attempt per page load —
  // re-running on every groups update (e.g. after a Verify toggle) would
  // reopen the box the operator just navigated away from.
  useEffect(() => {
    if (deepLinkApplied.current) return
    if (!dataReady) return
    const targetId = new URLSearchParams(window.location.search).get('reply')
    deepLinkApplied.current = true
    if (!targetId) return
    const group = groups.find(g => g.rows.some(r => r.id === targetId))
    if (!group) return // stale link — the reply no longer exists
    setOpenTopicKey(group.topic ?? UNCLUSTERED_KEY)
    setOpenBoxKey(group.key)
    setHighlightId(targetId)
  }, [dataReady, groups])

  // Reads ?newFor=<CaseRow.id> from the URL once caseOptions are ready — the
  // Cases table's "No reply" chip lands here to compose a reply for that
  // case directly, instead of the bare grid. Pre-fills question/source/link
  // from the matching open case so the operator isn't hunting for it again
  // in the Linked cases search. A ref gates this to one attempt per page
  // load, same reasoning as the ?reply= deep link above.
  useEffect(() => {
    if (newForApplied.current) return
    if (!dataReady) return
    const caseKey = new URLSearchParams(window.location.search).get('newFor')
    newForApplied.current = true
    if (!caseKey) return
    const [kind, patternId] = caseKey.split(':')
    const option = kind === 'pattern' && patternId ? caseOptions.find(c => c.id === patternId) : undefined
    setForm({
      ...EMPTY_FORM,
      question_summary: option?.label ?? '',
      source_url: option?.url ?? '',
      pattern_ids: option ? [option.id] : [],
    })
    setFormError('')
    setAdding(true)
  }, [dataReady, caseOptions])

  // Scrolls the flagged reply into view once its box is open and rendered,
  // then clears the flash after a couple seconds — it's an arrival cue, not
  // a permanent state.
  useEffect(() => {
    if (!highlightId) return
    replyRefs.current.get(highlightId)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const timer = window.setTimeout(() => setHighlightId(null), 2500)
    return () => window.clearTimeout(timer)
  }, [highlightId, openBoxKey])

  // Put the whole reply — text and its images — on the clipboard in one go,
  // so pasting into the forum's rich editor carries both. text/html is what
  // a rich editor consumes; text/plain is the fallback for anywhere that
  // doesn't. A rich reply's images are already inline data URIs inside
  // answer_html (see RichTextEditor) — legacy verified_answer_images
  // attachments (pre-existing rows only; the editor no longer writes new
  // ones) are fetched and appended as base64 too, so the paste stays intact
  // after their signed URLs would have expired.
  async function copyReply(row: VerifiedAnswer) {
    setCopiedId(null)
    setError('')
    try {
      const legacyImages = imagesByAnswer.get(row.id) || []
      const legacyDataUris = await imagesAsDataUris(legacyImages)
      const legacyImgTags = legacyDataUris.map(uri => `<p><img src="${uri}" alt=""></p>`).join('')

      const html = row.answer_html
        ? `${row.answer_html}${legacyImgTags}`
        : `<div>${row.answer_text
            .split(/\n{2,}/)
            .map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
            .join('')}${legacyImgTags}</div>`

      if (typeof ClipboardItem === 'undefined') {
        // Safari/older browsers without ClipboardItem still get the text.
        await navigator.clipboard.writeText(row.answer_text)
      } else {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': new Blob([html], { type: 'text/html' }),
            'text/plain': new Blob([row.answer_text], { type: 'text/plain' }),
          }),
        ])
      }
      setCopiedId(row.id)
      window.setTimeout(() => setCopiedId(current => (current === row.id ? null : current)), 2000)
    } catch (err) {
      setError(errorMessage(err, 'Could not copy the reply.'))
    }
  }

  // One-click verify/unverify — separate from the edit form's checkbox so
  // reviewing an AI draft (the common case) doesn't require opening Edit
  // first. Flips the green-border state and, since match_verified_answers
  // and loadGrounding both gate on this column, whether the row can ground
  // or get cited in a future draft.
  async function toggleVerified(row: VerifiedAnswer) {
    const next = !row.verified
    setRows(prev => prev.map(r => (r.id === row.id ? { ...r, verified: next } : r)))
    setError('')
    try {
      const { error: updateError } = await supabaseClient()
        .from('verified_answers')
        .update({ verified: next })
        .eq('id', row.id)
      if (updateError) throw new Error(updateError.message)
    } catch (err) {
      setRows(prev => prev.map(r => (r.id === row.id ? { ...r, verified: row.verified } : r)))
      setError(errorMessage(err, 'Could not update verified status.'))
    }
  }

  // Links/unlinks one case immediately — its own write to
  // verified_answer_cases, same "no Save button needed" convention as
  // toggleVerified above. Previously this only updated local form state and
  // was folded into the big Save call, which meant unchecking a case here
  // did nothing until Save was clicked (and if the operator only edited the
  // link, nothing else told them a click was still required) — the reply
  // stayed linked, and the case kept showing its Verified badge on Library.
  async function toggleCaseLink(answerId: string, patternId: string, checked: boolean) {
    const prevLinks = caseLinks
    setCaseLinks(prev =>
      checked
        ? [...prev, { answer_id: answerId, pattern_id: patternId } as VerifiedAnswerCase]
        : prev.filter(l => !(l.answer_id === answerId && l.pattern_id === patternId)),
    )
    setError('')
    try {
      const {
        data: { user },
      } = await supabaseClient().auth.getUser()
      if (!user) throw new Error('Not signed in.')
      if (checked) {
        const { error: insertError } = await supabaseClient()
          .from('verified_answer_cases')
          .insert({ answer_id: answerId, pattern_id: patternId, user_id: user.id })
        // Already linked (unique violation) is not an error — same tolerance the old picker had.
        if (insertError && insertError.code !== '23505') throw new Error(insertError.message)
      } else {
        const { error: deleteError } = await supabaseClient()
          .from('verified_answer_cases')
          .delete()
          .eq('answer_id', answerId)
          .eq('pattern_id', patternId)
        if (deleteError) throw new Error(deleteError.message)
      }
    } catch (err) {
      setCaseLinks(prevLinks)
      setError(errorMessage(err, 'Could not update linked cases.'))
    }
  }

  async function remove(row: VerifiedAnswer) {
    if (!confirm('Delete this reply?')) return
    setError('')
    try {
      const { error: deleteError } = await supabaseClient()
        .from('verified_answers')
        .delete()
        .eq('id', row.id)
      if (deleteError) throw new Error(deleteError.message)
      await load()
    } catch (err) {
      setError(errorMessage(err, 'Delete failed.'))
    }
  }

  function openForm() {
    setForm(EMPTY_FORM)
    setFormError('')
    setAdding(true)
  }

  // Registers a category ahead of any reply using it — reply_categories has
  // no delete policy yet (not implemented on purpose), so this only ever
  // adds. An existing name just fails the unique constraint quietly; no need
  // to check first.
  async function addCategory() {
    const typed = window.prompt('New category name:')?.trim()
    if (!typed) return
    setAddingCategory(true)
    setError('')
    try {
      const {
        data: { user },
      } = await supabaseClient().auth.getUser()
      if (!user) throw new Error('Not signed in.')
      const { error: insertError } = await supabaseClient()
        .from('reply_categories')
        .insert({ name: typed, user_id: user.id })
      if (insertError && insertError.code !== '23505') throw new Error(insertError.message)
      setCreatedCategories(prev => (prev.includes(typed) ? prev : [...prev, typed].sort((a, b) => a.localeCompare(b))))
    } catch (err) {
      setError(errorMessage(err, 'Could not add category.'))
    } finally {
      setAddingCategory(false)
    }
  }

  function closeForm() {
    setAdding(false)
    setFormError('')
  }

  async function submitForm() {
    const question_summary = form.question_summary.trim()
    const { text: answerText, html: answerHtml } = addEditorRef.current?.getContent() ?? { text: '', html: null }
    const answer_text = answerText.trim()
    if (!question_summary || !answer_text) {
      setFormError('Question and answer are both required.')
      return
    }
    setFormError('')
    setSaving(true)
    try {
      await callWatchFn<SaveVerifiedResponse>('save-verified', {
        category: form.category.trim() || null,
        subcategory: form.subcategory.trim() || null,
        question_summary,
        reply_text: answer_text,
        answer_html: answerHtml,
        source_url: form.source_url.trim() || null,
        pattern_ids: form.pattern_ids,
        verified: form.verified,
        source_note: 'Added manually',
      })

      setAdding(false)
      setForm(EMPTY_FORM)
      await load()
    } catch (err) {
      setFormError(errorMessage(err, 'Could not save.'))
    } finally {
      setSaving(false)
    }
  }

  // Legacy-only: removes a pre-existing verified_answer_images attachment.
  // Nothing writes new rows into that table any more — an image added
  // through the rich editor lives inline in answer_html instead.
  async function removeImage(row: VerifiedAnswer, image: VerifiedAnswerImage) {
    if (!confirm('Remove this image?')) return
    try {
      await deleteReplyImage(image)
      setImagesByAnswer(prev => {
        const next = new Map(prev)
        const list = (next.get(row.id) || []).filter(i => i.id !== image.id)
        next.set(row.id, list)
        return next
      })
    } catch (err) {
      setImageErrors(prev => ({ ...prev, [row.id]: errorMessage(err, 'Could not remove image.') }))
    }
  }

  function renderReplyForm(
    formState: ReplyForm,
    setFormState: (updater: (f: ReplyForm) => ReplyForm) => void,
    idPrefix: string,
    editorRef: React.RefObject<RichTextEditorHandle | null>,
    initialHtml: string,
  ) {
    return (
      <>
        <div className="row">
          <div className="field field-inline">
            <label htmlFor={`${idPrefix}-category`}>Category</label>
            <select
              id={`${idPrefix}-category`}
              value={formState.category}
              onChange={e => {
                const next = e.target.value
                if (next === ADD_NEW) {
                  const typed = window.prompt('New category name:')?.trim()
                  if (typed) setFormState(f => ({ ...f, category: typed }))
                  return
                }
                setFormState(f => {
                  const subtopics = existingSubcategoriesByCategory.get(next) ?? []
                  return {
                    ...f,
                    category: next,
                    subcategory: subtopics.includes(f.subcategory) ? f.subcategory : subtopics[0] ?? '',
                  }
                })
              }}
            >
              <option value="">None</option>
              {optionsWithCurrent(existingCategories, formState.category).map(t => <option key={t} value={t}>{t}</option>)}
              <option value={ADD_NEW}>+ Add new category…</option>
            </select>
          </div>
          <div className="field field-inline">
            <label htmlFor={`${idPrefix}-subcategory`}>Subcategory</label>
            <select
              id={`${idPrefix}-subcategory`}
              value={formState.subcategory}
              onChange={e => {
                const next = e.target.value
                if (next === ADD_NEW) {
                  const typed = window.prompt('New subcategory name:')?.trim()
                  if (typed) setFormState(f => ({ ...f, subcategory: typed }))
                  return
                }
                setFormState(f => ({ ...f, subcategory: next }))
              }}
              disabled={!formState.category}
            >
              {formState.category ? (
                <>
                  {optionsWithCurrent(existingSubcategoriesByCategory.get(formState.category) ?? [], formState.subcategory).map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                  <option value={ADD_NEW}>+ Add new subcategory…</option>
                </>
              ) : (
                <option value="">Pick a category first</option>
              )}
            </select>
          </div>
        </div>

        <div className="field">
          <label htmlFor={`${idPrefix}-question`}>Question / issue</label>
          <textarea
            id={`${idPrefix}-question`}
            rows={2}
            value={formState.question_summary}
            placeholder="What the user was asking or hitting"
            onChange={e => setFormState(f => ({ ...f, question_summary: e.target.value }))}
          />
        </div>

        <div className="field">
          <label htmlFor={`${idPrefix}-answer`}>Answer</label>
          <RichTextEditor ref={editorRef} initialHtml={initialHtml} placeholder="The reply that actually worked" />
        </div>

        <div className="field">
          <label htmlFor={`${idPrefix}-pattern`}>Linked cases</label>
          <div id={`${idPrefix}-pattern`}>
            <CaseMultiSelect
              caseOptions={caseOptions}
              selected={formState.pattern_ids}
              onToggle={(patternId, checked) =>
                setFormState(f => ({
                  ...f,
                  pattern_ids: checked
                    ? [...f.pattern_ids, patternId]
                    : f.pattern_ids.filter(id => id !== patternId),
                }))
              }
            />
          </div>
        </div>

        <label className="row" style={{ gap: 6 }}>
          <input
            type="checkbox"
            checked={formState.verified}
            onChange={e => setFormState(f => ({ ...f, verified: e.target.checked }))}
          />
          <span className="body-text">Verified (use it to ground and cite future drafts)</span>
        </label>
      </>
    )
  }

  return (
    <div className="stack-lg">
      <div className="page-head">
        <h1 className="grow">Replies</h1>
        <button type="button" className="btn" onClick={addCategory} disabled={addingCategory}>
          {addingCategory ? 'Adding' : 'Add category'}
        </button>
        {!adding ? (
          <button type="button" className="btn primary" onClick={openForm}>
            Add reply
          </button>
        ) : null}
      </div>

      {error ? <p className="error">{error}</p> : null}

      {adding ? (
        <div className="reply-item stack">
          <h2>Add reply</h2>
          {renderReplyForm(form, setForm, 'reply', addEditorRef, '')}

          {formError ? <p className="error">{formError}</p> : null}

          <div className="row">
            <button type="button" className="btn primary" onClick={submitForm} disabled={saving}>
              {saving ? 'Saving' : 'Save'}
            </button>
            <button type="button" className="btn" onClick={closeForm} disabled={saving}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}


      {openBox ? (
        // Level 3: inside a subcategory, its replies.
        <div className="stack">
          <div className="row">
            <button type="button" className="btn" onClick={backToCategories}>
              ← Categories
            </button>
            {openBox.key !== UNCLUSTERED_KEY ? (
              <button type="button" className="btn" onClick={backToSubcategories}>
                ← {openBox.topic}
              </button>
            ) : null}
            <h2 className="cluster-box-title grow">
              {openBox.topic ? `${openBox.topic} / ` : ''}
              {openBox.label}
            </h2>
            <span className="chip">{plural(openBox.rows.length, 'reply', 'replies')}</span>
          </div>
          {openBox.rows.length
            ? openBox.rows.map(row => (
                <ReplyCard
                  key={row.id}
                  row={row}
                  linkedIds={patternIdsByAnswerId.get(row.id) || []}
                  caseOptions={caseOptions}
                  existingCategories={existingCategories}
                  existingSubcategoriesByCategory={existingSubcategoriesByCategory}
                  images={imagesByAnswer.get(row.id) || []}
                  signedUrls={signedUrls}
                  imageError={imageErrors[row.id]}
                  highlighted={row.id === highlightId}
                  copied={copiedId === row.id}
                  setRef={el => {
                    if (el) replyRefs.current.set(row.id, el)
                    else replyRefs.current.delete(row.id)
                  }}
                  onToggleVerified={() => void toggleVerified(row)}
                  onToggleCase={(patternId, checked) => void toggleCaseLink(row.id, patternId, checked)}
                  onCopy={() => void copyReply(row)}
                  onDelete={() => void remove(row)}
                  onRemoveImage={image => void removeImage(row, image)}
                  onSaved={load}
                />
              ))
            : <p className="empty">Nothing here yet.</p>}
        </div>
      ) : openTopicKey ? (
        // Level 2: subcategory tiles for the open category.
        <div className="stack">
          <div className="row">
            <button type="button" className="btn" onClick={backToCategories}>
              ← Categories
            </button>
            <h2 className="cluster-box-title grow">{openTopicKey}</h2>
          </div>
          <div className="box-grid">
            {subtopicGroups.map(group => (
              <div key={group.key} className="box-tile">
                <button type="button" className="box-tile-open" onClick={() => setOpenBoxKey(group.key)}>
                  <span className="box-tile-title">{group.label}</span>
                  <span className="box-tile-count">{plural(group.rows.length, 'reply', 'replies')}</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : (
        // Level 1: category grid. Moving a reply between subtopics is done
        // via the "Move to subtopic" dropdown on the reply itself, so there's
        // no need to pre-seed every fixed topic/subtopic as an empty tile.
        <div className="box-grid">
          {categoryGroups.map(group => (
            <div key={group.key} className="box-tile">
              <button type="button" className="box-tile-open" onClick={() => openCategory(group.key)}>
                <span className="box-tile-title">{group.label}</span>
                <span className="box-tile-count">
                  {group.key === UNCLUSTERED_KEY
                    ? plural(group.replyCount, 'reply', 'replies')
                    : `${plural(group.subtopicCount, 'subcategory', 'subcategories')} · ${plural(group.replyCount, 'reply', 'replies')}`}
                </span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
