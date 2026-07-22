#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root_dir="$(mktemp -d)"
trap 'rm -rf "$root_dir"' EXIT

gate_confirmation() {
  local task_dir="$1" label="$2"
  ruby -ryaml -e 'state=YAML.safe_load(File.read(ARGV[0]), aliases: false); gate=state["gate"] || {}; puts "#{ARGV[1]}：#{state["task_id"]}/#{gate["node"]}@#{state["revision"]}"' "$task_dir/task.yaml" "$label"
}

state() {
  local task_dir="$1" command="$2" actor=workflow-orchestrator
  local confirmation=""
  shift 2
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

expect_failure() {
  local label="$1" task_dir="$2"
  shift 2
  if state "$task_dir" "$@" >/dev/null 2>&1; then
    echo "ERROR: $label" >&2
    exit 1
  fi
}

write_markdown_artifact() {
  local task_dir="$1" task_id="$2" file="$3" node="$4" status="$5"
  local attempt="${6:-1}"
  cat >"$task_dir/$file" <<EOF
---
task_id: $task_id
node: $node
status: $status
attempt: $attempt
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

write_blocked_routing() {
  local task_dir="$1" task_id="$2"
  cat >"$task_dir/requirement-routing.json" <<EOF
{
  "task_id": "$task_id",
  "node": "requirement-routing",
  "status": "blocked",
  "attempt": 1,
  "path": null,
  "reason": "Clarify the missing requirement"
}
EOF
}

advance_to_pending_requirement_gate() {
  local task_dir="$1" task_id="$2"
  state "$task_dir" init --task-id "$task_id" --target-module /tmp/example >/dev/null
  state "$task_dir" start-node --node requirement-intake --expected-revision 0 >/dev/null
  write_markdown_artifact "$task_dir" "$task_id" requirement-analysis.md requirement-intake completed
  state "$task_dir" record-result --node requirement-intake --result completed --gate-owner workflow-owner --expected-revision 1 >/dev/null
}

write_intake_with_questions() {
  local task_dir="$1" task_id="$2" mode="$3"
  cat >"$task_dir/requirement-analysis.md" <<EOF
---
task_id: $task_id
node: requirement-intake
status: completed
attempt: 1
---

## 待澄清项

| 问题 ID | 来源事实 | 问题 | 阻塞内容 |
| --- | --- | --- | --- |
| RQ-001 | RF-001 | First question | First decision |
| RQ-002 | RF-002 | Second question | Second decision |

## 确认决策

| 决策 ID | 来源问题 ID | 采用规则 | 依据 | 影响 | 状态 |
| --- | --- | --- | --- | --- | --- |
| CL-001 | RQ-001 | Use rule one | Evidence | Scope | 已人工确认 |
EOF
  case "$mode" in
    missing)
      ;;
    unknown)
      printf '%s\n' '| CL-002 | RQ-999 | Use unknown rule | Evidence | Scope | 已人工确认 |' >>"$task_dir/requirement-analysis.md"
      ;;
    recommended)
      printf '%s\n' '| CL-002 | RQ-002 | Use rule two | Evidence | Scope | 推荐 |' >>"$task_dir/requirement-analysis.md"
      ;;
    unresolved)
      printf '%s\n' '| CL-002 | RQ-002 | Use rule two | Evidence | Scope | 待人工确认 |' >>"$task_dir/requirement-analysis.md"
      ;;
    complete)
      printf '%s\n' '| CL-002 | RQ-002 | Use rule two | Evidence | Scope | 已人工确认 |' >>"$task_dir/requirement-analysis.md"
      ;;
  esac
}

write_v2_intake() {
  local task_dir="$1" task_id="$2" mode="${3:-valid}"
  cat >"$task_dir/requirement-analysis.md" <<EOF
---
task_id: $task_id
node: requirement-intake
status: completed
attempt: 1
template_version: 2
---

# 结果

| 项目 | 内容 |
| --- | --- |
| 当前结论 | 需求已明确 |

# 交付

## 范围

| 类型 | 内容 | 依据 |
| --- | --- | --- |
| 包含 | Example | Owner |

## 需求事实

| 事实 ID | 模块 | 目标行为 | 当前差异 | 来源 | 状态 |
| --- | --- | --- | --- | --- | --- |
| RF-001 | Example | Example | None | Owner | 已确认 |

## 待澄清项

无

## 确认决策

无

## 分流线索

| 代码入口 | 观察到的信号 | 仅供下游判断 |
| --- | --- | --- |
| /tmp/example | Single module | requirement-routing |

# 未决项

无
EOF
  if [ "$mode" != missing-handoff ]; then
    cat >>"$task_dir/requirement-analysis.md" <<'EOF'

# 交接

| 项目 | 内容 |
| --- | --- |
| 交付给 | requirement-routing |
EOF
  fi
}

