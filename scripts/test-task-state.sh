#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
task_dir="$(mktemp -d)"
lock_holder_pid=""
cleanup() {
  if [ -n "$lock_holder_pid" ]; then
    kill "$lock_holder_pid" >/dev/null 2>&1 || true
    wait "$lock_holder_pid" >/dev/null 2>&1 || true
  fi
  rm -rf "$task_dir"
}
trap cleanup EXIT

ruby "$repo_root/scripts/task-state.rb" --help | rg -q 'record-result'

gate_confirmation() {
  local dir="$1" label="$2"
  ruby -ryaml -e 'state=YAML.safe_load(File.read(ARGV[0]), aliases: false); gate=state["gate"] || {}; puts "#{ARGV[1]}：#{state["task_id"]}/#{gate["node"]}@#{state["revision"]}"' "$dir/task.yaml" "$label"
}

state() {
  local command="$1" actor=workflow-orchestrator
  local confirmation=""
  shift
  case "$command" in
    approve-gate)
      actor=workflow-owner
      confirmation="$(gate_confirmation "$task_dir" 确认节点)"
      ;;
    reject-gate)
      actor=workflow-owner
      confirmation="$(gate_confirmation "$task_dir" 拒绝节点)"
      ;;
  esac
  if [ -n "$confirmation" ]; then
    ruby "$repo_root/scripts/task-state.rb" "$command" "$@" --confirmation "$confirmation" --task-dir "$task_dir" --actor "$actor"
  else
    ruby "$repo_root/scripts/task-state.rb" "$command" "$@" --task-dir "$task_dir" --actor "$actor"
  fi
}

state_for() {
  local dir="$1"
  shift
  local command="$1" actor=workflow-orchestrator
  local confirmation=""
  shift
  case "$command" in
    approve-gate)
      actor=workflow-owner
      confirmation="$(gate_confirmation "$dir" 确认节点)"
      ;;
    reject-gate)
      actor=workflow-owner
      confirmation="$(gate_confirmation "$dir" 拒绝节点)"
      ;;
  esac
  if [ -n "$confirmation" ]; then
    ruby "$repo_root/scripts/task-state.rb" "$command" "$@" --confirmation "$confirmation" --task-dir "$dir" --actor "$actor"
  else
    ruby "$repo_root/scripts/task-state.rb" "$command" "$@" --task-dir "$dir" --actor "$actor"
  fi
}

write_markdown_artifact() {
  local file="$1" node="$2" status="$3"
  local attempt="${4:-1}" dir="${5:-$task_dir}"
  cat >"$dir/$file" <<EOF
---
task_id: state-cli-test
node: $node
status: $status
attempt: $attempt
---

# $node
EOF
  case "$node" in
    requirement-intake)
      cat >>"$dir/$file" <<'EOF'

## 结论

Requirement intake completed.

## 内容

### 待澄清项

无

### 确认决策

无

## 风险与阻塞

无

## 下一步

等待 Gate。
EOF
      ;;
  esac
}

write_json_artifact() {
  local file="$1" node="$2" status="$3"
  local attempt="${4:-1}" dir="${5:-$task_dir}"
  printf '%s\n' \
    '{' \
    '  "task_id": "state-cli-test",' \
    "  \"node\": \"$node\"," \
    "  \"status\": \"$status\"," \
    "  \"attempt\": $attempt," \
    '  "artifact_schema_version": 1,' \
    '  "path": "lightweight",' \
    '  "reason": "Validate the state workflow",' \
    '  "evidence": ["RF-001: single-module boundary"],' \
    '  "unresolved_items": []' \
    '}' >"$dir/$file"
}

state init --task-id state-cli-test --target-module /tmp/example >/dev/null

cp "$task_dir/task.yaml" "$task_dir/task.yaml.valid"
ruby -ryaml - "$task_dir/task.yaml" <<'RUBY'
path = ARGV.fetch(0)
task = YAML.safe_load(File.read(path), aliases: false)
task['next_node'] = 'unknown-node'
File.write(path, YAML.dump(task))
RUBY
if state start-node --node requirement-intake --expected-revision 0 >/dev/null 2>&1; then
  echo 'ERROR: malformed nested task state was accepted' >&2
  exit 1
