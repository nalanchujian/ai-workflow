# AI Workflow MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the local `aiw` CLI MVP for versioned skills, task DAGs, approval-gated context packages, and Codex execution.

**Architecture:** The CLI calls application services through ports for Git, HTTP/DNS, filesystem and child processes. Task state and artifacts live under `.aiw/tasks/<task-id>`; the Runner validates the task and context manifest before a Codex Adapter may invoke the external CLI. The domain model remains independent of Commander, Node process APIs and Codex-specific arguments.

**Tech Stack:** Node.js 22+, TypeScript strict mode, pnpm, Commander, Zod, yaml, Vitest, ESLint, native `fetch`, Node `crypto`, `child_process`.

## Global Constraints

- Persist all task state only beneath `<projectRoot>/.aiw/`; `.aiw/` is Git-ignored.
- Support one local Agent and one running task node at a time.
- Validate all CLI arguments, YAML/JSON data, paths, URLs and process results with Zod or explicit boundary checks.
- Never use real network, Git remotes or Codex in unit tests; inject ports and use fakes.
- Only inject a rule-approved, hash-recorded context manifest; never silently truncate a file above the 12,000-token default budget.
- Keep source, skill, user task and Runner constraints in distinct labeled blocks when creating Agent context.

## Planned File Structure

```text
package.json                         # scripts, dependencies and aiw bin entry
tsconfig.json                        # strict TypeScript compiler configuration
eslint.config.js                     # TypeScript lint rules
src/cli.ts                           # executable entry point
src/cli/create-program.ts            # Commander program and command registration
src/cli/output.ts                    # human and --json output formatting
src/domain/task.ts                   # task/node schemas and state types
src/domain/skill.ts                  # skill and registry schemas
src/domain/run.ts                    # RunRequest and RunResult schemas
src/ports/git-client.ts              # clone/fetch/revision port
src/ports/network-client.ts          # DNS and HTTP port
src/ports/process-runner.ts          # child-process port
src/services/task-store.ts           # atomic task.yaml and event persistence
src/services/task-state-machine.ts   # legal transition and invalidation logic
src/services/source-intake.ts        # local/URL snapshot creation
src/services/skill-registry.ts       # user-level registry persistence
src/services/skill-installer.ts      # Git skill install and validation
src/services/context-builder.ts      # phase selection, manifest and context.md
src/services/task-runner.ts          # ready-node validation and run lifecycle
src/adapters/codex-adapter.ts        # Codex process preparation and collection
tests/...                            # mirrored unit and CLI integration tests
```

---

### Task 1: Initialize the typed CLI foundation

**Files:**
- Create: `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `eslint.config.js`, `.npmrc`
- Create: `src/cli.ts`, `src/cli/create-program.ts`, `src/cli/output.ts`
- Create: `tests/cli/help.test.ts`, `tests/cli/output.test.ts`, `tests/helpers/run-cli.ts`
- Modify: `README.md`

**Interfaces:**
- Produces `createProgram(deps: CliDependencies): Command`.
- Produces `writeResult(value: unknown, options: { json: boolean; stdout: NodeJS.WriteStream }): void`.

- [ ] **Step 1: Write the failing CLI tests**

```ts
it('prints the command list for --help', async () => {
  const result = await runCli(['--help']);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('skills');
  expect(result.stdout).toContain('task');
});