coverage_dir="$root_dir/requirement-decision-coverage"
state "$coverage_dir" init --task-id requirement-decision-coverage --target-module /tmp/example >/dev/null
state "$coverage_dir" start-node --node requirement-intake --expected-revision 0 >/dev/null
write_intake_with_questions "$coverage_dir" requirement-decision-coverage missing
expect_failure 'requirement intake omitted a question decision' "$coverage_dir" \
  record-result --node requirement-intake --result completed --gate-owner workflow-owner --expected-revision 1
write_intake_with_questions "$coverage_dir" requirement-decision-coverage unknown
expect_failure 'requirement intake referenced an unknown question' "$coverage_dir" \
  record-result --node requirement-intake --result completed --gate-owner workflow-owner --expected-revision 1
write_intake_with_questions "$coverage_dir" requirement-decision-coverage unresolved
expect_failure 'requirement intake completed without individual owner confirmation' "$coverage_dir" \
  record-result --node requirement-intake --result completed --gate-owner workflow-owner --expected-revision 1
write_intake_with_questions "$coverage_dir" requirement-decision-coverage recommended
expect_failure 'requirement intake treated an AI recommendation as owner confirmation' "$coverage_dir" \
  record-result --node requirement-intake --result completed --gate-owner workflow-owner --expected-revision 1
write_intake_with_questions "$coverage_dir" requirement-decision-coverage complete
state "$coverage_dir" record-result --node requirement-intake --result completed --gate-owner workflow-owner --expected-revision 1 >/dev/null
ruby -ryaml - "$coverage_dir/task.yaml" <<'RUBY'
task = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: false)
abort 'complete RQ to CL coverage did not create a pending owner gate' unless task.dig('gate', 'node') == 'requirement-intake' && task.dig('gate', 'status') == 'pending'
RUBY

template_v2_dir="$root_dir/template-v2"
state "$template_v2_dir" init --task-id template-v2 --target-module /tmp/example >/dev/null
state "$template_v2_dir" start-node --node requirement-intake --expected-revision 0 >/dev/null
write_v2_intake "$template_v2_dir" template-v2 missing-handoff
expect_failure 'template v2 accepted a missing handoff section' "$template_v2_dir" \
  record-result --node requirement-intake --result completed --gate-owner workflow-owner --expected-revision 1
write_v2_intake "$template_v2_dir" template-v2
ruby -pi -e 'gsub(/^## 分流线索$/, "## 技术线索")' "$template_v2_dir/requirement-analysis.md"
expect_failure 'template v2 accepted an unknown delivery section' "$template_v2_dir" \
  record-result --node requirement-intake --result completed --gate-owner workflow-owner --expected-revision 1
write_v2_intake "$template_v2_dir" template-v2
state "$template_v2_dir" record-result --node requirement-intake --result completed --gate-owner workflow-owner --expected-revision 1 >/dev/null

duplicate_dir="$root_dir/duplicate-start"
state "$duplicate_dir" init --task-id duplicate-start --target-module /tmp/example >/dev/null
expect_failure 'audit silently accepted an extra positional argument' "$duplicate_dir" audit ignored
expect_failure 'start-node silently accepted an unrelated option' "$duplicate_dir" \
  start-node --node requirement-intake --reason ignored --expected-revision 0
state "$duplicate_dir" start-node --node requirement-intake --expected-revision 0 >/dev/null
expect_failure 'an executing node was started twice' "$duplicate_dir" start-node --node requirement-intake --expected-revision 1
ruby -ryaml - "$duplicate_dir/task.yaml" <<'RUBY'
task = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: false)
abort 'start-node did not consume next_node' unless task['next_node'].nil?
abort 'start-node did not set current_node' unless task['current_node'] == 'requirement-intake'
RUBY
write_markdown_artifact "$duplicate_dir" duplicate-start requirement-analysis.md requirement-intake completed
ruby -pi -e 'gsub("task_id: duplicate-start", "task_id: another-task")' "$duplicate_dir/requirement-analysis.md"
expect_failure 'an artifact for another task was recorded' "$duplicate_dir" \
  record-result --node requirement-intake --result completed --gate-owner workflow-owner --expected-revision 1

