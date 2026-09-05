'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { errorMessage, supabaseClient } from '@/lib/supabase'
import { ALL_TOPICS, classifyLeaf, topicDisplayLabel, UNCLUSTERED } from '@/lib/topic-taxonomy'

interface PatternRow {
  id: string
  topic: string | null
  subtopic: string | null
  issue_summary: string
  typical_approach: string | null
  frequency: number
}

interface SubtopicGroup {
  subtopic: string
  patterns: PatternRow[]
  totalMentions: number
}

// Buckets this topic's raw patterns the exact same way Categories' counts
// and ClusterGraph do (see classifyLeaf), a pattern whose stored topic
// matches but whose subtopic doesn't actually belong to it snapped to
// Undefined there, so it has to snap the same way here or this page's
// pattern list wouldn't reconcile with the count shown on the box that
// linked to it. Every subtopic the taxonomy defines for this topic always
// gets a group, even at zero patterns, same "show the whole fixed shape,
// not just what's populated" rule Categories itself follows for topics.
function buildSubtopicGroups(patterns: PatternRow[], topic: string, definedSubtopics: string[]): SubtopicGroup[] {
  const bySubtopic = new Map<string, PatternRow[]>(definedSubtopics.map((s) => [s, []]))
  for (const p of patterns) {
    const leaf = classifyLeaf(p.topic, p.subtopic)
    if (leaf.topic !== topic) continue
    const list = bySubtopic.get(leaf.subtopic) ?? []
    list.push(p)
    bySubtopic.set(leaf.subtopic, list)
  }
  return [...bySubtopic.entries()]
    .map(([subtopic, list]) => ({
      subtopic,
      patterns: [...list].sort((a, b) => b.frequency - a.frequency),
      totalMentions: list.reduce((sum, p) => sum + p.frequency, 0),
    }))
    .sort((a, b) => b.totalMentions - a.totalMentions)
}

export default function TopicDetailPage() {
  const params = useParams<{ topic: string }>()
  const topic = decodeURIComponent(params.topic)
  const isKnownTopic = ALL_TOPICS.some((t) => t.topic === topic)

  const [patterns, setPatterns] = useState<PatternRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!isKnownTopic) {
      setLoading(false)
      return
    }
    let cancelled = false
    async function load() {
      setError('')
      setLoading(true)
      try {
        const { data, error: fetchError } = await supabaseClient()
          .from('community_patterns')
          .select('id, topic, subtopic, issue_summary, typical_approach, frequency')
        if (fetchError) throw new Error(fetchError.message)
        if (!cancelled) setPatterns((data || []) as PatternRow[])
      } catch (err) {
        if (!cancelled) {
          setPatterns([])
          setError(errorMessage(err, 'Could not load this topic.'))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [topic, isKnownTopic])

  const definedSubtopics = useMemo(
    () => ALL_TOPICS.find((t) => t.topic === topic)?.subtopics || [],
    [topic],
  )
  const groups = useMemo(
    () => buildSubtopicGroups(patterns, topic, definedSubtopics),
    [patterns, topic, definedSubtopics],
  )
  const totalPatterns = patterns.filter((p) => classifyLeaf(p.topic, p.subtopic).topic === topic).length
  const totalMentions = groups.reduce((sum, g) => sum + g.totalMentions, 0)

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div className="stack" style={{ gap: 4 }}>
          <Link href="/context" className="meta">&larr; Context</Link>
          <h1>{topicDisplayLabel(topic)}</h1>
        </div>
      </div>

      {!isKnownTopic ? <p className="error">Unknown topic.</p> : null}

      {isKnownTopic && error ? <p className="error">{error}</p> : null}

      {isKnownTopic && !error && loading ? <p className="meta"><span className="spinner" /> Loading…</p> : null}

      {isKnownTopic && !error && !loading ? (
        <div className="stack-lg">
          <p className="meta">
            {totalPatterns} {totalPatterns === 1 ? 'pattern' : 'patterns'}, {totalMentions} total {totalMentions === 1 ? 'mention' : 'mentions'} across {groups.length} {groups.length === 1 ? 'subtopic' : 'subtopics'}, ranked by how often each recurs, so the most-complained-about issue leads.
          </p>

          {groups.map((group) => (
            <div key={group.subtopic} className="topic-group">
              <div className="topic-group-head">
                <span className="topic-group-label">
                  {group.subtopic === UNCLUSTERED ? topicDisplayLabel(group.subtopic) : group.subtopic}
                </span>
                <span className="chip">{group.totalMentions}</span>
              </div>
              {group.patterns.length === 0 ? (
                <p className="empty">No patterns classified under this subtopic yet.</p>
              ) : (
                <div className="stack">
                  {group.patterns.map((p) => (
                    <div key={p.id} className="reply">
                      <div className="row">
                        <span className="row-title" style={{ flex: 1 }}>{p.issue_summary}</span>
                        <span className="chip">{p.frequency}&times;</span>
                      </div>
                      {p.typical_approach ? <p className="body-text meta">{p.typical_approach}</p> : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
