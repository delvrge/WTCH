"""
Step 3b: HDBSCAN clustering over the exported embeddings.

Deliberately HDBSCAN, not k-means: posts that don't clearly belong anywhere
land in cluster -1 (noise/unclustered) instead of being force-fit into the
nearest centroid. Embeddings are reduced with UMAP first (not PCA -- PCA
optimizes for global variance retention, not the local-neighborhood structure
density-based clustering actually needs; UMAP+HDBSCAN is the standard
combination for text-embedding clustering, e.g. what BERTopic uses). UMAP
reduces with cosine distance (matching the embeddings' own geometry);
HDBSCAN then runs on the reduced space with euclidean, per the same
convention -- UMAP's output space is built for that, and stacking cosine on
top of it again is redundant. Aims for roughly 20 clusters by trying a spread
of min_cluster_size values, then among whichever land at or under 20
clusters, picking the one with the LOWEST noise/unclustered count -- if the
data naturally settles at fewer than 20 clusters, that's left alone, never
padded back up.

Input:  output/embeddings.json   (from 3a-export-embeddings.ts)
Output: output/cluster-labels.json -> [{id, cluster_id}, ...]

Run (after `pip install -r requirements.txt`, ideally in a venv):
    python3 scripts/topic-taxonomy/cluster.py
"""

import json
import os
import sys

import numpy as np
import hdbscan
import umap

TARGET_MAX_CLUSTERS = 20
# Standard BERTopic-style starting points. n_neighbors balances local vs.
# global structure (higher = more global); n_components is the reduced
# dimensionality HDBSCAN actually clusters in; min_dist=0.0 packs points as
# tightly as UMAP allows within their neighborhood, which is what gives
# HDBSCAN's density estimate something to find (UMAP's own default of 0.1 is
# tuned for visualization, not for feeding a downstream clusterer).
UMAP_N_NEIGHBORS = 15
UMAP_N_COMPONENTS = 10
UMAP_MIN_DIST = 0.0
HERE = os.path.dirname(os.path.abspath(__file__))
INPUT_PATH = os.path.join(HERE, "output", "embeddings.json")
OUTPUT_PATH = os.path.join(HERE, "output", "cluster-labels.json")


def load_embeddings():
    with open(INPUT_PATH) as f:
        rows = json.load(f)
    if not rows:
        print("No embeddings found -- run 3a-export-embeddings.ts first.")
        sys.exit(1)
    ids = [r["id"] for r in rows]
    vectors = np.array([r["embedding"] for r in rows], dtype=np.float64)
    # L2-normalize before UMAP. Redundant with UMAP's own metric="cosine"
    # (cosine distance is scale-invariant either way) but harmless, and
    # keeps the raw vectors well-conditioned going in.
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    vectors = vectors / norms
    return ids, vectors


def reduce_dimensions(vectors):
    # HDBSCAN directly on raw 1536-dim embeddings sees near-uniform pairwise
    # distances (curse of dimensionality) and finds no density signal at all.
    # UMAP reduces dimensionality while explicitly preserving each point's
    # local neighborhood (unlike PCA, which only preserves global variance)
    # -- that local structure is exactly what HDBSCAN's density estimate
    # depends on. metric="cosine" here matches the embeddings' own distance
    # semantics. random_state is set for reproducibility, which forces UMAP
    # single-threaded -- slower, but this is a one-off offline run where a
    # repeatable result matters more than wall-clock time.
    reducer = umap.UMAP(
        n_neighbors=UMAP_N_NEIGHBORS,
        n_components=UMAP_N_COMPONENTS,
        min_dist=UMAP_MIN_DIST,
        metric="cosine",
        random_state=42,
    )
    reduced = reducer.fit_transform(vectors)
    print(f"UMAP: {vectors.shape[1]} -> {reduced.shape[1]} dims (n_neighbors={UMAP_N_NEIGHBORS}, min_dist={UMAP_MIN_DIST})")
    return reduced


def count_clusters(labels):
    return len(set(labels[labels >= 0]))


def run_hdbscan(vectors, min_cluster_size):
    # Euclidean here, not cosine: `vectors` is already the UMAP-reduced
    # space, which was built (via UMAP's own cosine metric on the raw
    # embeddings) so that euclidean distance in the reduced space captures
    # local structure well -- the standard UMAP+HDBSCAN convention (BERTopic
    # does the same). Stacking cosine on top again would be redundant and
    # would force the slow brute-force "generic" algorithm instead of
    # hdbscan's fast tree-based default.
    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=min_cluster_size,
        metric="euclidean",
        cluster_selection_method="eom",
    )
    return clusterer.fit_predict(vectors)


def main():
    ids, vectors = load_embeddings()
    n = len(ids)
    print(f"{n} embeddings loaded")

    reduced = reduce_dimensions(vectors)

    # A real spread of min_cluster_size values, not just an ascending chain
    # from one starting guess -- a 0-cluster (all-noise) result no longer
    # counts as "found", so the search has to keep trying smaller values too.
    # Capped well below corpus size so large values aren't tried pointlessly.
    all_candidates = [5, 7, 10, 14, 20, 28, 40, 56, 80, 112, 160, 224, 320, 450]
    candidates = [c for c in all_candidates if c < n // 3] or [5]

    attempts = []
    for mcs in candidates:
        labels = run_hdbscan(reduced, mcs)
        n_clusters = count_clusters(labels)
        n_noise = int((labels == -1).sum())
        print(f"min_cluster_size={mcs}: {n_clusters} clusters, {n_noise} unclustered")
        attempts.append((mcs, n_clusters, n_noise, labels))

    # Prefer whichever attempt lands in (0, TARGET_MAX_CLUSTERS], and among
    # those, prefer the LOWEST noise count (ties broken by more clusters,
    # i.e. closer to ~20) -- being within the target range is the gate, noise
    # is the actual thing being optimized within it. A 0-cluster attempt is
    # never eligible.
    in_range = [a for a in attempts if 0 < a[1] <= TARGET_MAX_CLUSTERS]
    if in_range:
        best_mcs, n_clusters, n_noise, best_labels = min(in_range, key=lambda a: (a[2], -a[1]))
    else:
        nonzero = [a for a in attempts if a[1] > 0]
        if not nonzero:
            print(
                "\nEvery min_cluster_size tried produced 0 clusters (all noise) even after "
                "UMAP reduction. The search range likely needs to go lower, or this corpus "
                "needs different handling -- not writing output."
            )
            sys.exit(1)
        # Nothing landed at or under the target; take whichever nonzero
        # result is numerically closest to it, breaking ties by lower noise.
        best_mcs, n_clusters, n_noise, best_labels = min(nonzero, key=lambda a: (abs(a[1] - TARGET_MAX_CLUSTERS), a[2]))
        print(f"\nNote: no attempt landed at or under {TARGET_MAX_CLUSTERS} clusters -- using the closest nonzero result instead.")

    print(f"\nFinal: min_cluster_size={best_mcs}, {n_clusters} clusters, {n_noise} unclustered out of {n}")

    output = [{"id": ids[i], "cluster_id": int(best_labels[i])} for i in range(n)]
    with open(OUTPUT_PATH, "w") as f:
        json.dump(output, f)
    print(f"wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
