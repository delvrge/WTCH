import { getEnv } from './env.ts'
// The closed set of tags used on your community platform's threads. This is
// deployment-specific vocabulary, not something this tool can guess — set it
// via the COMMUNITY_TAGS env var as a JSON array of strings, e.g.
// '["Bug","Feature Request","How To","Billing","Account"]'. A pattern's tags
// must match one of these exactly to mean anything on the board; suggest-tags
// only ever returns tags out of this list.
//
// Falls back to a small generic example set so the tool still runs (and
// suggest-tags has something to pick from) before you've configured your own.
const DEFAULT_COMMUNITY_TAGS: readonly string[] = [
  'Bug',
  'Feature Request',
  'How To',
  'Billing',
  'Account',
  'Performance',
  'Installation',
  'General',
]

function loadCommunityTags(): readonly string[] {
  const raw = getEnv('COMMUNITY_TAGS')
  if (!raw) return DEFAULT_COMMUNITY_TAGS
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.every((t) => typeof t === 'string')) return parsed
  } catch {
    // Falls through to the default below on malformed JSON.
  }
  console.warn('[tags] COMMUNITY_TAGS env var is set but not a valid JSON string array — using defaults')
  return DEFAULT_COMMUNITY_TAGS
}

export const COMMUNITY_TAGS: readonly string[] = loadCommunityTags()
