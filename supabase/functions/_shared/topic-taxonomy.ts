// The fixed, locked Topic/Subtopic taxonomy for community_patterns
// classification. Replaces the old self-organizing community_clusters
// system (AI-invented labels via embedding clustering + periodic
// merge/split/retopic) — HDBSCAN found no stable cluster count on this
// corpus (a topical continuum, not density-separated groups), so an LLM
// map-reduce pass over post titles proposed this taxonomy directly
// (scripts/topic-taxonomy/5-llm-taxonomy.ts), and it was reviewed and
// locked by hand.
//
// Mirrored at lib/topic-taxonomy.ts for the Next.js app (no cross-import
// between the Next.js app and Supabase edge functions in this repo) — keep
// both in sync by hand if this ever changes.

export const UNCLUSTERED = 'Unclustered'

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

/** Case-insensitive lookup of a model-returned topic/subtopic back to its canonical casing, or null if it matches nothing in the fixed list. */
export function snapTopic(value: string): string | null {
  const norm = value.trim().toLowerCase()
  if (norm === UNCLUSTERED.toLowerCase()) return UNCLUSTERED
  return TOPICS.find((t) => t.toLowerCase() === norm) ?? null
}

export function snapSubtopic(topic: string, value: string): string | null {
  const norm = value.trim().toLowerCase()
  if (topic === UNCLUSTERED) return norm === UNCLUSTERED.toLowerCase() ? UNCLUSTERED : null
  const entry = TOPIC_TAXONOMY.find((t) => t.topic === topic)
  if (!entry) return null
  return entry.subtopics.find((s) => s.toLowerCase() === norm) ?? null
}

function buildTaxonomyBlock(): string {
  return TOPIC_TAXONOMY.map((t) => `  - ${t.topic}\n${t.subtopics.map((s) => `      - ${s}`).join('\n')}`).join('\n')
}

export const TAXONOMY_PROMPT_BLOCK = buildTaxonomyBlock()