it('prints one JSON document when --json is selected', () => {
  const stdout = { text: '', write(chunk: string) { this.text += chunk; return true; } } as unknown as NodeJS.WriteStream & { text: string };
  writeResult({ taskId: 'refund-123' }, { json: true, stdout });
  expect(stdout.text).toBe('{"taskId":"refund-123"}\n');
});
```

- [ ] **Step 2: Run the tests to verify the missing CLI fails**

Run: `pnpm vitest run tests/cli/help.test.ts tests/cli/output.test.ts`
Expected: FAIL because the package scripts and `runCli` implementation do not exist.

- [ ] **Step 3: Add the package scripts and minimal Commander program**

```ts
export function createProgram(deps: CliDependencies): Command {
  return new Command()
    .name('aiw')
    .version(deps.version)
    .option('--json', 'emit a single JSON result')
    .addCommand(new Command('skills'))
    .addCommand(new Command('task'));
}
```

Define `build`, `test`, `lint`, `typecheck` and `dev` scripts in `package.json`; make `src/cli.ts` call `createProgram` and route exceptions to stderr with exit code `1`. Implement `runCli(args)` in `tests/helpers/run-cli.ts` by creating the program with fake dependencies and capturing stdout, stderr and exit code.

- [ ] **Step 4: Run the foundation checks**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all commands exit `0`.

- [ ] **Step 5: Commit the foundation**

```bash
git add package.json pnpm-lock.yaml tsconfig.json eslint.config.js .npmrc src/cli.ts src/cli tests/cli tests/helpers README.md
git commit -m "feat: initialize aiw CLI foundation"
```

### Task 2: Implement the task domain model and state machine

**Files:**
- Create: `src/domain/task.ts`, `src/services/task-state-machine.ts`
- Create: `tests/domain/task.test.ts`, `tests/services/task-state-machine.test.ts`

**Interfaces:**
- Produces `TaskSchema`, `TaskNodeSchema`, `TaskStatus`, `NodeStatus` and `Task`.
- Produces `transitionNode(task: Task, nodeId: string, event: NodeEvent): Task`.
- Produces `invalidateDependents(task: Task, upstreamNodeId: string, reason: string): Task`.

- [ ] **Step 1: Write failing state-transition tests**

```ts
it('only makes a node ready after every dependency completes', () => {
  const task = taskWith({ analysis: 'completed', design: 'pending' });
  expect(transitionNode(task, 'design', { type: 'evaluate' }).nodes.design.status).toBe('ready');
});

it('invalidates every started descendant when an approved upstream is revised', () => {
  const next = invalidateDependents(completedPipelineTask(), 'analysis', 'requirements changed');
  expect(next.nodes.design.status).toBe('invalidated');
  expect(next.nodes.testing.status).toBe('invalidated');
});
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `pnpm vitest run tests/domain/task.test.ts tests/services/task-state-machine.test.ts`
Expected: FAIL because state schemas and transitions are absent.

- [ ] **Step 3: Implement immutable schemas and legal transitions**

```ts
export type NodeEvent =
  | { type: 'evaluate' }
  | { type: 'start'; runId: string }
  | { type: 'succeed'; outputs: OutputRecord[] }
  | { type: 'approve'; actor: string; note?: string }
  | { type: 'revise'; actor: string; note: string }
  | { type: 'fail'; message: string };

export interface OutputRecord {
  path: string;
  sha256: string;
}

export function transitionNode(task: Task, nodeId: string, event: NodeEvent): Task;
```

Reject unknown node IDs and illegal events with a typed `TaskTransitionError`. Keep approval events separate from `NodeStatus`; add a DFS cycle check when parsing or creating a task.

- [ ] **Step 4: Run state-model tests and all checks**

Run: `pnpm vitest run tests/domain/task.test.ts tests/services/task-state-machine.test.ts && pnpm lint && pnpm typecheck`
Expected: all commands exit `0`.

- [ ] **Step 5: Commit the state machine**

```bash
git add src/domain/task.ts src/services/task-state-machine.ts tests/domain/task.test.ts tests/services/task-state-machine.test.ts
git commit -m "feat: add task DAG state machine"
```

### Task 3: Persist tasks and create local source snapshots

**Files:**
- Create: `src/ports/network-client.ts`, `src/services/task-store.ts`, `src/services/source-intake.ts`
- Create: `src/services/task-initializer.ts`
- Create: `src/cli/task-init-command.ts`
- Create: `tests/services/task-store.test.ts`, `tests/services/source-intake.test.ts`, `tests/cli/task-init-command.test.ts`

**Interfaces:**
- Consumes `Task` and `TaskSchema` from Task 2.
- Produces `TaskStore.create(task: Task): Promise<void>`, `TaskStore.load(id: string): Promise<Task>`, `TaskStore.update(task: Task): Promise<void>`.
- Produces `SourceIntake.snapshot(input: SourceInput): Promise<SnapshotRecord>`.
- Produces `TaskInitializer.init(input: { id: string; projectRoot: string; source: string }): Promise<Task>`.

- [ ] **Step 1: Write failing task-init and URL-security tests**

