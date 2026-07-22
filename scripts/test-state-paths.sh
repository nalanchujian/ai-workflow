#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root_dir="$(mktemp -d)"
trap 'rm -rf "$root_dir"' EXIT

task_dir=""
task_id=""
revision=0
gate_owner=workflow-owner

gate_confirmation() {
  local label="$1"
  ruby -ryaml -e 'state=YAML.safe_load(File.read(ARGV[0]), aliases: false); gate=state["gate"] || {}; puts "#{ARGV[1]}：#{state["task_id"]}/#{gate["node"]}@#{state["revision"]}"' "$task_dir/task.yaml" "$label"
}

start_confirmation() {
  ruby -ryaml -e 'state=YAML.safe_load(File.read(ARGV[0]), aliases: false); node=state["next_node"]; node=node["name"] if node.is_a?(Hash); puts "执行节点：#{state["task_id"]}/#{node}@#{state["revision"]}"' "$task_dir/task.yaml"
}

state() {
  local command="$1" actor=workflow-orchestrator
  local confirmation=""
  shift
  case "$command" in
    start-node)
      confirmation="$(start_confirmation)"
      ;;
    approve-gate)
      actor=workflow-owner
      confirmation="$(gate_confirmation 确认节点)"
      ;;
    reject-gate)
      actor=workflow-owner
      confirmation="$(gate_confirmation 拒绝节点)"
      ;;
  esac
  if [ -n "$confirmation" ]; then
    ruby "$repo_root/scripts/task-state.rb" "$command" "$@" --confirmation "$confirmation" --task-dir "$task_dir" --actor "$actor"
  else
    ruby "$repo_root/scripts/task-state.rb" "$command" "$@" --task-dir "$task_dir" --actor "$actor"
  fi
}

step() {
  state "$@" --expected-revision "$revision" >/dev/null
  revision=$((revision + 1))
}

artifact_file() {
  case "$1" in
    requirement-intake) echo requirement-analysis.md ;;
    acceptance-design) echo acceptance-checklist.md ;;
    impact-analysis) echo impact-analysis.md ;;
    implementation-design) echo implementation-plan.md ;;
    development-implementation) echo development-record.md ;;
    quality-verification) echo quality-verification.md ;;
    change-review) echo change-review.md ;;
    *) echo "ERROR: unknown artifact node $1" >&2; exit 1 ;;
  esac
}

write_artifact() {
  local node="$1" file
  file="$(artifact_file "$node")"
  cat >"$task_dir/$file" <<EOF
---
task_id: $task_id
node: $node
status: completed
attempt: 1
---

# $node
EOF
  case "$node" in
    requirement-intake)
      cat >>"$task_dir/$file" <<'EOF'

## 待澄清项

无

## 确认决策

无
EOF
      ;;
  esac
}

write_routing() {
  local path="$1"

  cat >"$task_dir/requirement-routing.json" <<EOF
{
  "task_id": "$task_id",
  "node": "requirement-routing",
  "status": "completed",
  "attempt": 1,
  "path": "$path",
  "reason": "Exercise the $path state path"
}
EOF
}

run_path() {
  local path="$1"
  local -a design_nodes
  task_dir="$root_dir/$path"
  task_id="state-path-$path"
  revision=0

  state init --task-id "$task_id" --target-module /tmp/example >/dev/null
  step start-node --node requirement-intake
  write_artifact requirement-intake

  step record-result --node requirement-intake --result completed --gate-owner "$gate_owner"
  step approve-gate --gate-owner "$gate_owner" --decision-note approved

  step start-node --node requirement-routing
  write_routing "$path"
  case "$path" in
    lightweight)
      design_nodes=(implementation-design)
      ;;
    complex)
      design_nodes=(acceptance-design impact-analysis implementation-design)
      ;;
  esac
  step record-result --node requirement-routing --result completed --gate-owner "$gate_owner"
  step approve-gate --gate-owner "$gate_owner" --decision-note approved

  local node next index
  for index in "${!design_nodes[@]}"; do
    node="${design_nodes[$index]}"
    if [ "$index" -lt "$(( ${#design_nodes[@]} - 1 ))" ]; then
      next="${design_nodes[$((index + 1))]}"
    else
      next=development-implementation
    fi
    step start-node --node "$node"
    write_artifact "$node"
    step record-result --node "$node" --result completed --gate-owner "$gate_owner"
    step approve-gate --gate-owner "$gate_owner" --decision-note approved
  done

  step start-node --node development-implementation
  write_artifact development-implementation
  step set-delivery --delivery '{"repository_root":"/tmp/example","base_commit":"base","candidate_tree":"tree","change_fingerprint":"fingerprint"}'
  step record-result --node development-implementation --result completed --gate-owner "$gate_owner"
  step approve-gate --gate-owner "$gate_owner" --decision-note approved

  step start-node --node quality-verification
  write_artifact quality-verification
  step record-result --node quality-verification --result completed --gate-owner "$gate_owner"
  step approve-gate --gate-owner "$gate_owner" --decision-note approved

  step start-node --node change-review
  write_artifact change-review
  step record-result --node change-review --result completed --gate-owner "$gate_owner"
  ruby -ryaml - "$task_dir/task.yaml" <<'RUBY'
task = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: false)
abort 'terminal task is not waiting for human approval' unless task['status'] == 'awaiting_confirmation'
abort 'terminal gate is not pending' unless task.dig('gate', 'status') == 'pending'
abort 'terminal gate unexpectedly has a next node' unless task['next_node'].nil?
RUBY
  step approve-gate --gate-owner "$gate_owner" --decision-note approved

  ruby -ryaml - "$task_dir/task.yaml" "$path" "$revision" <<'RUBY'
task = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: false)
abort 'state path does not match' unless task['path'] == ARGV.fetch(1)
abort 'state path did not complete' unless task['status'] == 'completed'
abort 'state path has the wrong revision' unless task['revision'] == Integer(ARGV.fetch(2), 10)
abort 'minimal state retained delivery bindings' if task.key?('delivery_bindings')
abort 'state path has incomplete delivery evidence' unless task.fetch('delivery').values.all? { |value| value && value != '' }
task.fetch('artifacts').each do |node, record|
  abort 'state path attempt counter is inconsistent' unless task.dig('attempts', node) == record['attempt']
  abort "state path artifact #{node} was not approved" unless record['approved'] == true
end
RUBY
}

run_path lightweight
run_path complex

echo 'State CLI path tests passed.'
