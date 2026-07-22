import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const referencesRoot = path.join(repoRoot, 'skills/workflow-orchestrator/references');
const manifestPath = path.join(referencesRoot, 'contract-manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
let failures = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`ERROR: ${message}`);
    failures += 1;
  }
}

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function exists(relativePath) {
  return fs.existsSync(path.join(repoRoot, relativePath));
}

function loadReference(relativePath) {
  const absolutePath = path.join(referencesRoot, relativePath);
  assert(fs.existsSync(absolutePath), `Missing reference: ${relativePath}`);
  return fs.existsSync(absolutePath) ? JSON.parse(fs.readFileSync(absolutePath, 'utf8')) : {};
}

function frontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match?.[1] ?? '';
}

function h1Body(content, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return content.match(new RegExp(`^#\\s+${escaped}\\s*$\\n([\\s\\S]*?)(?=^#\\s+|(?![\\s\\S]))`, 'm'))?.[1] ?? '';
}

function markdownTables(content) {
  const groups = [];
  let current = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      current.push(trimmed);
    } else if (current.length > 0) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) groups.push(current);
  return groups.flatMap((lines) => {
    if (lines.length < 2) return [];
    const cells = (line) => line.slice(1, -1).split('|').map((cell) => cell.trim());
    const headers = cells(lines[0]);
    const separator = cells(lines[1]);
    if (separator.length !== headers.length || !separator.every((cell) => /^:?-{3,}:?$/.test(cell))) return [];
    return [{ headers, lines }];
  });
}

assert(
  JSON.stringify(Object.keys(manifest.contracts).sort()) ===
    JSON.stringify(['artifacts', 'deliveryEvidence', 'gates', 'nodes', 'paths', 'taskState']),
  'Manifest must expose exactly six top-level contract categories',
);
const contracts = Object.fromEntries(
  Object.entries(manifest.contracts).map(([name, relativePath]) => [name, loadReference(relativePath)]),
);
for (const relativePath of Object.values(manifest.guides)) {
  assert(fs.existsSync(path.join(referencesRoot, relativePath)), `Missing guide: ${relativePath}`);
}

const nodes = contracts.nodes.nodes ?? {};
const nodeIds = Object.keys(nodes);
const paths = contracts.paths.paths ?? {};
const taskStatuses = contracts.taskState?.properties?.status?.enum ?? [];
const artifactStatuses = contracts.artifacts?.properties?.status?.enum ?? [];
const gateStatuses = contracts.gates.statuses ?? [];
const gates = contracts.gates.gates ?? {};
const deliveryFields = Object.keys(contracts.deliveryEvidence.properties ?? {});
const deliveryStages = ['development-implementation', 'quality-verification', 'change-review'];
const taskPathSchema = contracts.taskState?.properties?.path ?? {};
const taskPathTypes = Array.isArray(taskPathSchema.type) ? taskPathSchema.type : [taskPathSchema.type];
const nodeSchemas = new Map();
const markdownArtifactSections = ['1. 结果', '2. 产出', '3. 待确认', '4. 下一步'];
const fourSectionTemplatePath = 'skills/workflow-orchestrator/references/four-section-artifact-template.md';

for (const [name, contract] of Object.entries({ manifest, ...contracts })) {
  assert(!Object.hasOwn(contract, 'schemaVersion'), `${name} must not define schemaVersion`);
}