```ts
it('creates a task file and hashes a local Markdown snapshot', async () => {
  const result = await service.init({ id: 'refund-123', source: fixture('requirements.md') });
  expect(await readFile(result.snapshotPath, 'utf8')).toContain('# Refund');
  expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
});

it('rejects a URL that resolves to a loopback address before fetch', async () => {
  await expect(intake.snapshot({ kind: 'url', value: 'http://example.test/doc' }))
    .rejects.toMatchObject({ code: 'UNSAFE_URL' });
  expect(fakeNetwork.fetch).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `pnpm vitest run tests/services/task-store.test.ts tests/services/source-intake.test.ts tests/cli/task-init-command.test.ts`
Expected: FAIL because storage and intake services are absent.

- [ ] **Step 3: Implement atomic storage and safe source intake**

Create `task.yaml`, `task.md`, `sources/<source-id>/snapshot.md` and `meta.json` under `.aiw/tasks/<id>`. `TaskInitializer` must mark `intake` as `completed` after a successful snapshot and evaluate `analysis` to `ready`. Write via a sibling temporary file followed by rename. Resolve every redirect through `NetworkClient.resolveHost`; reject non-HTTP(S), loopback, private, link-local and reserved addresses before any request. Enforce a 5-redirect limit, 5 MiB maximum response, 15-second timeout and `text/plain`, `text/markdown` or `text/html` content types; convert HTML with an HTML-to-text dependency.

- [ ] **Step 4: Run task-init tests and all checks**

Run: `pnpm vitest run tests/services/task-store.test.ts tests/services/source-intake.test.ts tests/cli/task-init-command.test.ts && pnpm lint && pnpm typecheck`
Expected: all commands exit `0`.

- [ ] **Step 5: Commit task initialization**

```bash
git add src/ports/network-client.ts src/services/task-store.ts src/services/source-intake.ts src/services/task-initializer.ts src/cli/task-init-command.ts tests/services/task-store.test.ts tests/services/source-intake.test.ts tests/cli/task-init-command.test.ts
git commit -m "feat: initialize tasks with source snapshots"
```

### Task 4: Add Git-backed skill installation and registry

**Files:**
- Create: `src/domain/skill.ts`, `src/ports/git-client.ts`, `src/services/skill-registry.ts`, `src/services/skill-installer.ts`
- Create: `src/cli/skills-commands.ts`
- Create: `tests/services/skill-installer.test.ts`, `tests/services/skill-registry.test.ts`, `tests/cli/skills-commands.test.ts`

**Interfaces:**
- Produces `SkillSchema`, `InstalledSkillSchema` and `SkillRegistry`.
- Produces `SkillInstaller.install(input: { url: string; ref?: string }): Promise<InstalledSkill[]>`.
- Produces `SkillRegistry.list(): Promise<InstalledSkill[]>` and `SkillRegistry.find(name: string, version?: string): Promise<InstalledSkill>`.

- [ ] **Step 1: Write failing skill installation tests**

```ts
it('records valid skills and their locked Git revision', async () => {
  fakeGit.cloneResult = { revision: 'abc123', directory: fixture('valid-skill-repo') };
  const installed = await installer.install({ url: 'https://example.test/skills.git' });
  expect(installed[0]).toMatchObject({ name: 'requirements-analysis', version: '1.0.0', revision: 'abc123' });
});

it('does not mutate the registry when no valid SKILL.md exists', async () => {
  fakeGit.cloneResult = { revision: 'abc123', directory: fixture('invalid-skill-repo') };
  await expect(installer.install({ url: 'https://example.test/skills.git' })).rejects.toThrow('No valid skills');
  await expect(registry.list()).resolves.toEqual([]);
});
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `pnpm vitest run tests/services/skill-installer.test.ts tests/services/skill-registry.test.ts tests/cli/skills-commands.test.ts`
Expected: FAIL because the registry and installer are absent.

- [ ] **Step 3: Implement registry and skill validation**

Define a `GitClient` port with `clone(url, destination, ref?)` and `revision(directory)`. Persist user-level registry JSON atomically under the platform data directory. Parse front matter with `yaml`; require non-empty `name`, semantic `version`, non-empty `description`, and a non-empty `phases` array. Replace an existing entry with the same normalized source URL instead of appending a duplicate.

- [ ] **Step 4: Run skill tests and all checks**

Run: `pnpm vitest run tests/services/skill-installer.test.ts tests/services/skill-registry.test.ts tests/cli/skills-commands.test.ts && pnpm lint && pnpm typecheck`
Expected: all commands exit `0`.

- [ ] **Step 5: Commit skill support**

```bash
git add src/domain/skill.ts src/ports/git-client.ts src/services/skill-registry.ts src/services/skill-installer.ts src/cli/skills-commands.ts tests/services/skill-installer.test.ts tests/services/skill-registry.test.ts tests/cli/skills-commands.test.ts
git commit -m "feat: install and list versioned skills"
```

