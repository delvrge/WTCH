'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast, Toaster } from '@/components/Toast'
import { callWatchFn } from '@/lib/functions'
import { errorMessage, supabaseClient } from '@/lib/supabase'
import { boardLabelFromSlug } from '@/lib/format'
import type { RunWatchResponse, Watch } from '@/lib/types'

// Mirrors WATCHED_BOARDS in supabase/functions/_shared/community-sources.ts ,
// the only boards `categories` can narrow within. Set via
// NEXT_PUBLIC_WATCHED_BOARDS (comma-separated, client-side mirror of the
// server-side WATCHED_BOARDS env var, keep the two in sync per deployment).
const BOARDS = (process.env.NEXT_PUBLIC_WATCHED_BOARDS ?? '').split(',').map((s) => s.trim()).filter(Boolean)

interface WatchForm {
  title: string
  keywords: string
  categories: string[]
  auto_run: boolean
}

const EMPTY_FORM: WatchForm = { title: '', keywords: '', categories: [], auto_run: true }

function splitKeywords(value: string): string[] {
  return [...new Set(value.split(',').map((k) => k.trim()).filter(Boolean))]
}

function formFromWatch(w: Watch): WatchForm {
  return { title: w.title, keywords: w.keywords.join(', '), categories: w.categories, auto_run: w.auto_run }
}

