// The fixed, locked Topic/Subtopic taxonomy for community_patterns
// classification. Replaces the old self-organizing community_clusters
// system (AI-invented labels via embedding clustering + periodic
// merge/split/retopic) — HDBSCAN found no stable cluster count on this
// corpus (a topical continuum, not density-separated groups), so an LLM
// map-reduce pass over post titles proposed this taxonomy directly
// (scripts/topic-taxonomy/5-llm-taxonomy.ts), and it was reviewed and
// locked by hand.
//
// Mirrored at supabase/functions/_shared/topic-taxonomy.ts for the Deno
// edge runtime (no cross-import between the Next.js app and Supabase edge
// functions in this repo) — keep both in sync by hand if this ever changes.

// The stored value stays 'Unclustered' — every insert path, dedup match,
// and count already keys off it, so changing the literal would be a data
// migration, not a rename. Only the operator-facing label changed (the
// operator asked for "Undefined" as clearer than "Unclustered" for a
// pattern that didn't classify cleanly); topicDisplayLabel below is the
// single place that translation happens.
export const UNCLUSTERED = 'Unclustered'
const UNCLUSTERED_LABEL = 'Undefined'

export function topicDisplayLabel(topic: string): string {
  return topic === UNCLUSTERED ? UNCLUSTERED_LABEL : topic
}

export const TOPIC_TAXONOMY: { topic: string; subtopics: string[] }[] = [
  { topic: 'Image Generation', subtopics: ['Image Generation Errors', 'Image Upload Issues', 'Quality and Accuracy Concerns'] },
  { topic: 'Video Generation', subtopics: ['Video Generation Errors', 'Audio and Video Sync Issues', 'Export and Download Failures'] },
  { topic: 'Credit Management', subtopics: ['Credit Usage Discrepancies', 'Credit Refund Requests', 'Credit Consumption Problems'] },
  { topic: 'Subscription Issues', subtopics: ['Subscription and Payment Issues', 'Subscription Activation Problems', 'Promotional Offers Confusion'] },
  { topic: 'App Stability & Experience', subtopics: ['Errors and Bugs', 'Performance and Freezing', 'UI and Navigation Issues'] },
  { topic: 'Content Guidelines', subtopics: ['Content and Feature Bugs', 'Prompt Compliance', 'Content Credentials Problems'] },
  { topic: 'Model Specific Problems', subtopics: ['Model Performance Issues', 'Non-Functioning Models', 'Model Limitations'] },
  { topic: 'Feedback and Suggestions', subtopics: ['Feature Requests', 'Feedback and Reporting Issues', 'Miscellaneous Feature Requests'] },
  { topic: 'Access and Permissions', subtopics: ['Access Restrictions', 'Access to Previous Work', 'User Access Issues'] },
]

export const TOPICS: string[] = TOPIC_TAXONOMY.map((t) => t.topic)
export const SUBTOPICS: string[] = TOPIC_TAXONOMY.flatMap((t) => t.subtopics)

// TOPIC_TAXONOMY plus the synthetic Unclustered "topic" (paired only with its
// own Unclustered subtopic) — the full 10-topic/28-leaf list every pattern's
// topic/subtopic actually falls into. Consumed by Context's Categories panel
// and ClusterGraph, both of which need every classified pattern represented,
// not just the 9 real topics.
export const ALL_TOPICS: { topic: string; subtopics: string[] }[] = [
  ...TOPIC_TAXONOMY,
  { topic: UNCLUSTERED, subtopics: [UNCLUSTERED] },
]

const VALID_SUBTOPICS_BY_TOPIC = new Map(ALL_TOPICS.map((t) => [t.topic, new Set(t.subtopics)]))

// A pattern whose subtopic doesn't actually belong to its own topic snaps to
// Unclustered/Unclustered instead of silently dropping — a rare but real
// pre-existing data shape (pattern-extract.ts snaps topic and subtopic
// independently: a real topic can end up paired with a snap-failure
// "Unclustered" subtopic when the model's specific subtopic pick didn't
// match any of that topic's three). Exported so any view that needs to
// bucket raw pattern rows (not just count them) — e.g. Context's per-topic
// detail page — lands each pattern in the exact same leaf the Categories
// counts and ClusterGraph did.
export function classifyLeaf(topic: string | null, subtopic: string | null): { topic: string; subtopic: string } {
  const valid = topic && subtopic && VALID_SUBTOPICS_BY_TOPIC.get(topic)?.has(subtopic)
  return valid ? { topic: topic as string, subtopic: subtopic as string } : { topic: UNCLUSTERED, subtopic: UNCLUSTERED }
}

// Counts patterns per (topic, subtopic) leaf. Every pattern always lands in
// exactly one leaf, so totals always reconcile with the source count.
export function countByTopicSubtopic(
  patterns: { topic: string | null; subtopic: string | null }[],
): Map<string, Map<string, number>> {
  const counts = new Map<string, Map<string, number>>()
  for (const p of patterns) {
    const { topic, subtopic } = classifyLeaf(p.topic, p.subtopic)
    const bySubtopic = counts.get(topic) ?? new Map<string, number>()
    bySubtopic.set(subtopic, (bySubtopic.get(subtopic) || 0) + 1)
    counts.set(topic, bySubtopic)
  }
  return counts
}