### Task 5: Build approval commands and context manifests

**Files:**
- Create: `src/services/context-builder.ts`, `src/cli/task-state-commands.ts`
- Create: `src/domain/context.ts`
- Create: `tests/services/context-builder.test.ts`, `tests/cli/task-state-commands.test.ts`
- Modify: `src/services/task-store.ts`

**Interfaces:**
- Consumes `TaskStore`, `transitionNode`, `SkillRegistry` and a loaded skill.
- Produces `ContextBuilder.build(input: { task: Task; nodeId: string; skill: InstalledSkill; includes: string[] }): Promise<ContextManifest>`.
- Produces `ContextManifestSchema` in `src/domain/context.ts` with `schemaVersion: 'aiw.context/v1'`.

- [ ] **Step 1: Write failing approval, invalidation and budget tests**

```ts
it('approves the current analysis revision and unlocks design', async () => {
  await commands.approve('refund-123', 'analysis');
  expect((await store.load('refund-123')).nodes.design.status).toBe('ready');
});

it('fails above the context budget without truncating any file', async () => {
  await expect(builder.build(overBudgetInput())).rejects.toMatchObject({ code: 'CONTEXT_BUDGET_EXCEEDED' });
  expect(await readFile(largeArtifact, 'utf8')).toBe(originalLargeArtifact);
});
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `pnpm vitest run tests/services/context-builder.test.ts tests/cli/task-state-commands.test.ts`
Expected: FAIL because approval commands and context builder are absent.

- [ ] **Step 3: Implement manifest construction and command handlers**

Make `approve`, `revise` and `task status` delegate exclusively to the Task State Machine and Task Store. For `analysis`, include `task.md` and source snapshots; for `design`, require completed analysis and include `brief.md`, `questions.md`, `acceptance.md`; for `implementation` and `testing`, use only listed approved artifacts. Hash every selected file, estimate tokens deterministically as `Math.ceil(text.length / 4)`, enforce 12,000 tokens, and write `context-manifest.json` under the new run directory.

- [ ] **Step 4: Run context and state command checks**

Run: `pnpm vitest run tests/services/context-builder.test.ts tests/cli/task-state-commands.test.ts && pnpm lint && pnpm typecheck`
Expected: all commands exit `0`.

- [ ] **Step 5: Commit task control and context logic**

```bash
git add src/domain/context.ts src/services/context-builder.ts src/services/task-store.ts src/cli/task-state-commands.ts tests/services/context-builder.test.ts tests/cli/task-state-commands.test.ts
git commit -m "feat: add approvals and context manifests"
```

### Task 6: Implement the Codex Adapter and task runner

**Files:**
- Create: `src/domain/run.ts`, `src/ports/process-runner.ts`, `src/adapters/codex-adapter.ts`, `src/services/task-runner.ts`, `src/cli/task-run-command.ts`
- Create: `tests/adapters/codex-adapter.test.ts`, `tests/services/task-runner.test.ts`, `tests/cli/task-run-command.test.ts`

**Interfaces:**
- Produces `RunRequestSchema`, `RunResultSchema`, `CodexAdapter.run(request: RunRequest): Promise<RunResult>`.
- Produces `TaskRunner.run(input: { taskId: string; nodeId: string; dryRun: boolean; includes: string[] }): Promise<RunResult>`.

- [ ] **Step 1: Write failing dry-run and process-result tests**

```ts
it('writes a dry-run request without starting Codex', async () => {
  const result = await runner.run({ taskId: 'refund-123', nodeId: 'analysis', dryRun: true, includes: [] });
  expect(result.status).toBe('succeeded');
  expect(fakeProcess.calls).toHaveLength(0);
  expect(await readFile(join(result.runDirectory, 'context.md'), 'utf8')).toContain('<skill');
});

it('maps a missing executable to unavailable and marks the node failed', async () => {
  fakeProcess.throwOnStart = new ExecutableNotFoundError('codex');
  await expect(runner.run(executeInput())).resolves.toMatchObject({ status: 'unavailable' });
  expect((await store.load('refund-123')).nodes.analysis.status).toBe('failed');
});
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `pnpm vitest run tests/adapters/codex-adapter.test.ts tests/services/task-runner.test.ts tests/cli/task-run-command.test.ts`
Expected: FAIL because the Runner, adapter and process port are absent.

- [ ] **Step 3: Implement bounded Codex execution**