invalid_blocker_dir="$root_dir/invalid-blocker"
advance_to_pending_requirement_gate "$invalid_blocker_dir" invalid-blocker
state "$invalid_blocker_dir" approve-gate --gate-owner workflow-owner --decision-note approved --expected-revision 2 >/dev/null
state "$invalid_blocker_dir" start-node --node requirement-routing --expected-revision 3 >/dev/null
write_blocked_routing "$invalid_blocker_dir" invalid-blocker
expect_failure 'a blocker pointed to a downstream node outside its invalidation scope' "$invalid_blocker_dir" \
  record-result --node requirement-routing --result blocked \
  --blocker '{"code":"missing_scope","reason":"needs clarification","owner":"owner","retry_node":"development-implementation"}' \
  --expected-revision 4
state "$invalid_blocker_dir" record-result --node requirement-routing --result blocked \
  --blocker '{"code":"missing_scope","reason":"needs confirmation","owner":"owner","retry_node":"requirement-intake"}' \
  --expected-revision 4 >/dev/null
expect_failure 'a blocked task started without invalidation' "$invalid_blocker_dir" \
  start-node --node requirement-intake --expected-revision 5
state "$invalid_blocker_dir" cancel --cancelled-by owner --reason 'cancel blocked task' --expected-revision 5 >/dev/null
ruby -ryaml - "$invalid_blocker_dir/task.yaml" <<'RUBY'
task = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: false)
abort 'cancelled task retained current blockers' unless task['blocked_by'].empty?
abort 'minimal state retained blocker history' if task.key?('blocker_history')
abort 'cancelled task retained a next node' unless task['next_node'].nil?
RUBY

tamper_dir="$root_dir/tampered-gate"
advance_to_pending_requirement_gate "$tamper_dir" tampered-gate
cp "$tamper_dir/task.yaml" "$tamper_dir/task.yaml.valid"
ruby -ryaml - "$tamper_dir/task.yaml" <<'RUBY'
path = ARGV.fetch(0)
task = YAML.safe_load(File.read(path), aliases: false)
task.fetch('gate')['unknown'] = 'value'
File.write(path, YAML.dump(task))
RUBY
expect_failure 'audit accepted an unknown gate field' "$tamper_dir" audit
mv "$tamper_dir/task.yaml.valid" "$tamper_dir/task.yaml"
printf '\nunauthorized replacement\n' >>"$tamper_dir/requirement-analysis.md"
expect_failure 'a gate approved a modified recorded artifact' "$tamper_dir" \
  approve-gate --gate-owner workflow-owner --decision-note approved --expected-revision 2
state "$tamper_dir" cancel --cancelled-by workflow-owner --reason 'cancel pending approval' --expected-revision 2 >/dev/null
ruby -ryaml - "$tamper_dir/task.yaml" <<'RUBY'
task = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: false)
abort 'cancel did not create a terminal task' unless task['status'] == 'cancelled'
abort 'cancelled task retained its pending gate' unless task['gate'].nil?
abort 'minimal state retained gate history' if task.key?('confirmation_history')
RUBY

rejected_gate_dir="$root_dir/rejected-gate"
advance_to_pending_requirement_gate "$rejected_gate_dir" rejected-gate
expect_failure 'a gate rejection without a decision note was accepted' "$rejected_gate_dir" \
  reject-gate --gate-owner workflow-owner --expected-revision 2
state "$rejected_gate_dir" reject-gate --gate-owner workflow-owner --decision-note 'clarify again' --expected-revision 2 >/dev/null
state "$rejected_gate_dir" invalidate-from --node requirement-intake --reason 'owner requested changes' --expected-revision 3 >/dev/null
[ ! -e "$rejected_gate_dir/requirement-analysis.md" ] || {
  echo 'ERROR: rejected gate artifact was not discarded' >&2
  exit 1
}
ruby -ryaml - "$rejected_gate_dir/task.yaml" <<'RUBY'
task = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: false)
abort 'rejected gate was not cleared' unless task['gate'].nil?
abort 'gate rejection blocker was not cleared' unless task['blocked_by'].empty?
abort 'rejected gate attempt was not retained' unless task.dig('attempts', 'requirement-intake') == 1
forbidden = %w[blocker_history confirmation_history invalidation_history]
abort 'minimal state retained rejection history' unless (task.keys & forbidden).empty?
RUBY
state "$rejected_gate_dir" start-node --node requirement-intake --expected-revision 4 >/dev/null
write_markdown_artifact "$rejected_gate_dir" rejected-gate requirement-analysis.md requirement-intake completed \
  2
state "$rejected_gate_dir" record-result --node requirement-intake --result completed --gate-owner workflow-owner --expected-revision 5 >/dev/null

