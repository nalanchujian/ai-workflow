#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
failures=0

report_matches() {
  local title="$1" pattern="$2"
  shift 2
  local output
  output="$(mktemp)"
  if rg -n "$pattern" "$@" >"$output"; then
    echo "ERROR: $title" >&2
    cat "$output" >&2
    failures=1
  fi
  rm -f "$output"
}

if ! node scripts/validate-workflow-contract.mjs; then
  failures=1
fi

while IFS= read -r yaml_file; do
  if ! ruby -e 'require "yaml"; YAML.load_file(ARGV.fetch(0))' "$yaml_file"; then
    echo "ERROR: Invalid YAML: $yaml_file" >&2
    failures=1
  fi
done < <(find . -path './.git' -prune -o -path './runtime' -prune -o \( -name '*.yaml' -o -name '*.yml' \) -type f -print)

for script in scripts/simulate-workflow.sh scripts/task-state.rb scripts/test-task-state.sh scripts/test-state-machine-guards.sh scripts/test-state-paths.sh; do
  if [ ! -x "$script" ]; then
    echo "ERROR: Required executable is missing: $script" >&2
    failures=1
  fi
done
for script in scripts/simulate-workflow.sh scripts/test-task-state.sh scripts/test-state-machine-guards.sh scripts/test-state-paths.sh; do
  if ! bash -n "$script"; then
    echo "ERROR: Shell script has invalid syntax: $script" >&2
    failures=1
  fi
done
if ! ruby -c scripts/task-state.rb >/dev/null; then
  echo "ERROR: Task state CLI has invalid Ruby syntax" >&2
  failures=1
elif ! scripts/test-task-state.sh; then
  failures=1
elif ! scripts/test-state-machine-guards.sh; then
  failures=1
elif ! scripts/test-state-paths.sh; then
  failures=1
fi

report_matches "Found unfinished skill placeholders" '\[TODO:' skills -g 'SKILL.md'
report_matches "Found direct task.yaml writes outside the state CLI" 'File\.write\([^)]*task\.yaml|YAML\.dump\([^)]*task\.yaml|cat >[^[:space:]]*task\.yaml|>[^[:space:]]*task\.yaml' skills -g '*.md'
report_matches "Found removed release workflow references" '11-release-management|12-production-monitoring-retrospective|release\.yaml|release-batches|ready_for_release|releaseReadyStatus|project-release|mark-ready-for-release' skills AI自动化研发工作流实践指南.md scripts/task-state.rb scripts/simulate-workflow.sh -g '*.md' -g '*.yaml' -g '*.json' -g '*.rb' -g '*.sh'
report_matches "Found machine-local absolute paths in docs" '/Users/j/' . -g '*.md' -g '*.yaml' -g '*.json'
report_matches "Found stale manual-confirmation pseudo-skills" 'manual-confirmation' . -g '*.md' -g '*.yaml' -g '*.json'

tracked_runtime_artifacts="$(git ls-files -- runtime/tasks | rg -v '^runtime/tasks/\.gitkeep$' || true)"
if [ -n "$tracked_runtime_artifacts" ]; then
  echo "ERROR: runtime/tasks contains Git-tracked runtime artifacts" >&2
  printf '%s\n' "$tracked_runtime_artifacts" >&2
  failures=1
fi
tracked_test_artifacts="$(git ls-files -- runtime/test-runs | rg -v '^runtime/test-runs/\.gitkeep$' || true)"
if [ -n "$tracked_test_artifacts" ]; then
  echo "ERROR: runtime/test-runs contains Git-tracked E2E artifacts" >&2
  printf '%s\n' "$tracked_test_artifacts" >&2
  failures=1
fi

if [ "$failures" -ne 0 ]; then
  exit 1
fi

echo 'Workflow validation passed.'

if [ "${1:-}" = '--e2e' ]; then
  scripts/simulate-workflow.sh
fi