fi
mv "$task_dir/task.yaml.valid" "$task_dir/task.yaml"

lock_ready="$task_dir/.workflow-lock-ready"
ruby - "$task_dir/.workflow.lock" "$lock_ready" <<'RUBY' &
lock = File.open(ARGV.fetch(0), File::RDWR | File::CREAT, 0o644)
lock.flock(File::LOCK_EX)
File.write(ARGV.fetch(1), 'ready')
sleep 30
RUBY
lock_holder_pid=$!
while [ ! -f "$lock_ready" ]; do sleep 0.01; done
if state start-node --node requirement-intake --expected-revision 0 >/dev/null 2>&1; then
  echo 'ERROR: an active task lock was ignored' >&2
  exit 1
fi
kill "$lock_holder_pid"
wait "$lock_holder_pid" >/dev/null 2>&1 || true
lock_holder_pid=""
rm -f "$lock_ready"

if ruby "$repo_root/scripts/task-state.rb" start-node --task-dir "$task_dir" --actor requirement-intake --node requirement-intake --expected-revision 0 >/dev/null 2>&1; then
  echo 'ERROR: a node skill actor was allowed to write task state' >&2
  exit 1
fi

state start-node --node requirement-intake --expected-revision 0 >/dev/null
write_markdown_artifact requirement-analysis.md requirement-intake completed
if state record-result --node requirement-intake --result completed --next-node requirement-routing --expected-revision 1 >/dev/null 2>&1; then
  echo 'ERROR: requirement intake bypassed its human gate' >&2
  exit 1
fi
state record-result --node requirement-intake --result completed --gate-owner workflow-owner --expected-revision 1 >/dev/null

ruby -ryaml - "$task_dir/task.yaml" <<'RUBY'
task = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: false)
abort 'pending requirement gate did not use awaiting_confirmation' unless task['status'] == 'awaiting_confirmation'
RUBY

approval_confirmation="$(gate_confirmation "$task_dir" 确认节点)"
audit_output="$(state audit)"
ruby -rjson -e 'payload=JSON.parse(ARGV[0]); abort "audit did not expose exact approval confirmation" unless payload["approve_confirmation"] == ARGV[1]' "$audit_output" "$approval_confirmation"
if state start-node --node requirement-routing --expected-revision 2 >/dev/null 2>&1; then
  echo 'ERROR: a pending gate allowed the next node to start' >&2
  exit 1
fi
if ruby "$repo_root/scripts/task-state.rb" approve-gate --task-dir "$task_dir" --actor workflow-orchestrator \
  --gate-owner workflow-owner --confirmation "$approval_confirmation" --expected-revision 2 >/dev/null 2>&1; then
  echo 'ERROR: workflow-orchestrator actor approved a human gate' >&2
  exit 1
fi
if ruby "$repo_root/scripts/task-state.rb" approve-gate --task-dir "$task_dir" --actor workflow-owner \
  --gate-owner workflow-owner --expected-revision 2 >/dev/null 2>&1; then
  echo 'ERROR: a gate approval without confirmation was accepted' >&2
  exit 1
fi
if ruby "$repo_root/scripts/task-state.rb" approve-gate --task-dir "$task_dir" --actor workflow-owner \
  --gate-owner workflow-owner --confirmation '继续' --expected-revision 2 >/dev/null 2>&1; then
  echo 'ERROR: an ambiguous confirmation was accepted' >&2
  exit 1
fi
if ruby "$repo_root/scripts/task-state.rb" approve-gate --task-dir "$task_dir" --actor workflow-owner \
  --gate-owner workflow-owner --confirmation '确认节点：state-cli-test/requirement-intake@1' --expected-revision 2 >/dev/null 2>&1; then
  echo 'ERROR: a stale gate confirmation was accepted' >&2
  exit 1