migration_dir="$root_dir/legacy-shape-migration"
state "$migration_dir" init --task-id legacy-shape-migration --target-module /tmp/example >/dev/null
state "$migration_dir" start-node --node requirement-intake --expected-revision 0 >/dev/null
write_markdown_artifact "$migration_dir" legacy-shape-migration requirement-analysis.md requirement-intake completed
state "$migration_dir" record-result --node requirement-intake --result completed --gate-owner workflow-owner --expected-revision 1 >/dev/null
state "$migration_dir" approve-gate --gate-owner workflow-owner --decision-note approved --expected-revision 2 >/dev/null
ruby -ryaml - "$migration_dir/task.yaml" <<'RUBY'
path = ARGV.fetch(0)
task = YAML.safe_load(File.read(path), aliases: false)
task['artifacts'] = { 'requirement_analysis' => 'requirement-analysis.md' }
task['next_node'] = {
  'name' => task['next_node'],
  'skill' => task['next_node'],
  'input' => [],
  'output' => 'requirement-routing.json',
  'entry_condition' => 'legacy',
}
task['attempts'] = { 'requirement-clarification' => 2 }
task.delete('artifact_history')
task.delete('invalidation_history')
File.write(path, YAML.dump(task))
RUBY
state "$migration_dir" start-node --node requirement-routing --expected-revision 3 >/dev/null
ruby -ryaml - "$migration_dir/task.yaml" <<'RUBY'
task = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: false)
record = task.dig('artifacts', 'requirement-intake')
abort 'legacy artifact index was not normalized' unless record.is_a?(Hash) && record['attempt'] == 1 && record['sha256']&.length == 64
abort 'missing attempt counter was not rebuilt' unless task.dig('attempts', 'requirement-intake') == 1
abort 'removed node attempt was not discarded' if task.fetch('attempts').key?('requirement-clarification')
abort 'normalized start did not consume next_node' unless task['next_node'].nil?
RUBY

gate_migration_dir="$root_dir/legacy-gate-migration"
advance_to_pending_requirement_gate "$gate_migration_dir" legacy-gate-migration
ruby -ryaml - "$gate_migration_dir/task.yaml" <<'RUBY'
path = ARGV.fetch(0)
task = YAML.safe_load(File.read(path), aliases: false)
task['artifacts'] = {
  'requirement_analysis' => 'requirement-analysis.md',
}
task.delete('artifact_history')
task.delete('delivery_bindings')
task.delete('invalidation_history')
task.fetch('gate')['name'] = 'legacy-gate-name'
task.fetch('gate').delete('artifact_attempt')
task.fetch('gate').delete('artifact_sha256')
File.write(path, YAML.dump(task))
RUBY
state "$gate_migration_dir" approve-gate --gate-owner workflow-owner --decision-note approved --expected-revision 2 >/dev/null
ruby -ryaml - "$gate_migration_dir/task.yaml" <<'RUBY'
task = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: false)
abort 'legacy gate name was not removed' if task.fetch('gate').key?('name')
abort 'normalized gate retained legacy evidence fields' unless task.fetch('gate').keys.sort == %w[node owner status]
abort 'approved artifact was not marked' unless task.dig('artifacts', 'requirement-intake', 'approved') == true
RUBY

request_gate_dir="$root_dir/request-gate-migration"
state "$request_gate_dir" init --task-id request-gate-migration --target-module /tmp/example >/dev/null
state "$request_gate_dir" start-node --node requirement-intake --expected-revision 0 >/dev/null
write_markdown_artifact "$request_gate_dir" request-gate-migration requirement-analysis.md requirement-intake completed
state "$request_gate_dir" record-result --node requirement-intake --result completed --gate-owner workflow-owner --expected-revision 1 >/dev/null
ruby -ryaml - "$request_gate_dir/task.yaml" <<'RUBY'
path = ARGV.fetch(0)
task = YAML.safe_load(File.read(path), aliases: false)
task['gate'] = nil
task.dig('artifacts', 'requirement-intake')&.delete('approved')
File.write(path, YAML.dump(task))
RUBY
state "$request_gate_dir" request-gate --gate-owner workflow-owner --expected-revision 2 >/dev/null
ruby -ryaml - "$request_gate_dir/task.yaml" <<'RUBY'
task = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: false)
abort 'request-gate did not create a pending gate' unless task.dig('gate', 'status') == 'pending'
abort 'request-gate changed the existing next node' unless task['next_node'] == 'requirement-routing'
abort 'request-gate used the wrong owner' unless task.dig('gate', 'owner') == 'workflow-owner'
RUBY