export default function WatchesPage() {
  const [watches, setWatches] = useState<Watch[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState<WatchForm>(EMPTY_FORM)
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<WatchForm>(EMPTY_FORM)
  const [editError, setEditError] = useState('')
  const [editSaving, setEditSaving] = useState(false)

  const [runningId, setRunningId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Watch | null>(null)

  const load = useCallback(async () => {
    setError('')
    setLoading(true)
    try {
      const { data, error: dbError } = await supabaseClient()
        .from('community_watches')
        .select('*')
        .order('order', { ascending: true })
        .order('created_at', { ascending: true })
      if (dbError) throw new Error(dbError.message)
      setWatches((data || []) as Watch[])
    } catch (err) {
      setWatches([])
      setError(errorMessage(err, 'Could not load watches.'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function toggleCategory(list: string[], cat: string): string[] {
    return list.includes(cat) ? list.filter((c) => c !== cat) : [...list, cat]
  }

  function openForm() {
    setForm(EMPTY_FORM)
    setFormError('')
    setEditingId(null)
    setAdding(true)
  }

  async function submitForm() {
    const title = form.title.trim()
    if (!title) {
      setFormError('Title is required.')
      return
    }
    setFormError('')
    setSaving(true)
    try {
      const { error: insertError } = await supabaseClient().from('community_watches').insert({
        title,
        keywords: splitKeywords(form.keywords),
        categories: form.categories,
        auto_run: form.auto_run,
      })
      if (insertError) throw new Error(insertError.message)
      setAdding(false)
      setForm(EMPTY_FORM)
      await load()
    } catch (err) {
      setFormError(errorMessage(err, 'Could not save.'))
    } finally {
      setSaving(false)
    }
  }

  function startEdit(w: Watch) {
    setAdding(false)
    setEditError('')
    setEditForm(formFromWatch(w))
    setEditingId(w.id)
  }

  async function submitEdit(id: string) {
    const title = editForm.title.trim()
    if (!title) {
      setEditError('Title is required.')
      return
    }
    setEditError('')
    setEditSaving(true)
    try {
      const { error: updateError } = await supabaseClient()
        .from('community_watches')
        .update({
          title,
          keywords: splitKeywords(editForm.keywords),
          categories: editForm.categories,
          auto_run: editForm.auto_run,
        })
        .eq('id', id)
      if (updateError) throw new Error(updateError.message)
      setEditingId(null)
      await load()
    } catch (err) {
      setEditError(errorMessage(err, 'Could not save.'))
    } finally {
      setEditSaving(false)
    }
  }

  async function toggleAutoRun(w: Watch) {
    try {
      const { error: updateError } = await supabaseClient()
        .from('community_watches')
        .update({ auto_run: !w.auto_run })
        .eq('id', w.id)
      if (updateError) throw new Error(updateError.message)
      await load()
    } catch (err) {
      toast.error(errorMessage(err, 'Could not update.'))
    }
  }

  async function runNow(w: Watch) {
    setRunningId(w.id)
    try {
      const result = await callWatchFn<RunWatchResponse>('run-watch', { watch_id: w.id })
      toast.success(`${w.title}: ${result.created} new, ${result.bumped} bumped, ${result.skipped} skipped.`)
      if (result.errors.length) toast.error(result.errors[0])
      await load()
    } catch (err) {
      toast.error(errorMessage(err, 'Run failed.'))
    } finally {
      setRunningId(null)
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    try {
      const { error: deleteError } = await supabaseClient()
        .from('community_watches')
        .delete()
        .eq('id', pendingDelete.id)
      if (deleteError) throw new Error(deleteError.message)
      setPendingDelete(null)
      await load()
    } catch (err) {
      toast.error(errorMessage(err, 'Could not delete.'))
    }
  }

  function renderCategoryToggles(selected: string[], onChange: (next: string[]) => void) {
    return (
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {BOARDS.map((board) => (
          <label key={board} className="row" style={{ gap: 4, width: 'auto' }}>
            <input
              type="checkbox"
              checked={selected.includes(board)}
              onChange={() => onChange(toggleCategory(selected, board))}
            />
            <span className="body-text">{boardLabelFromSlug(board)}</span>
          </label>
        ))}
      </div>
    )
  }

  return (
    <div className="stack-lg">
      <Toaster />

      <div className="page-head">
        <h1>Watches</h1>
        {!adding ? (
          <button type="button" className="btn primary" onClick={openForm}>
            New watch
          </button>
        ) : null}
      </div>

      <p className="meta">
        A watch narrows what run-watch discovers on each pass, keywords and, optionally, which watched
        boards to search. Empty categories means every configured board.
      </p>

      {adding ? (
        <div className="card stack">
          <div className="field">
            <label>Title</label>
            <input
              type="text"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            />
          </div>
          <div className="field">
            <label>Keywords (comma-separated)</label>
            <input
              type="text"
              value={form.keywords}
              onChange={(e) => setForm((f) => ({ ...f, keywords: e.target.value }))}
            />
          </div>
          <div className="field">
            <label>Boards</label>
            {renderCategoryToggles(form.categories, (next) => setForm((f) => ({ ...f, categories: next })))}
          </div>
          <label className="row" style={{ gap: 4, width: 'auto' }}>
            <input
              type="checkbox"
              checked={form.auto_run}
              onChange={(e) => setForm((f) => ({ ...f, auto_run: e.target.checked }))}
            />
            <span className="body-text">Auto-run</span>
          </label>
          {formError ? <p className="error">{formError}</p> : null}
          <div className="row">
            <button type="button" className="btn primary" onClick={submitForm} disabled={saving}>
              {saving ? 'Saving' : 'Save'}
            </button>
            <button type="button" className="btn" onClick={() => setAdding(false)} disabled={saving}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {error ? <p className="error">{error}</p> : null}
      {!error && loading ? <p className="meta"><span className="spinner" /> Loading…</p> : null}

      {!error && !loading && watches.length === 0 ? <p className="empty">No watches yet.</p> : null}

      {!error && !loading && watches.length > 0 ? (
        <div className="stack">
          {watches.map((w) => (
            <div key={w.id} className="card stack">
              {editingId === w.id ? (
                <>
                  <div className="field">
                    <label>Title</label>
                    <input
                      type="text"
                      value={editForm.title}
                      onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))}
                    />
                  </div>
                  <div className="field">
                    <label>Keywords (comma-separated)</label>
                    <input
                      type="text"
                      value={editForm.keywords}
                      onChange={(e) => setEditForm((f) => ({ ...f, keywords: e.target.value }))}
                    />
                  </div>
                  <div className="field">
                    <label>Boards</label>
                    {renderCategoryToggles(editForm.categories, (next) =>
                      setEditForm((f) => ({ ...f, categories: next })),
                    )}
                  </div>
                  <label className="row" style={{ gap: 4, width: 'auto' }}>
                    <input
                      type="checkbox"
                      checked={editForm.auto_run}
                      onChange={(e) => setEditForm((f) => ({ ...f, auto_run: e.target.checked }))}
                    />
                    <span className="body-text">Auto-run</span>
                  </label>
                  {editError ? <p className="error">{editError}</p> : null}
                  <div className="row">
                    <button type="button" className="btn primary" onClick={() => submitEdit(w.id)} disabled={editSaving}>
                      {editSaving ? 'Saving' : 'Save'}
                    </button>
                    <button type="button" className="btn" onClick={() => setEditingId(null)} disabled={editSaving}>
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="row">
                    <span className="grow row-title">{w.title}</span>
                    <span className="meta">{w.pattern_count} pattern{w.pattern_count === 1 ? '' : 's'}</span>
                  </div>

                  {w.keywords.length ? (
                    <div className="row" style={{ flexWrap: 'wrap' }}>
                      {w.keywords.map((k) => (
                        <span key={k} className="chip">{k}</span>
                      ))}
                    </div>
                  ) : (
                    <p className="muted">No keywords, matches on board alone.</p>
                  )}

                  <p className="meta">
                    {w.categories.length ? w.categories.map((c) => boardLabelFromSlug(c) ?? c).join(', ') : 'All boards'}
                  </p>

                  <p className="meta">
                    {w.last_run_at
                      ? `Last run: ${new Date(w.last_run_at).toLocaleString()} (${w.last_run_status ?? 'unknown'})`
                      : 'Never run.'}
                  </p>

                  <div className="row">
                    <button type="button" className="btn" onClick={() => runNow(w)} disabled={runningId === w.id}>
                      {runningId === w.id ? 'Running' : 'Run now'}
                    </button>
                    <button type="button" className="btn" onClick={() => toggleAutoRun(w)}>
                      {w.auto_run ? 'Turn auto-run off' : 'Turn auto-run on'}
                    </button>
                    <button type="button" className="btn" onClick={() => startEdit(w)}>
                      Edit
                    </button>
                    <span className="grow" />
                    <button type="button" className="btn danger" onClick={() => setPendingDelete(w)}>
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      ) : null}

      {pendingDelete ? (
        <div className="card stack">
          <p>Delete &ldquo;{pendingDelete.title}&rdquo;? This does not remove any patterns it already found.</p>
          <div className="row">
            <button type="button" className="btn danger" onClick={confirmDelete}>
              Delete
            </button>
            <button type="button" className="btn" onClick={() => setPendingDelete(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
