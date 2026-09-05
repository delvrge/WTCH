'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { errorMessage, supabaseClient } from '@/lib/supabase'
import { ALL_TOPICS, UNCLUSTERED, classifyLeaf, countByTopicSubtopic, topicDisplayLabel } from '@/lib/topic-taxonomy'
import ClusterGraph from '@/components/ClusterGraph'

interface PatternRow {
  topic: string | null
  subtopic: string | null
}

interface TopicGroup {
  topic: string
  count: number
}

// Alphabetical by topic name, except Undefined (the UNCLUSTERED bucket) —
// a catch-all for whatever didn't classify cleanly, not a real topic, so it
// always sorts last regardless of where its label would otherwise fall.
function buildTopicGroups(patterns: PatternRow[]): TopicGroup[] {
  const counts = countByTopicSubtopic(patterns)

  return ALL_TOPICS.map(({ topic, subtopics }) => {
    const bySubtopic = counts.get(topic)
    const count = subtopics.reduce((sum, s) => sum + (bySubtopic?.get(s) || 0), 0)
    return { topic, count }
  }).sort((a, b) => {
    if (a.topic === UNCLUSTERED) return 1
    if (b.topic === UNCLUSTERED) return -1
    return a.topic.localeCompare(b.topic)
  })
}

// A topic with zero patterns has nothing behind it to show — linking
// through just lands on the detail page's own empty state one click later,
// so these render as plain (non-clickable) dashed boxes instead, same
// visual language .new-tile already uses elsewhere for "nothing here yet".
function TopicBox({ group }: { group: TopicGroup }) {
  if (group.count === 0) {
    return (
      <div className="topic-box topic-box-empty">
        <div className="topic-box-header">
          <span className="topic-box-label">{topicDisplayLabel(group.topic)}</span>
          <span className="chip">{group.count}</span>
        </div>
      </div>
    )
  }
  return (
    <Link href={`/context/${encodeURIComponent(group.topic)}`} className="topic-box">
      <div className="topic-box-header">
        <span className="topic-box-label">{topicDisplayLabel(group.topic)}</span>
        <span className="chip">{group.count}</span>
      </div>
    </Link>
  )
}

// ── Gaps: which topics keep getting a Go walkthrough built on nothing solid ──
// One investigation_log row per Go click (see migration 20260822000100).
// A "gap" is a walkthrough that cited nothing at all, or one the model
// itself only had low confidence in — either way, this leaf is a shape of
// post the tool currently has weak grounding for.

interface LogRow {
  topic: string | null
  subtopic: string | null
  confidence: 'high' | 'medium' | 'low'
  had_citation: boolean
}

interface LeafGap {
  topic: string
  subtopic: string
  total: number
  gaps: number
}

function isGap(row: LogRow): boolean {
  return !row.had_citation || row.confidence === 'low'
}

function buildLeafGaps(rows: LogRow[]): LeafGap[] {
  const byLeaf = new Map<string, LeafGap>()
  for (const row of rows) {
    const { topic, subtopic } = classifyLeaf(row.topic, row.subtopic)
    const key = `${topic} ${subtopic}`
    const stats = byLeaf.get(key) ?? { topic, subtopic, total: 0, gaps: 0 }
    stats.total += 1
    if (isGap(row)) stats.gaps += 1
    byLeaf.set(key, stats)
  }
  return [...byLeaf.values()].sort((a, b) => b.gaps - a.gaps || b.total - a.total)
}

export default function ContextPage() {
  const [patterns, setPatterns] = useState<PatternRow[]>([])
  const [categoriesError, setCategoriesError] = useState('')
  const [categoriesLoading, setCategoriesLoading] = useState(true)

  const [logRows, setLogRows] = useState<LogRow[]>([])
  const [gapsError, setGapsError] = useState('')
  const [gapsLoading, setGapsLoading] = useState(true)

  const loadCategories = useCallback(async () => {
    setCategoriesError('')
    setCategoriesLoading(true)
    try {
      const { data, error } = await supabaseClient().from('community_patterns').select('topic, subtopic')
      if (error) throw new Error(error.message)
      setPatterns((data || []) as PatternRow[])
    } catch (err) {
      setPatterns([])
      setCategoriesError(errorMessage(err, 'Could not load categories.'))
    } finally {
      setCategoriesLoading(false)
    }
  }, [])

  const loadGaps = useCallback(async () => {
    setGapsError('')
    setGapsLoading(true)
    try {
      const { data, error } = await supabaseClient()
        .from('investigation_log')
        .select('topic, subtopic, confidence, had_citation')
      if (error) throw new Error(error.message)
      setLogRows((data || []) as LogRow[])
    } catch (err) {
      setLogRows([])
      setGapsError(errorMessage(err, 'Could not load gaps.'))
    } finally {
      setGapsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadCategories()
    loadGaps()
  }, [loadCategories, loadGaps])

  const topicGroups = useMemo(() => buildTopicGroups(patterns), [patterns])
  const leafGaps = useMemo(() => buildLeafGaps(logRows), [logRows])

  return (
    <div className="stack-lg">
      <div className="page-head">
        <h1>Context</h1>
      </div>

      <div className="dashboard-bottom">
        <section className="stack-lg">
          <h2>Categories</h2>

          {categoriesError ? <p className="error">{categoriesError}</p> : null}

          {!categoriesError && categoriesLoading ? <p className="meta"><span className="spinner" /> Loading…</p> : null}

          {!categoriesError && !categoriesLoading ? (
            <div className="topic-grid">
              {topicGroups.map((group) => (
                <TopicBox key={group.topic} group={group} />
              ))}
            </div>
          ) : null}
        </section>

        <section className="stack-lg">
          <h2>Gaps</h2>
          <p className="meta">
            Which topics keep coming back with nothing solid on a Go click — no citable step, or the model
            itself flagged low confidence. One row logged per click; fills in as Go gets used.
          </p>

          {gapsError ? <p className="error">{gapsError}</p> : null}
          {!gapsError && gapsLoading ? <p className="meta"><span className="spinner" /> Loading…</p> : null}

          {!gapsError && !gapsLoading ? (
            logRows.length === 0 ? (
              <p className="empty">Nothing logged yet.</p>
            ) : (
              <div className="case-table-wrap">
                <table className="case-table">
                  <colgroup>
                    <col style={{ width: '46%' }} />
                    <col style={{ width: '18%' }} />
                    <col style={{ width: '18%' }} />
                    <col style={{ width: '18%' }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Topic / Subtopic</th>
                      <th>Clicks</th>
                      <th>Gaps</th>
                      <th>Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leafGaps.map((l) => (
                      <tr key={`${l.topic} ${l.subtopic}`}>
                        <td>
                          {topicDisplayLabel(l.topic)}
                          {l.subtopic && l.subtopic !== l.topic ? ` / ${l.subtopic}` : ''}
                        </td>
                        <td>{l.total}</td>
                        <td>{l.gaps}</td>
                        <td>{Math.round((l.gaps / l.total) * 100)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : null}
        </section>
      </div>

      <section className="stack-lg">
        <h2>Graph view</h2>
        <ClusterGraph />
      </section>
    </div>
  )
}