fi
state approve-gate --gate-owner workflow-owner --decision-note approved --expected-revision 2 >/dev/null

if state start-node --node requirement-routing --expected-revision 2 >/dev/null 2>&1; then
  echo 'ERROR: stale revision was accepted' >&2
  exit 1
fi

ruby -ryaml - "$task_dir/task.yaml" "$task_dir/requirement-analysis.md" <<'RUBY'
task = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: false)
artifact = YAML.safe_load(File.read(ARGV.fetch(1)).match(/\A---\n(.*?)\n---/m)[1], aliases: false)
abort 'gate was not approved' unless task.dig('gate', 'status') == 'approved'
abort 'gate contains redundant name' if task.fetch('gate').key?('name')
abort 'task did not remain active' unless task['status'] == 'active'
abort 'pre-path gate did not resume at requirement routing' unless task['next_node'] == 'requirement-routing'
abort 'gate approval mutated the artifact' unless artifact['status'] == 'completed'
abort 'revision did not advance' unless task['revision'] == 3
RUBY

state start-node --node requirement-routing --expected-revision 3 >/dev/null
write_json_artifact requirement-routing.json requirement-routing completed
ruby -rjson - "$task_dir/requirement-routing.json" <<'RUBY'
path = ARGV.fetch(0)
artifact = JSON.parse(File.read(path))
artifact.delete('reason')
File.write(path, JSON.pretty_generate(artifact))
RUBY
if state record-result --node requirement-routing --result completed --gate-owner workflow-owner --expected-revision 4 >/dev/null 2>&1; then
  echo 'ERROR: incomplete requirement routing was accepted' >&2
  exit 1
fi
write_json_artifact requirement-routing.json requirement-routing completed
ruby -rjson - "$task_dir/requirement-routing.json" <<'RUBY'
path = ARGV.fetch(0)
artifact = JSON.parse(File.read(path))
artifact['template_version'] = 2
File.write(path, JSON.pretty_generate(artifact))
RUBY
if state record-result --node requirement-routing --result completed --gate-owner workflow-owner --expected-revision 4 >/dev/null 2>&1; then
  echo 'ERROR: routing artifact combined current and legacy version fields' >&2
  exit 1
fi
write_json_artifact requirement-routing.json requirement-routing completed
ruby -rjson - "$task_dir/requirement-routing.json" <<'RUBY'
path = ARGV.fetch(0)
artifact = JSON.parse(File.read(path))
artifact.delete('artifact_schema_version')
artifact.delete('evidence')
artifact.delete('unresolved_items')
artifact['template_version'] = 2
File.write(path, JSON.pretty_generate(artifact))
RUBY
if state record-result --node requirement-routing --result completed --gate-owner workflow-owner --expected-revision 4 >/dev/null 2>&1; then
  echo 'ERROR: routing template v2 without evidence was accepted' >&2
  exit 1
fi
ruby -rjson - "$task_dir/requirement-routing.json" <<'RUBY'
path = ARGV.fetch(0)
artifact = JSON.parse(File.read(path))
artifact['evidence'] = ['Single-module requirement with no complex trigger']
File.write(path, JSON.pretty_generate(artifact))
RUBY
state record-result --node requirement-routing --result completed --gate-owner workflow-owner --expected-revision 4 >/dev/null
state approve-gate --gate-owner workflow-owner --decision-note approved --expected-revision 5 >/dev/null

state start-node --node implementation-design --expected-revision 6 >/dev/null
write_markdown_artifact implementation-plan.md implementation-design completed
if state record-result --node implementation-design --result completed --next-node development-implementation --expected-revision 7 >/dev/null 2>&1; then
  echo 'ERROR: implementation design bypassed its human gate' >&2
  exit 1
fi
state record-result --node implementation-design --result completed --gate-owner workflow-owner --expected-revision 7 >/dev/null

ruby -ryaml - "$task_dir/task.yaml" <<'RUBY'
task = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: false)
abort 'implementation design did not continue to development' unless task['next_node'] == 'development-implementation'
abort 'implementation design did not create a pending gate' unless task.dig('gate', 'status') == 'pending'
RUBY
state approve-gate --gate-owner workflow-owner --decision-note approved --expected-revision 8 >/dev/null

