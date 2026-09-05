// Verbatim reuse of supabase/functions/_shared/tags.ts's list, the closed
// set of tags used on your community platform's threads. This is
// deployment-specific vocabulary; set it via the NEXT_PUBLIC_COMMUNITY_TAGS
// env var as a JSON array of strings (client-side, hence the NEXT_PUBLIC_
// prefix). Falls back to the same generic example set as the edge-function
// side so the dashboard still runs before you've configured your own.
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
  const raw = process.env.NEXT_PUBLIC_COMMUNITY_TAGS
  if (!raw) return DEFAULT_COMMUNITY_TAGS
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.every((t) => typeof t === 'string')) return parsed
  } catch {
    // Falls through to the default below on malformed JSON.
  }
  return DEFAULT_COMMUNITY_TAGS
}

export const COMMUNITY_TAGS: readonly string[] = loadCommunityTags()
