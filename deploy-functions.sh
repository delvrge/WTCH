#!/usr/bin/env bash
# Deploys every edge function in supabase/functions to the linked project.
# Run from the repo root, with the Supabase CLI already logged in and linked.
set -euo pipefail

FUNCTIONS=(
  community-search
  match-pattern
  suggest-keywords
  suggest-tags
  crawl-support-docs
  investigate
  run-watch
  save-verified
  answered-threads
  draft-from-case
  check-case-replies
  suggest-followup
)

for fn in "${FUNCTIONS[@]}"; do
  echo "==> deploying ${fn}"
  supabase functions deploy "${fn}"
done

echo "==> done (${#FUNCTIONS[@]} functions)"