Create a unique `runs/<run-id>/`; write `request.json`, `context-manifest.json`, `context.md`, `stdout.log`, `stderr.log`, and `result.json`. Add `runDirectory` to `RunResult` so callers can locate those files. Render the context with `<runner-constraints>`, `<skill path=...>`, `<user-task>` and `<artifact path=...>` blocks. In dry-run return a successful `RunResult` without calling `ProcessRunner`. For execute mode, resolve `AIW_CODEX_BIN` or `codex` and call `codex exec --cd <projectRoot> --sandbox workspace-write --ask-for-approval never --output-last-message <runDirectory>/last-message.md -`, piping `context.md` to stdin. Map start failure to `unavailable`, signal cancellation to `cancelled`, non-zero exit to `failed`, and exit code `0` plus validated declared artifacts to `succeeded`.

- [ ] **Step 4: Run adapter and runner checks**

Run: `pnpm vitest run tests/adapters/codex-adapter.test.ts tests/services/task-runner.test.ts tests/cli/task-run-command.test.ts && pnpm lint && pnpm typecheck`
Expected: all commands exit `0`.

- [ ] **Step 5: Commit execution support**

```bash
git add src/domain/run.ts src/ports/process-runner.ts src/adapters/codex-adapter.ts src/services/task-runner.ts src/cli/task-run-command.ts tests/adapters/codex-adapter.test.ts tests/services/task-runner.test.ts tests/cli/task-run-command.test.ts
git commit -m "feat: run task nodes through Codex adapter"
```

### Task 7: Add end-to-end coverage and publish the developer workflow

**Files:**
- Create: `tests/e2e/mvp-workflow.test.ts`, `tests/fakes/fake-git-client.ts`, `tests/fakes/fake-network-client.ts`, `tests/fakes/fake-process-runner.ts`, `tests/helpers/complete-node.ts`
- Modify: `README.md`, `docs/specs/mvp-requirements.md`

**Interfaces:**
- Consumes all public CLI commands from Tasks 1–6.
- Produces a deterministic fake-backed happy-path test and regression tests for AC-1 through AC-9.

- [ ] **Step 1: Write the failing complete workflow test**

```ts
it('installs a skill, snapshots requirements, approves analysis, and dry-runs design', async () => {
  await runCli(['skills', 'install', fixtureRepoUrl]);
  await runCli(['task', 'init', 'refund-123', '--project', projectRoot, '--source', requirementsPath]);
  await completeNode(taskStore, 'refund-123', 'analysis');
  await runCli(['approve', 'refund-123', 'analysis']);
  const result = await runCli(['task', 'run', 'refund-123', 'design', '--dry-run', '--skill', 'architecture-design', '--json']);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: 'succeeded' });
});
```

- [ ] **Step 2: Run the end-to-end test to verify failure**

Run: `pnpm vitest run tests/e2e/mvp-workflow.test.ts`
Expected: FAIL until every public command and fake port is wired.

- [ ] **Step 3: Wire composition roots and document the supported workflow**

Implement `completeNode(store, taskId, nodeId)` in `tests/helpers/complete-node.ts` by loading the task, applying the Task 2 `succeed` transition with declared fixture outputs, and saving it. Instantiate production ports only in `src/cli.ts`; inject fakes in tests. Update README with prerequisites, `pnpm install`, `pnpm build`, `pnpm test`, a local-file task example, and an explicit note that authenticated source connectors are outside MVP. Mark each AC-1 through AC-9 with its test filename in `docs/specs/mvp-requirements.md`.

- [ ] **Step 4: Run the full verification suite**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
Expected: all commands exit `0`; the e2e test performs no real network, Git or Codex process call.

- [ ] **Step 5: Commit the verified MVP**

```bash
git add README.md docs/specs/mvp-requirements.md tests/e2e tests/fakes src
git commit -m "test: cover aiw MVP workflow"
```

## Plan Self-Review

- **Spec coverage:** FR-1 is Task 1; FR-2 is Task 4; FR-3 is Task 3; FR-4 is Tasks 2 and 5; FR-5 is Task 5; FR-6 is Task 6; AC-1 through AC-9 are mapped in Task 7.
- **Placeholder scan:** No task relies on undeclared files, vague test instructions, or deferred error handling.
- **Type consistency:** Task 2 provides `Task`, `NodeEvent` and state functions; Task 3 uses `Task`; Task 5 creates `ContextManifest`; Task 6 consumes the manifest in `RunRequest` and returns `RunResult`.