state start-node --node development-implementation --expected-revision 9 >/dev/null
write_markdown_artifact development-record.md development-implementation completed
if state set-delivery --delivery '{"unknown_field":"value"}' --expected-revision 10 >/dev/null 2>&1; then
  echo 'ERROR: development implementation wrote unknown delivery evidence' >&2
  exit 1
fi
state set-delivery --delivery '{"repository_root":"/tmp/example","base_commit":"base-commit","candidate_tree":"candidate-tree","change_fingerprint":"change-fingerprint"}' --expected-revision 10 >/dev/null
state record-result --node development-implementation --result completed --gate-owner workflow-owner --expected-revision 11 >/dev/null
state approve-gate --gate-owner workflow-owner --decision-note approved --expected-revision 12 >/dev/null

state start-node --node quality-verification --expected-revision 13 >/dev/null
write_markdown_artifact quality-verification.md quality-verification blocked
state record-result --node quality-verification --result blocked --blocker '{"code":"test_failure","reason":"verification failed","owner":"quality-owner","retry_node":"quality-verification"}' --expected-revision 14 >/dev/null
if state start-node --node quality-verification --expected-revision 15 >/dev/null 2>&1; then
  echo 'ERROR: a blocked task resumed without invalidation' >&2
  exit 1
fi

state invalidate-from --node development-implementation --reason 'implementation changed after verification failure' --expected-revision 15 >/dev/null

ruby -ryaml - "$task_dir/task.yaml" <<'RUBY'
task = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: false)
abort 'invalidation did not reactivate the task' unless task['status'] == 'active'
abort 'invalidation did not select development implementation' unless task['next_node'] == 'development-implementation'
abort 'invalidated artifacts remain indexed' if task['artifacts'].key?('development-implementation') || task['artifacts'].key?('quality-verification')
abort 'delivery identity was not cleared' unless task['delivery'].values.all?(&:nil?)
abort 'blocker was not cleared' unless task['blocked_by'].empty?
abort 'development attempt was not retained' unless task.dig('attempts', 'development-implementation') == 1
abort 'quality attempt was not retained' unless task.dig('attempts', 'quality-verification') == 1
forbidden = %w[artifact_history blocker_history confirmation_history invalidation_history delivery_bindings]
abort 'minimal state retained history fields' unless (task.keys & forbidden).empty?
abort 'revision did not advance through invalidation' unless task['revision'] == 16
RUBY

[ ! -e "$task_dir/development-record.md" ] || {
  echo 'ERROR: invalidated development artifact was not discarded' >&2
  exit 1
}
[ ! -e "$task_dir/quality-verification.md" ] || {
  echo 'ERROR: invalidated quality artifact was not discarded' >&2
  exit 1
}
[ ! -e "$task_dir/history" ] || {
  echo 'ERROR: controlled overwrite retained a history directory' >&2
  exit 1
}
[ ! -e "$task_dir/.workflow-discard" ] || {
  echo 'ERROR: controlled overwrite retained temporary discarded files' >&2
  exit 1
}

state start-node --node development-implementation --expected-revision 16 >/dev/null
write_markdown_artifact development-record.md development-implementation completed
if state set-delivery --delivery '{"repository_root":"/tmp/example","base_commit":"base-commit-2","candidate_tree":"candidate-tree-2","change_fingerprint":"change-fingerprint-2"}' --expected-revision 17 >/dev/null 2>&1; then
  echo 'ERROR: a rerun reused attempt 1' >&2
  exit 1
fi
write_markdown_artifact development-record.md development-implementation completed 2
state set-delivery --delivery '{"repository_root":"/tmp/example","base_commit":"base-commit-2","candidate_tree":"candidate-tree-2","change_fingerprint":"change-fingerprint-2"}' --expected-revision 17 >/dev/null
state record-result --node development-implementation --result completed --gate-owner workflow-owner --expected-revision 18 >/dev/null
state approve-gate --gate-owner workflow-owner --decision-note approved --expected-revision 19 >/dev/null

