#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_runs_root="${AI_WORKFLOW_TEST_RUNS_DIR:-$repo_root/runtime/test-runs}"
run_id="${1:-e2e-$(date +%Y%m%d-%H%M%S)-$$}"
trace_dir="$test_runs_root/$run_id"
trace="$trace_dir/simulation-trace.log"
contract="$repo_root/skills/workflow-orchestrator/references/contracts/workflow-paths.json"

if [ -e "$trace_dir" ]; then
  echo "ERROR: Simulation path already exists: $trace_dir" >&2
  exit 1
fi
mkdir -p "$trace_dir"

log() {
  printf '%s\n' "$*" | tee -a "$trace"
}

run_path() {
  local path_name="$1"
  local task_id="$run_id-$path_name"
  local sequence
  sequence="$(node -e 'const c=require(process.argv[1]); console.log(c.paths[process.argv[2]].join("\n"))' "$contract" "$path_name")"
  while IFS= read -r node; do
    if [ "$node" = "requirement-routing" ]; then
      log "CALL $node task=$task_id route=$path_name"
    else
      log "CALL $node task=$task_id"
    fi
    log "GATE $node task=$task_id status=approved"
  done <<<"$sequence"
  log "TASK $task_id completed"
}

run_path lightweight
run_path complex
log 'PASS all development paths completed'

node "$repo_root/scripts/validate-workflow-contract.mjs" "$trace"
printf 'Workflow simulation passed: %s\n' "$trace"
