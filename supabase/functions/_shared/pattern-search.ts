// Retrieval against community_patterns, the Library of past cases.
//
// Distinct from the near-duplicate check inside saveExtractedPattern: that
// one asks "is this the SAME case, should the rows merge" and runs strict
// (0.85 + an exact `surface` agreement gate). This one asks "which past
// cases are RELATED enough to be worth showing the operator", so it runs
// looser and never gates on surface, a related case with a different
// surface is still useful context, it just must not silently merge.
//
// Call it with an embedding produced by normalizeAndEmbed (normalize-issue.ts).
// Passing a raw-text embedding here compares raw wording against abstracted
// summaries and quietly returns nothing useful.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'

/**
 * Retrieval default. Deliberately below the 0.85 merge bar, see above.
 *
 * Measured with scripts/compare-matching.ts: querying each stored case by
 * its own real post title, every case retrieved itself in the 0.62-0.95 band
 * on the normalized path (mean 0.79, against 0.65 on the old raw-text path).
 * 0.6 sits just under the weakest genuine self-match rather than at the mean,
 * because a related-but-not-identical case is exactly what this search is
 * for and it necessarily scores lower than a case matching itself.
 */
export const PATTERN_MIN_SIMILARITY = 0.6

export interface PatternHit {
  id: string
  issue_summary: string
  typical_approach: string
  tags: string[]
  frequency: number
  last_seen: string | null
  similarity: number
  /** Enrichment columns, the RPC does not return these. */
  surface: string | null
  topic: string | null
  subtopic: string | null
  /** The source post's real title, in its own language. */
  source_title: string | null
  source_urls: string[]
  thread_created_at: string | null
}

interface RpcRow {
  id: string
  issue_summary: string
  typical_approach: string
  tags: string[] | null
  frequency: number | null
  last_seen: string | null
  similarity: number
}

interface EnrichRow {
  id: string
  surface: string | null
  topic: string | null
  subtopic: string | null
  source_title: string | null
  source_urls: string[] | null
  thread_created_at: string | null
}

/**
 * Semantic search over the user's community_patterns, newest-strongest
 * first. Returns [] rather than throwing when the enrichment select fails ,
 * a hit with missing metadata is still a usable hit, so only the RPC itself
 * is treated as fatal.
 */
export async function searchPatterns(
  supabaseAdmin: SupabaseClient,
  userId: string,
  embedding: number[],
  limit: number,
  minSimilarity: number = PATTERN_MIN_SIMILARITY,
): Promise<PatternHit[]> {
  const { data, error } = await supabaseAdmin.rpc('match_community_patterns', {
    p_user_id: userId,
    p_embedding: embedding,
    p_match_count: limit,
    p_min_similarity: minSimilarity,
  })
  if (error) throw error

  const rows = (data ?? []) as RpcRow[]
  if (!rows.length) return []

  // The RPC's RETURNS TABLE omits surface/topic/subtopic/source_*, fetch
  // them in one round trip rather than widening the function signature,
  // which would mean a migration for a read-only convenience.
  const byId = new Map<string, EnrichRow>()
  const { data: extra, error: extraError } = await supabaseAdmin
    .from('community_patterns')
    .select('id, surface, topic, subtopic, source_title, source_urls, thread_created_at')
    .in('id', rows.map((r) => r.id))
  if (extraError) {
    console.warn('pattern enrichment failed:', extraError.message)
  } else {
    for (const row of (extra ?? []) as EnrichRow[]) byId.set(row.id, row)
  }

  return rows
    .sort((a, b) => b.similarity - a.similarity)
    .map((row): PatternHit => {
      const meta = byId.get(row.id)
      return {
        id: row.id,
        issue_summary: row.issue_summary,
        typical_approach: row.typical_approach,
        tags: row.tags ?? [],
        frequency: row.frequency ?? 1,
        last_seen: row.last_seen,
        similarity: row.similarity,
        surface: meta?.surface ?? null,
        topic: meta?.topic ?? null,
        subtopic: meta?.subtopic ?? null,
        source_title: meta?.source_title ?? null,
        source_urls: meta?.source_urls ?? [],
        thread_created_at: meta?.thread_created_at ?? null,
      }
    })
}