assert(nodeIds.length === 8, 'Node registry must define exactly 8 nodes');
assert(
  JSON.stringify(Object.keys(paths).sort()) === JSON.stringify(['complex', 'lightweight']),
  'Workflow must define only lightweight and complex paths',
);
assert(
  JSON.stringify(Object.keys(gates)) === JSON.stringify(nodeIds),
  'Workflow must define one gate for every registered node',
);
nodeIds.forEach((node) => {
  assert(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(node), `Invalid semantic node id: ${node}`);
  const definition = nodes[node];
  const definitionKeys = Object.keys(definition);
  const requiredKeys = ['output', 'skill'];
  const allowedKeys = [...requiredKeys, 'schema'];
  assert(requiredKeys.every((key) => definitionKeys.includes(key)), `${node} is missing registry metadata`);
  assert(definitionKeys.every((key) => allowedKeys.includes(key)), `${node} contains unknown registry metadata`);
  assert(exists(definition.skill), `Missing skill definition for ${node}`);
  if (!exists(definition.skill)) return;
  const skill = read(definition.skill);
  assert(frontmatter(skill).includes(`name: ${node}`), `Skill metadata name does not match ${node}`);
  assert(skill.includes('task-lifecycle.md'), `${node} must load the task lifecycle guide`);
  assert(skill.includes('node-artifact.schema.json'), `${node} must load the node artifact Schema`);
  assert(skill.includes('node-rerun.md'), `${node} must load the node rerun guide`);
  assert(skill.includes('workflow-owner'), `${node} must require workflow-owner confirmation`);
  assert(
    /task\.yaml.*不得直接创建、修改或替换|不得直接修改.*task\.yaml/.test(skill),
    `${node} must prohibit direct task.yaml writes`,
  );
  if (definition.schema) {
    assert(exists(definition.schema), `Missing artifact schema for ${node}`);
    if (exists(definition.schema)) {
      const schema = JSON.parse(read(definition.schema));
      nodeSchemas.set(node, schema);
      assert(schema.allOf?.some((entry) => entry.$ref?.endsWith('node-artifact.schema.json')), `${node} schema must extend the common artifact schema`);
      const extension = schema.allOf?.find((entry) => entry.properties);
      assert(extension?.properties?.node?.const === node, `Artifact schema node const must match ${node}`);
    }
  }
});

