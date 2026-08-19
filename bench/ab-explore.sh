#!/usr/bin/env bash
# bench/ab-explore.sh — re-run the A/B comparison from
# docs/postmortems/2026-08-18-read-grep-token-regression.md.
#
# Usage: bench/ab-explore.sh <target-repo-path> <output-dir>
#
# Requires: claude CLI on PATH, TARGET_REPO checked out locally.
# Runs two full `claude -p` sessions against TARGET_REPO — each makes real,
# billed API calls. Do not run this in a loop or automated pipeline without
# reviewing cost first (the original pair cost ~$3.79 combined).

set -euo pipefail

TARGET_REPO="${1:?Usage: bench/ab-explore.sh <target-repo-path> <output-dir>}"
OUT_DIR="${2:?Usage: bench/ab-explore.sh <target-repo-path> <output-dir>}"
CTX_TREE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TASK_PROMPT="$(cat "${CTX_TREE_ROOT}/bench/task-prompt.md")"

mkdir -p "${OUT_DIR}"

echo "== Baseline (no ctx-tree) =="
(
  cd "${TARGET_REPO}"
  claude -p "${TASK_PROMPT}" \
    --output-format stream-json --verbose \
    --setting-sources "" \
    --tools "Read,Grep" \
    --dangerously-skip-permissions
) > "${OUT_DIR}/run_baseline.jsonl"

echo "== Treatment (ctx-tree via --plugin-dir) =="
(
  cd "${TARGET_REPO}"
  claude -p "${TASK_PROMPT}" \
    --output-format stream-json --verbose \
    --setting-sources "" \
    --tools "Read,Grep" \
    --dangerously-skip-permissions \
    --plugin-dir "${CTX_TREE_ROOT}"
) > "${OUT_DIR}/run_ctxtree.jsonl"

echo "Done. Transcripts in ${OUT_DIR}/{run_baseline,run_ctxtree}.jsonl"
echo "Compute final context tokens per run via each transcript's last turn's"
echo "cache_read_input_tokens + cache_creation_input_tokens (see the postmortem's"
echo "'Headline numbers' section for the exact method), and check turn count /"
echo "cost / topic completeness against the pre-registered pass/fail criteria in"
echo "docs/superpowers/plans/2026-08-19-read-grep-token-budget-fix.md (Task 10)."