recovery_dir="$root_dir/transaction-recovery"
state "$recovery_dir" init --task-id transaction-recovery --target-module /tmp/example >/dev/null
state "$recovery_dir" start-node --node requirement-intake --expected-revision 0 >/dev/null
write_markdown_artifact "$recovery_dir" transaction-recovery requirement-analysis.md requirement-intake completed
state "$recovery_dir" record-result --node requirement-intake --result completed --gate-owner workflow-owner --expected-revision 1 >/dev/null
state "$recovery_dir" approve-gate --gate-owner workflow-owner --decision-note approved --expected-revision 2 >/dev/null
mkdir -p "$recovery_dir/.workflow-discard"
mv "$recovery_dir/requirement-analysis.md" "$recovery_dir/.workflow-discard/requirement-analysis.md"
cat >"$recovery_dir/.workflow-transaction.json" <<'EOF'
{
  "type": "artifact-discard",
  "from_revision": 3,
  "to_revision": 4,
  "moves": [
    {
      "source": "requirement-analysis.md",
      "destination": ".workflow-discard/requirement-analysis.md"
    }
  ]
}
EOF
printf '%s' '{"actor":"workflow-orchestrator","pid":999999,"acquired_at":"stale"}' >"$recovery_dir/.workflow.lock"
expect_failure 'recovery probe unexpectedly accepted a stale revision' "$recovery_dir" \
  start-node --node requirement-routing --expected-revision 99
[ -f "$recovery_dir/requirement-analysis.md" ] || {
  echo 'ERROR: interrupted archive was not rolled back' >&2
  exit 1
}
[ ! -e "$recovery_dir/.workflow-discard" ] || {
  echo 'ERROR: rolled-back discard directory still exists' >&2
  exit 1
}
[ ! -e "$recovery_dir/.workflow-transaction.json" ] || {
  echo 'ERROR: recovered transaction journal still exists' >&2
  exit 1
}
[ -f "$recovery_dir/.workflow.lock" ] || {
  echo 'ERROR: workflow lock audit file is missing' >&2
  exit 1
}

committed_recovery_dir="$root_dir/committed-transaction-recovery"
state "$committed_recovery_dir" init --task-id committed-transaction-recovery --target-module /tmp/example >/dev/null
state "$committed_recovery_dir" start-node --node requirement-intake --expected-revision 0 >/dev/null
write_markdown_artifact "$committed_recovery_dir" committed-transaction-recovery requirement-analysis.md requirement-intake completed
state "$committed_recovery_dir" record-result --node requirement-intake --result completed --gate-owner workflow-owner --expected-revision 1 >/dev/null
state "$committed_recovery_dir" approve-gate --gate-owner workflow-owner --decision-note approved --expected-revision 2 >/dev/null
state "$committed_recovery_dir" invalidate-from --node requirement-intake --reason 'restart intake' --expected-revision 3 >/dev/null
mkdir -p "$committed_recovery_dir/.workflow-discard"
printf 'stale committed discard' >"$committed_recovery_dir/.workflow-discard/requirement-analysis.md"
cat >"$committed_recovery_dir/.workflow-transaction.json" <<'EOF'
{
  "type": "artifact-discard",
  "from_revision": 3,
  "to_revision": 4,
  "moves": [
    {
      "source": "requirement-analysis.md",
      "destination": ".workflow-discard/requirement-analysis.md"
    }
  ]
}
EOF
expect_failure 'committed recovery probe unexpectedly accepted a stale revision' "$committed_recovery_dir" \
  start-node --node requirement-intake --expected-revision 99
[ ! -e "$committed_recovery_dir/.workflow-discard" ] || {
  echo 'ERROR: committed discard was not cleaned' >&2
  exit 1
}
[ ! -e "$committed_recovery_dir/.workflow-transaction.json" ] || {
  echo 'ERROR: committed transaction journal was not cleared' >&2
  exit 1
}

invalid_schema_dir="$root_dir/invalid-state-combination"
state "$invalid_schema_dir" init --task-id invalid-state-combination --target-module /tmp/example >/dev/null
ruby -ryaml - "$invalid_schema_dir/task.yaml" <<'RUBY'
path = ARGV.fetch(0)
task = YAML.safe_load(File.read(path), aliases: false)
task['status'] = 'blocked'
File.write(path, YAML.dump(task))
RUBY
expect_failure 'blocked state without blockers passed conditional state invariants' "$invalid_schema_dir" \
  start-node --node requirement-intake --expected-revision 0

echo 'State machine guard tests passed.'
