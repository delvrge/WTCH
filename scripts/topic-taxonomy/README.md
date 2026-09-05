# Topic/Subtopic taxonomy, offline scrape pipeline, now live-load-bearing

Originally a one-off analysis to generate the fixed Topic/Subtopic taxonomy from a year of
real community board history. `topic_taxonomy_posts` is still isolated from the rest of the
schema (its own migration, own RLS, no FK to `community_patterns`/`verified_answers`/
`community_clusters`), but **as of 2026-08-21 it is load-bearing**: `investigation.ts` and
`solved-cases.ts` read it live, full-text-embedded, to find past community threads that were
actually solved. Do NOT drop this table or stop maintaining it, see "Keeping it topped up"
below.

Toward the platform this is read-only: GET only, same `CommunityWatch/1.0`
User-Agent as the rest of this tool, serial requests, rate-limited (300ms
between sitemap fetches, 500ms between thread fetches).

## Setup

Apply the migration first:

```
supabase db push
```

Python deps for clustering (a venv is recommended):

```
python3 -m venv .venv && source .venv/bin/activate
pip install -r scripts/topic-taxonomy/requirements.txt
```

All scripts auto-load `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`/`OPENAI_API_KEY`
from the repo root `.env.local` (via `lib/load-env.ts`, Node's built-in
`process.loadEnvFile`, no dotenv dependency). A shell env var of the same
name still wins if set. `USER_ID` (step 1 only, not in `.env.local`) is the
`ALLOWED_USER_ID` value (the single operator's `auth.users.id`), pass it
inline.

## Run order

```
# 1. Scrape (the only step that talks to the platform). Resumable, Ctrl-C and
#    re-run picks up where it left off via upsert-on-url.
USER_ID=... npx tsx scripts/topic-taxonomy/1-scrape.ts

# 1b. Translate every post to English (gpt-4o-mini). Skip this and clusters
#     group by language instead of topic.
npx tsx scripts/topic-taxonomy/1b-translate.ts

# 2. Embed every scraped post (text-embedding-3-small, 1536 dims, same as
#    the rest of this tool), using the title_en/body_en translation.
#    Re-clustering after a re-translate? Null out `embedding` first --
#    this script only touches rows where embedding IS NULL:
#      UPDATE topic_taxonomy_posts SET embedding = NULL;
npx tsx scripts/topic-taxonomy/2-embed.ts

# 3a. Export embeddings for Python.
npx tsx scripts/topic-taxonomy/3a-export-embeddings.ts

# 3b. Cluster with HDBSCAN (outliers land in cluster -1, never force-fit).
#     Prints the cluster count/size it converged on -- review this before
#     moving on. Re-run freely; it only reads/writes local JSON files.
python3 scripts/topic-taxonomy/cluster.py

# 3c. Once you're happy with the cluster count, write labels back to the DB.
npx tsx scripts/topic-taxonomy/3b-apply-clusters.ts

# 4. AI names each cluster from a real sample of its posts, writes
#    topic/subtopic back, and generates the review report.
npx tsx scripts/topic-taxonomy/4-label-clusters.ts
```

Output: `scripts/topic-taxonomy/output/taxonomy-report.md`, cluster sizes,
proposed Topic/Subtopic per cluster, example posts, and the unclustered pile
size. Review that before deciding it becomes the new fixed taxonomy.

## Tuning the cluster count

`cluster.py` searches `min_cluster_size` upward until the non-noise cluster
count is <= 20 (`TARGET_MAX_CLUSTERS`), printing each attempt. It never pads
the count back up if the data naturally settles at fewer. To force a
different target or search harder, edit the `candidates` list in
`cluster.py` and re-run, step 3b only touches local JSON, cheap to iterate.

## Keeping it topped up

Retrieval (`investigation.ts`/`solved-cases.ts`) only needs `embedding` +
`title_en`/`body_en` per row, it never reads `cluster_id`/topic/subtopic. So topping the
corpus up with new community threads is just steps 1 → 1b → 2 again; clustering (3a-4) is a
one-off taxonomy-design exercise, not part of routine maintenance, and re-running it risks
disturbing the taxonomy that's already locked in and referenced elsewhere
(`lib/topic-taxonomy.ts`). All three steps are idempotent (upsert-on-url, only-touch-NULL),
so re-running them regularly only processes what's new. One command:

```
npx tsx scripts/topic-taxonomy/topup.ts
```

Run this periodically (e.g. monthly) to keep the solved-thread corpus from going stale.

## Notes

- `topic_taxonomy_posts.cluster_id`: `NULL` = not yet clustered, `-1` =
  HDBSCAN noise (deliberately unclustered), `>= 0` = a real cluster.
- Every script upserts/updates idempotently, safe to re-run any step.
- The clustering/labeling steps (3a-4) are safe to delete once the taxonomy decision is
  made and stable. **Steps 1/1b/2 and the table itself are not**, they feed live retrieval,
  see the warning at the top of this file.