assert(exists(fourSectionTemplatePath), 'Missing shared four-section Markdown artifact template');
const fourSectionTemplate = read(fourSectionTemplatePath);
const sharedTemplateHeadings = [...fourSectionTemplate.matchAll(/^#\s+([1-4]\.\s+.+)$/gm)].map((match) => match[1].trim());
assert(
  JSON.stringify(sharedTemplateHeadings) === JSON.stringify(markdownArtifactSections),
  'Shared Markdown artifact template must contain only the four standard sections in order',
);
const markdownNodes = nodeIds.filter((node) => nodes[node].output.endsWith('.md'));
assert(markdownNodes.length === 7, 'Workflow must define exactly seven Markdown artifact nodes');
for (const node of markdownNodes) {
  const skill = read(nodes[node].skill);
  assert(skill.includes('four-section-artifact-template.md'), `${node} must use the shared four-section artifact template`);
}
assert(!read(nodes['requirement-routing'].skill).includes('four-section-artifact-template.md'), 'Requirement routing JSON must not use the Markdown template');

const currentTemplatePaths = {
  'requirement-intake': 'skills/requirement-intake/references/output-template.md',
  'acceptance-design': 'skills/acceptance-design/references/checklist-template.md',
  'impact-analysis': 'skills/impact-analysis/references/output-template.md',
  'implementation-design': 'skills/implementation-design/references/output-template.md',
  'development-implementation': 'skills/development-implementation/references/output-template.md',
  'quality-verification': 'skills/quality-verification/references/output-template.md',
  'change-review': 'skills/change-review/references/output-template.md',
};
const commonPendingHeader = '| ID | 类型 | 事项与影响 | Owner | 责任节点 | 完成条件 |';
for (const [node, templatePath] of Object.entries(currentTemplatePaths)) {
  const template = read(templatePath);
  assert(template.includes('artifact_schema_version: 1'), `${node} template must use artifact_schema_version 1`);
  assert(!template.includes('template_version:'), `${node} template must not use legacy template_version`);
  const headings = [...template.matchAll(/^#\s+([1-4]\.\s+.+)$/gm)].map((match) => match[1].trim());
  assert(JSON.stringify(headings) === JSON.stringify(markdownArtifactSections), `${node} template must use the four standard headings`);
  assert(!/^##\s+/m.test(template), `${node} template must not use level-2 headings`);
  const tables = markdownTables(template);
  assert(tables.length <= 3, `${node} template must contain at most three tables`);
  assert(tables.every((table) => table.headers.length <= 6), `${node} template tables must contain at most six columns`);
  const nextFields = [...h1Body(template, '4. 下一步').matchAll(/^-\s+([^：:]+)[：:]/gm)].map((match) => match[1].trim());
  assert(JSON.stringify(nextFields) === JSON.stringify(['当前动作', '完成条件']), `${node} next step must contain only action and completion condition`);
  if (node !== 'requirement-intake') {
    assert(h1Body(template, '3. 待确认').includes(commonPendingHeader), `${node} must use the common unresolved-item table`);
  }
}
const routingSkill = read(nodes['requirement-routing'].skill);
assert(routingSkill.includes('"artifact_schema_version": 1'), 'Requirement routing template must use artifact_schema_version 1');
assert(routingSkill.includes('"unresolved_items": []'), 'Requirement routing template must expose unresolved_items');

assert(!contracts.artifacts.required?.includes('artifact'), 'Common artifact Schema must not require a duplicate artifact type');
assert(!contracts.artifacts.properties?.artifact, 'Common artifact Schema must not define a duplicate artifact type');
assert(
  JSON.stringify(contracts.artifacts.required) === JSON.stringify(['task_id', 'node', 'status', 'attempt']),
  'Common artifact Schema must contain only the four machine-required fields',
);
for (const removedField of ['schema_version', 'supersedes', 'inputs', 'depends_on', 'target_module']) {
  assert(!contracts.artifacts.properties?.[removedField], `Common artifact Schema still defines removed field ${removedField}`);
}

assert(
  JSON.stringify(taskStatuses) === JSON.stringify(['active', 'awaiting_confirmation', 'blocked', 'completed', 'cancelled']),
  'Task state Schema has unexpected statuses',
);
assert(
  !contracts.taskState?.required?.includes('schema_version') && !contracts.taskState?.properties?.schema_version,
  'Task state Schema must not define schema_version',
);
assert(
  JSON.stringify(contracts.taskState['x-terminalStatuses']) === JSON.stringify(['completed', 'cancelled']),
  'Task state Schema has unexpected terminal statuses',
);
assert(
  JSON.stringify(artifactStatuses) === JSON.stringify(['awaiting_confirmation', 'completed', 'blocked']),
  'Artifact Schema has unexpected statuses',
);
assert(contracts.artifacts.properties?.artifact_schema_version?.const === 1, 'Current artifacts must use artifact_schema_version 1');
assert(
  JSON.stringify(contracts.artifacts.properties?.template_version?.enum) === JSON.stringify([2, 3]),
  'Artifact Schema must retain legacy template_version 2/3 compatibility',
);
assert(
  JSON.stringify(gateStatuses) === JSON.stringify(['pending', 'approved', 'rejected']),
  'Gate contract has unexpected statuses',
);
assert(!('enum' in taskPathSchema), 'Task state must not duplicate workflow path names');
assert(
  taskPathTypes.includes('string') && taskPathTypes.includes('null'),
  'Task state path must allow a registered path name or null',
);
for (const definition of ['artifactIndex', 'artifactRecord', 'attemptIndex', 'gate', 'cancellation', 'blocker']) {
  assert(contracts.taskState.$defs?.[definition], `Task state Schema is missing $defs.${definition}`);
}
assert(!contracts.taskState.$defs?.nextNode, 'Task state must not duplicate node registry metadata in nextNode');
const nextNodeSchema = contracts.taskState.properties?.next_node ?? {};
const nextNodeTypes = Array.isArray(nextNodeSchema.type) ? nextNodeSchema.type : [nextNodeSchema.type];
assert(
  nextNodeTypes.includes('string') && nextNodeTypes.includes('null'),
  'Task state next_node must be a node id or null',
);
for (const removedField of ['artifact_history', 'blocker_history', 'confirmation_history', 'invalidation_history', 'delivery_bindings']) {
  assert(!contracts.taskState.properties?.[removedField], `Minimal task state still defines ${removedField}`);
}
assert(
  !contracts.taskState.$defs?.gate?.required?.includes('name') && !contracts.taskState.$defs?.gate?.properties?.name,
  'Task gate state must use node as its identifier',
);
assert(
  JSON.stringify(contracts.taskState.$defs?.artifactRecord?.required) === JSON.stringify(['attempt', 'sha256']) &&
    !contracts.taskState.$defs?.artifactRecord?.properties?.file,
  'Artifact state records must bind only attempt and sha256',
);
assert(contracts.taskState.$defs?.artifactRecord?.properties?.approved?.const === true, 'Artifact approval marker must be true when present');
assert(
  contracts.taskState.properties?.attempts?.$ref === '#/$defs/attemptIndex' &&
    contracts.taskState.$defs?.attemptIndex?.additionalProperties?.type === 'integer',
  'Task state must retain per-node attempt counters',
);
for (const status of taskStatuses) {
  assert(
    contracts.taskState.allOf?.some((branch) => branch.if?.properties?.status?.const === status && branch.then),
    `Task state Schema is missing ${status} invariants`,
  );
}
assert(
  JSON.stringify(contracts.taskState.$defs?.gate?.required) === JSON.stringify(['node', 'status', 'owner']),
  'Current gate must contain only node, status, and owner',
);

for (const [pathName, sequence] of Object.entries(paths)) {
  assert(sequence[0] === 'requirement-intake', `${pathName} must start at requirement intake`);
  assert(sequence.at(-1) === 'change-review', `${pathName} must end at change review`);
  assert(sequence[1] === 'requirement-routing', `${pathName} must route the confirmed requirement definition`);
  assert(sequence.includes('requirement-routing'), `${pathName} must include requirement routing`);
  assert(sequence.every((node) => nodeIds.includes(node)), `${pathName} contains an unknown node`);
  assert(new Set(sequence).size === sequence.length, `${pathName} contains duplicate nodes`);
}

for (const [node, gate] of Object.entries(gates)) {
  assert(nodeIds.includes(node), `Gate is defined for unknown node ${node}`);
  const gateKeys = Object.keys(gate);
  const requiredGateKeys = ['rejectedNext'];
  const allowedGateKeys = [...requiredGateKeys, 'paths', 'beforePathSelection', 'approvedNext'];
  assert(requiredGateKeys.every((key) => gateKeys.includes(key)), `Gate ${node} is missing required routing metadata`);
  assert(gateKeys.every((key) => allowedGateKeys.includes(key)), `Gate ${node} contains unknown routing metadata`);
  assert(gate.beforePathSelection || gate.paths, `Gate ${node} must apply before path selection or define paths`);
  assert(!gate.paths || (Array.isArray(gate.paths) && gate.paths.length > 0), `Gate ${node} has invalid paths`);
  assert(!gate.paths || new Set(gate.paths).size === gate.paths.length, `Gate ${node} contains duplicate paths`);
  assert(
    gate.beforePathSelection === undefined || typeof gate.beforePathSelection === 'boolean',
    `Gate ${node} has invalid beforePathSelection`,
  );
  assert(nodeIds.includes(gate.rejectedNext), `Gate ${node} has unknown rejectedNext`);
  assert(!gate.approvedNext || nodeIds.includes(gate.approvedNext), `Gate ${node} has unknown approvedNext`);
  assert(!gate.beforePathSelection || gate.approvedNext, `Gate ${node} requires approvedNext before path selection`);
  assert((gate.paths ?? []).every((pathName) => paths[pathName]), `Gate ${node} contains an unknown path`);
  for (const pathName of gate.paths ?? []) {
    const index = paths[pathName]?.indexOf(node) ?? -1;
    assert(index >= 0 || gate.approvedNext, `Gate ${node} requires approvedNext outside ${pathName}`);
  }
}
assert(
  !Object.hasOwn(gates['requirement-intake'] ?? {}, 'paths'),
  'Pre-path requirement intake gate must not duplicate workflow paths',
);
assert(!Object.hasOwn(gates, 'requirement-clarification'), 'Removed requirement clarification gate must not remain');

const requirementRoutingSchema = nodeSchemas.get('requirement-routing');
const requirementRoutingExtension = requirementRoutingSchema?.allOf?.find((entry) => entry.properties);
assert(
  JSON.stringify(requirementRoutingExtension?.required) === JSON.stringify(['path', 'reason']),
  'Requirement routing schema must require only path and reason',
);
assert(!requirementRoutingExtension?.properties?.path?.enum, 'Requirement routing must not duplicate workflow path names');
for (const removedField of ['acceptanceCriteria', 'rollback']) {
  assert(!requirementRoutingExtension?.properties?.[removedField], `Requirement routing still defines ${removedField}`);
}
for (const field of ['decisionState', 'confidence', 'matchedRules', 'complexTriggers', 'requiredNodes', 'requiredArtifacts', 'executionBrief', 'requiresOwnerApproval']) {
  assert(!requirementRoutingExtension?.properties?.[field], `Requirement routing schema still defines removed field ${field}`);
}
assert(requirementRoutingExtension?.properties?.evidence?.type === 'array', 'Requirement routing must expose evidence');
assert(requirementRoutingExtension?.properties?.unresolved_items?.type === 'array', 'Requirement routing must expose unresolved_items');
assert(
  JSON.stringify(requirementRoutingExtension?.properties?.unresolved_items?.items?.required) ===
    JSON.stringify(['id', 'type', 'issue_and_impact', 'owner', 'retry_node', 'completion_condition']),
  'Requirement routing unresolved items must use the common six-field contract',
);

const requirementIntakeSkill = read('skills/requirement-intake/SKILL.md');
const requirementIntakeTemplate = read('skills/requirement-intake/references/output-template.md');
const questionDialogTemplate = read('skills/requirement-intake/references/question-dialog-template.md');
for (const idPrefix of ['RF-*', 'RQ-*', 'CL-*']) {
  assert(requirementIntakeSkill.includes(idPrefix), `Requirement intake must define ${idPrefix} evidence identifiers`);
}
assert(
  !requirementIntakeTemplate.includes('建议处理'),
  'Requirement intake template must not decide how an observed difference is implemented',
);
assert(
  requirementIntakeTemplate.includes('RF-001') &&
    requirementIntakeTemplate.includes('RQ-001') &&
    requirementIntakeTemplate.includes('CL-001'),
  'Requirement intake template must expose fact, question, and decision identifiers',
);
assert(
  requirementIntakeTemplate.includes('| 问题 ID | 决策 ID | 来源事实 | 需要确认 | 采用规则 | 状态 |') &&
    requirementIntakeTemplate.includes('已人工确认'),
  'Requirement intake template must combine RQ questions with confirmed CL decisions',
);
assert(
  requirementIntakeSkill.includes('一轮对话只展示一个 `RQ-*`') &&
    requirementIntakeSkill.includes('references/question-dialog-template.md') &&
    requirementIntakeSkill.includes('确认 RQ-001') &&
    requirementIntakeSkill.includes('修改 RQ-001') &&
    !requirementIntakeSkill.includes('拒绝 RQ-001') &&
    !requirementIntakeTemplate.includes('当前问题对话模板') &&
    questionDialogTemplate.includes('| 疑点标题 |') &&
    questionDialogTemplate.includes('| 具体问题 |') &&
    questionDialogTemplate.includes('| 产生原因 |') &&
    questionDialogTemplate.includes('| 推荐答案 |') &&
    questionDialogTemplate.includes('| 影响范围 |') &&
    questionDialogTemplate.includes('不保存任务进度') &&
    questionDialogTemplate.includes('不复制到 `requirement-analysis.md`'),
  'Requirement intake must confirm every question through sequential dialogue',
);
assert(!exists('skills/requirement-clarification/SKILL.md'), 'Removed requirement clarification skill must not remain');
assert(!exists('skills/solution-review/SKILL.md'), 'Removed solution review skill must not remain');

for (const node of ['development-implementation', 'quality-verification', 'change-review']) {
  const skill = read(nodes[node].skill);
  assert(skill.includes('delivery-evidence.md'), `${node} must load the delivery evidence guide`);
}

const orchestrator = read('skills/workflow-orchestrator/SKILL.md');
assert(orchestrator.includes('contract-manifest.json'), 'Orchestrator must load the contract manifest');
assert(orchestrator.includes('state-storage.md'), 'Orchestrator must load the state storage guide');
assert(orchestrator.includes('invalidate-from'), 'Orchestrator must use the unified invalidation command');
assert(orchestrator.includes('task-state.rb audit'), 'Orchestrator must audit an existing task before resuming');
assert(
  orchestrator.includes('确认节点：<task-id>/<node-id>@<revision>') &&
    orchestrator.includes('执行下一节点') &&
    orchestrator.includes('--actor workflow-owner') &&
    orchestrator.includes('--confirmation'),
  'Orchestrator must require an exact owner confirmation instead of inferring approval',
);
assert(
  orchestrator.includes('awaiting_confirmation') && orchestrator.includes('`blocked` 只用于'),
  'Orchestrator must distinguish normal confirmation waits from real blockers',
);
const taskStateCli = read('scripts/task-state.rb');
for (const requiredText of [
  'validate_requirement_intake!',
  'Requirement intake does not answer',
  'Requirement intake references unknown questions',
  'must be individually confirmed by the owner',
]) {
  assert(taskStateCli.includes(requiredText), `Task state CLI must enforce requirement decision coverage: ${requiredText}`);
}
for (const requiredText of [
  "GATE_ACTOR = 'workflow-owner'",
  'ARTIFACT_SCHEMA_VERSION = 1',
  'awaiting_confirmation',
  'approve_confirmation',
  'reject_confirmation',
  'start_confirmation',
  '--confirmation must exactly equal',
  '确认节点',
  '拒绝节点',
  '执行节点',
]) {
  assert(taskStateCli.includes(requiredText), `Task state CLI must enforce gate confirmation text: ${requiredText}`);
}
const taskLifecycleGuide = read('skills/workflow-orchestrator/references/guides/task-lifecycle.md');
assert(taskLifecycleGuide.includes('状态转换矩阵'), 'Task lifecycle guide must define the command transition matrix');
assert(taskLifecycleGuide.includes('消费 `next_node`'), 'Task lifecycle guide must define start-node consumption');
assert(taskLifecycleGuide.includes('| `audit` |'), 'Task lifecycle guide must define the read-only audit command');
const stateStorageGuide = read('skills/workflow-orchestrator/references/guides/state-storage.md');
assert(stateStorageGuide.includes('按字段形态自动归一化'), 'State storage guide must document shape-based normalization');
assert(stateStorageGuide.includes('.workflow-transaction.json'), 'State storage guide must document transaction recovery');
assert(stateStorageGuide.includes('task-state.rb audit'), 'State storage guide must document read-only task audit');
assert(
  read('skills/workflow-orchestrator/references/guides/node-rerun.md').includes('invalidate-from'),
  'Node rerun guide must use the unified invalidation command',
);

assert(
  JSON.stringify(deliveryFields) === JSON.stringify(['repository_root', 'base_commit', 'candidate_tree', 'change_fingerprint']),
  'Delivery evidence must contain only the four code identity fields',
);
assert(
  JSON.stringify(contracts.deliveryEvidence.required) === JSON.stringify(deliveryFields),
  'Every delivery identity field must be present in task state',
);
for (const removedField of ['x-completionRequired', 'x-stageWriters', 'x-stageRequired', 'x-frozenFields']) {
  assert(!Object.hasOwn(contracts.deliveryEvidence, removedField), `Delivery evidence still defines ${removedField}`);
}
assert(deliveryStages.every((node) => nodeIds.includes(node)), 'Delivery stage references an unknown node');

for (const [name, contract] of Object.entries(contracts)) {
  const forbidden = ['nodes', 'paths', 'gates'].filter((key) => key in contract && key !== ({ nodes: 'nodes', paths: 'paths', gates: 'gates' })[name]);
  assert(forbidden.length === 0, `${name} contract owns unrelated keys: ${forbidden.join(', ')}`);
}

for (const removed of [
  'skills/workflow-orchestrator/references/workflow-contract.json',
  'skills/workflow-orchestrator/references/task-state-contract.md',
  'skills/workflow-orchestrator/references/artifact-contract.md',
  'skills/workflow-orchestrator/references/delivery-evidence-contract.md',
]) {
  assert(!exists(removed), `Legacy mixed contract still exists: ${removed}`);
}

if (process.argv[2]) {
  const trace = fs.readFileSync(process.argv[2], 'utf8');
  const calls = [...trace.matchAll(/^CALL ([a-z][a-z0-9-]*) task=([^\s]+)(?: route=([^\s]+))?$/gm)];
  const approvals = [...trace.matchAll(/^GATE ([a-z][a-z0-9-]*) task=([^\s]+) status=approved$/gm)];
  const byTask = new Map();
  for (const [, node, taskId, route] of calls) {
    const item = byTask.get(taskId) ?? { nodes: [], route: null };
    item.nodes.push(node);
    item.route ||= route;
    byTask.set(taskId, item);
  }
  for (const [taskId, item] of byTask) {
    const expected = item.route ? paths[item.route] : null;
    assert(expected, `Trace task ${taskId} is missing a valid route`);
    assert(JSON.stringify(item.nodes) === JSON.stringify(expected), `Trace task ${taskId} does not match its path`);
    const approvedNodes = approvals
      .filter(([, , approvedTaskId]) => approvedTaskId === taskId)
      .map(([, node]) => node);
    assert(JSON.stringify(approvedNodes) === JSON.stringify(expected), `Trace task ${taskId} does not approve every node`);
  }
  for (const pathName of Object.keys(paths)) {
    assert([...byTask.values()].some((item) => item.route === pathName), `Trace does not cover ${pathName}`);
  }
  assert(trace.includes('PASS all development paths completed'), 'Trace does not report completion');
}

if (failures > 0) process.exit(1);
console.log('Workflow contract validation passed.');