state start-node --node quality-verification --expected-revision 20 >/dev/null
write_markdown_artifact quality-verification.md quality-verification completed 2
if state set-delivery --delivery '{"candidate_tree":"mutated-tree"}' --expected-revision 21 >/dev/null 2>&1; then
  echo 'ERROR: quality verification changed frozen delivery identity' >&2
  exit 1
fi
state record-result --node quality-verification --result completed --gate-owner workflow-owner --expected-revision 21 >/dev/null
state approve-gate --gate-owner workflow-owner --decision-note approved --expected-revision 22 >/dev/null

state start-node --node change-review --expected-revision 23 >/dev/null
write_markdown_artifact change-review.md change-review completed
if state record-result --node change-review --result completed --task-status completed --expected-revision 24 >/dev/null 2>&1; then
  echo 'ERROR: terminal task completed without a human gate' >&2
  exit 1
fi
state record-result --node change-review --result completed --gate-owner workflow-owner --expected-revision 24 >/dev/null
ruby -ryaml - "$task_dir/task.yaml" <<'RUBY'
task = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: false)
abort 'terminal result is not awaiting confirmation' unless task['status'] == 'awaiting_confirmation'
abort 'terminal result did not create a pending gate' unless task.dig('gate', 'status') == 'pending'
RUBY
state approve-gate --gate-owner workflow-owner --decision-note approved --expected-revision 25 >/dev/null

ruby -ryaml - "$task_dir/task.yaml" <<'RUBY'
task = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: false)
abort 'change review did not complete the task' unless task['status'] == 'completed'
abort 'completed task still has a next node' unless task['next_node'].nil?
abort 'revision did not advance through completion' unless task['revision'] == 26
abort 'minimal task state retained delivery bindings' if task.key?('delivery_bindings')
task.fetch('artifacts').each_value do |record|
  allowed = %w[approved attempt sha256]
  abort 'artifact record contains extra state' unless (record.keys - allowed).empty?
  abort 'artifact record is not evidence-bound' unless record['attempt'].is_a?(Integer) && record['sha256']&.length == 64
end
task.fetch('artifacts').each do |node, record|
  abort 'attempt counter does not match current artifact' unless task.dig('attempts', node) == record['attempt']
end
RUBY

state audit >/dev/null
printf '\ntampered terminal artifact\n' >>"$task_dir/change-review.md"
if state audit >/dev/null 2>&1; then
  echo 'ERROR: terminal audit accepted a modified artifact' >&2
  exit 1
fi
write_markdown_artifact change-review.md change-review completed
state audit >/dev/null

cp "$task_dir/task.yaml" "$task_dir/task.yaml.valid"
cp "$task_dir/requirement-analysis.md" "$task_dir/requirement-analysis.md.valid"
ruby -ryaml - "$task_dir/task.yaml" <<'RUBY'
path = ARGV.fetch(0)
task = YAML.safe_load(File.read(path), aliases: false)
task.fetch('artifacts').delete('requirement-intake')
File.write(path, YAML.dump(task))
RUBY
rm "$task_dir/requirement-analysis.md"
if state audit >/dev/null 2>&1; then
  echo 'ERROR: terminal audit accepted a missing upstream path artifact' >&2
  exit 1
fi
mv "$task_dir/task.yaml.valid" "$task_dir/task.yaml"
mv "$task_dir/requirement-analysis.md.valid" "$task_dir/requirement-analysis.md"
state audit >/dev/null

if state set-delivery --delivery '{"candidate_tree":"mutated-tree"}' --expected-revision 26 >/dev/null 2>&1; then
  echo 'ERROR: terminal delivery evidence was mutated' >&2
  exit 1
fi
if state cancel --cancelled-by owner --reason 'too late' --expected-revision 26 >/dev/null 2>&1; then
  echo 'ERROR: a completed task was cancelled' >&2
  exit 1
fi

echo 'Task state CLI tests passed.'
