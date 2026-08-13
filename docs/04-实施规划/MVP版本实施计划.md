# AI Workflow MVP版本实施计划

> 历史实施记录：本文记录初始 MVP 的分步实现，代码片段中的 `configured:superpowers` 是当时的兼容契约，不是新用户流程。当前内置方法依赖以《[内置方法依赖设计](../00-研发记录/设计/2026-08-13-内置方法依赖设计.md)》和《[技能包规范](../03-方案设计/02-核心规范/技能包规范.md)》为准。

> **供智能体执行：** 必须逐任务执行，并使用复选框跟踪进度。每个任务必须先编写失败测试，再实现最小功能、运行验证并提交。

**目标：** 构建本地 `aiw` CLI MVP：支持复用 Superpowers 方法论的版本化技能、Git 共享的固定七阶段任务 DAG、人工审批的上下文包、通过已配置 Lark MCP 接入需求来源，以及通过 Codex Adapter 预演或执行任务节点。

**实施方式：** 按任务 1 至 7 顺序建立 CLI、领域模型、来源接入、技能、上下文、执行器与端到端验证；每个任务先以替身端口编写失败测试，再实现最小功能并提交。

**技术栈：** Node.js 22+、TypeScript 严格模式、pnpm、Commander、Zod、yaml、TOML 解析器、MCP TypeScript SDK、Vitest、ESLint、原生 `fetch`、Node `crypto`、`child_process`。

## 实施必须遵守的设计约束

本计划不重新定义任务、上下文、安全或外部接口规则；实现与测试必须以以下文档为权威来源。需求变更时，先更新相应规范，再调整本计划中的任务、文件和测试范围。

| 实施关注点 | 权威文档 |
|---|---|
| MVP 范围、行为与产品验收 | [MVP需求与验收规范](../02-需求定义/MVP需求与验收规范.md) |
| 固定阶段、产物、审批和方法论引用 | [研发工作流阶段规范](../03-方案设计/02-核心规范/研发工作流阶段规范.md) |
| 状态机、审批、依赖与失效 | [任务模型规范](../03-方案设计/02-核心规范/任务模型规范.md) |
| 任务目录、快照、Manifest 与注入 | [上下文包规范](../03-方案设计/02-核心规范/上下文包规范.md) |
| 技能格式、锁定与校验 | [技能包规范](../03-方案设计/02-核心规范/技能包规范.md) |
| 来源、凭据、提示词与进程安全边界 | [安全规范](../03-方案设计/02-核心规范/安全规范.md) |
| CLI、Lark MCP 与 Codex 的接口契约 | [CLI命令参考](../03-方案设计/03-接入与接口/CLI命令参考.md)、[Lark来源连接器规范](../03-方案设计/03-接入与接口/Lark来源连接器规范.md)、[Codex适配器规范](../03-方案设计/03-接入与接口/Codex适配器规范.md) |

## 计划中的文件结构

```text
package.json                         # 脚本、依赖和 aiw bin 入口
tsconfig.json                        # 严格 TypeScript 配置
eslint.config.js                     # TypeScript lint 规则
src/cli.ts                           # 可执行入口
src/cli/create-program.ts            # Commander 程序和命令注册
src/cli/output.ts                    # 人类可读与 --json 输出
src/domain/task.ts                   # 任务、节点和状态 schema
src/domain/skill.ts                  # 技能和 Registry schema
src/domain/workflow-profile.ts       # 工作流模板及六阶段映射 schema
src/domain/method-source.ts          # 上游方法论引用与锁定内容 schema
src/domain/context.ts                # Context Manifest schema
src/domain/run.ts                    # RunRequest 和 RunResult schema
src/ports/git-client.ts              # clone/fetch/revision 端口
src/ports/repository-status.ts       # 共享任务事实的 Git 提交状态端口
src/ports/network-client.ts          # DNS 和 HTTP 端口
src/ports/mcp-client.ts              # 已配置 MCP 工具调用端口
src/ports/mcp-server-config-resolver.ts # 本机 MCP Server 定义解析端口
src/ports/process-runner.ts          # 子进程端口
src/ports/method-source-resolver.ts  # 已配置方法论来源解析端口
src/services/task-store.ts           # task.yaml 和事件持久化
src/services/task-fact-guard.ts      # 共享产物、审批与 Git 提交状态校验
src/services/task-state-machine.ts   # 状态迁移和失效传播
src/services/source-intake.ts        # 本地、公开 URL 与连接器来源快照
src/services/lark-source-connector.ts # Lark URL 识别、MCP 调用与响应标准化
src/services/source-refresher.ts     # 创建来源 revision 与失效传播
src/services/task-initializer.ts     # 默认任务图创建
src/services/skill-registry.ts       # 用户级 Registry
src/services/skill-installer.ts      # Git 技能安装与校验
src/services/local-config.ts           # ~/.aiw/config.yaml 的非敏感 Profile 解析
src/services/method-source-resolver.ts # 上游方法论的本机解析、边界校验与哈希记录
src/services/context-builder.ts      # 上下文选择、manifest 和 context.md
src/services/task-runner.ts          # 节点运行生命周期
src/adapters/codex-adapter.ts        # Codex 调用与结果收集
src/adapters/stdio-mcp-client.ts     # stdio MCP 启动、工具调用与关闭
tests/                               # 与 src 对应的单元和集成测试
```

---

### 任务 1：初始化类型安全的 CLI 基础

**文件：**

- 新建：`package.json`、`pnpm-lock.yaml`、`tsconfig.json`、`eslint.config.js`、`.npmrc`
- 新建：`src/cli.ts`、`src/cli/create-program.ts`、`src/cli/output.ts`
- 新建：`tests/cli/help.test.ts`、`tests/cli/output.test.ts`、`tests/helpers/run-cli.ts`
- 修改：`README.md`

**接口：**

- 提供 `createProgram(deps: CliDependencies): Command`。
- 提供 `writeResult(value: unknown, options: { json: boolean; stdout: NodeJS.WriteStream }): void`。

- [x] **步骤 1：编写失败的 CLI 测试**

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

- [x] **步骤 2：确认测试在实现前失败**

运行：`pnpm vitest run tests/cli/help.test.ts tests/cli/output.test.ts`
预期：因脚本和 `runCli` 尚不存在而失败。

- [x] **步骤 3：实现最小 CLI 程序**

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

在 `package.json` 定义 `build`、`test`、`lint`、`typecheck` 和 `dev` 脚本。`src/cli.ts` 调用 `createProgram`，捕获异常后写入 stderr 并以状态码 `1` 退出。`tests/helpers/run-cli.ts` 使用伪依赖创建程序、捕获 stdout/stderr/退出码。

- [x] **步骤 4：运行基础验证**

运行：`pnpm lint && pnpm typecheck && pnpm test`
预期：全部命令以 `0` 退出。

- [x] **步骤 5：提交 CLI 基础**

```bash
git add package.json pnpm-lock.yaml tsconfig.json eslint.config.js .npmrc src/cli.ts src/cli tests/cli tests/helpers README.md
git commit -m "feat: initialize aiw CLI foundation"
```

### 任务 2：实现任务领域模型和状态机

**文件：**

- 新建：`src/domain/task.ts`、`src/services/task-state-machine.ts`
- 新建：`tests/domain/task.test.ts`、`tests/services/task-state-machine.test.ts`

**接口：**

- 提供 `TaskSchema`、`TaskNodeSchema`、`TaskStatus`、`NodeStatus` 和 `Task`。
- 提供 `transitionNode(task: Task, nodeId: string, event: NodeEvent): Task`。
- 提供 `invalidateDependents(task: Task, upstreamNodeId: string, reason: string): Task`。

- [x] **步骤 1：编写状态迁移失败测试**

```ts
it('only makes a node ready after every dependency completes', () => {
  const task = taskWith({ clarify: 'completed', solution: 'pending' });
  expect(transitionNode(task, 'solution', { type: 'evaluate' }).nodes.solution.status).toBe('ready');
});

it('invalidates every started downstream stage when clarify is revised', () => {
  const next = invalidateDependents(completedPipelineTask(), 'clarify', 'requirements changed');
  expect(next.nodes.solution.status).toBe('invalidated');
  expect(next.nodes.test.status).toBe('invalidated');
});

it('rebinds an initialized profile skill only by an explicit exception event and records an approval change request separately', async () => {
  const rebound = transitionNode(readyClarifyTask(), 'clarify', { type: 'rebind_skill', skill: replacementClarificationSkill(), note: '需要补充合规检查' });
  expect(rebound.nodes.clarify.skill?.sha256).toMatch(/^[a-f0-9]{64}$/);
  const changed = transitionNode(awaitingPlanTask(), 'plan', { type: 'request_changes', actor: 'tech-lead', note: '补充回滚方案' });
  expect(changed.nodes.plan.status).toBe('ready');
});
```

- [x] **步骤 2：运行测试并确认失败**

运行：`pnpm vitest run tests/domain/task.test.ts tests/services/task-state-machine.test.ts`
预期：因 schema 和状态机尚不存在而失败。

- [x] **步骤 3：实现不可变 schema 和合法迁移**

```ts
export type NodeEvent =
  | { type: 'evaluate' }
  | { type: 'rebind_skill'; skill: SkillLock; note: string }
  | { type: 'start'; runId: string }
  | { type: 'succeed'; outputs: OutputRecord[] }
  | { type: 'approve'; actor: string; note?: string }
  | { type: 'request_changes'; actor: string; note: string }
  | { type: 'revise'; actor: string; note: string }
  | { type: 'fail'; message: string };

export interface OutputRecord {
  path: string;
  sha256: string;
}

export function transitionNode(task: Task, nodeId: string, event: NodeEvent): Task;
```

对未知节点和非法事件抛出 `TaskTransitionError`。审批事件与 `NodeStatus` 分离；解析或创建任务时执行 DFS 环检测。

- [x] **步骤 4：验证状态模型**

运行：`pnpm vitest run tests/domain/task.test.ts tests/services/task-state-machine.test.ts && pnpm lint && pnpm typecheck`
预期：全部通过。

- [x] **步骤 5：提交状态机**

```bash
git add src/domain/task.ts src/services/task-state-machine.ts tests/domain/task.test.ts tests/services/task-state-machine.test.ts
git commit -m "feat: add task DAG state machine"
```

### 任务 3：持久化任务事实、来源快照与 Lark 刷新

**文件：**

- 新建：`src/ports/network-client.ts`、`src/ports/mcp-client.ts`、`src/ports/mcp-server-config-resolver.ts`、`src/adapters/stdio-mcp-client.ts`、`src/services/task-store.ts`、`src/services/source-intake.ts`、`src/services/lark-source-connector.ts`、`src/services/source-refresher.ts`
- 新建：`src/cli/task-source-refresh-command.ts`
- 新建：`tests/adapters/stdio-mcp-client.test.ts`、`tests/services/task-store.test.ts`、`tests/services/source-intake.test.ts`、`tests/services/lark-source-connector.test.ts`、`tests/services/source-refresher.test.ts`、`tests/cli/task-source-refresh-command.test.ts`

**接口：**

- 提供 `TaskStore.create(task: Task): Promise<void>`、`TaskStore.load(id: string): Promise<Task>`、`TaskStore.update(task: Task): Promise<void>`。
- 提供 `SourceIntake.snapshot(input: SourceInput): Promise<SnapshotRecord>`。
- 提供 `McpServerConfigResolver.resolve(input): Promise<McpServerDescriptor>` 与 `McpClient.callTool(input): Promise<unknown>`。
- 提供 `LarkSourceConnector.fetch(url: string): Promise<ConnectorSource>`，使用可注入的 MCP 配置解析器与客户端。
- 提供 `SourceRefresher.refresh(input: { taskId: string; sourceId: string }): Promise<RefreshResult>`。

- [x] **步骤 1：编写任务事实、来源和 URL 安全失败测试**

```ts
it('stores a task fact and hashes a local Markdown snapshot', async () => {
  const snapshot = await intake.snapshot({ kind: 'local-file', value: fixture('requirements.md') });
  await store.create(taskWithSnapshot(snapshot));
  expect(snapshot.markdown).toContain('# Refund');
  expect(snapshot.sha256).toMatch(/^[a-f0-9]{64}$/);
});

it('rejects a URL that resolves to a loopback address before fetch', async () => {
  await expect(intake.snapshot({ kind: 'url', value: 'http://example.test/doc' }))
    .rejects.toMatchObject({ code: 'UNSAFE_URL' });
  expect(fakeNetwork.fetch).not.toHaveBeenCalled();
});

it('creates a new revision and invalidates downstream nodes when Lark content changes', async () => {
  const result = await refresher.refresh({ taskId: 'refund-123', sourceId: 'requirements' });
  expect(result.changed).toBe(true);
  expect(result.revision).toBe(2);
  expect(result.task.nodes.clarify.status).toBe('invalidated');
});
```

- [x] **步骤 2：运行测试并确认失败**

运行：`pnpm vitest run tests/adapters/stdio-mcp-client.test.ts tests/services/task-store.test.ts tests/services/source-intake.test.ts tests/services/lark-source-connector.test.ts tests/services/source-refresher.test.ts tests/cli/task-source-refresh-command.test.ts`
预期：因存储和接入服务尚不存在而失败。

- [x] **步骤 3：实现原子存储与安全接入**

按[上下文包规范](../03-方案设计/02-核心规范/上下文包规范.md)、[任务模型规范](../03-方案设计/02-核心规范/任务模型规范.md)、[安全规范](../03-方案设计/02-核心规范/安全规范.md)和[Lark来源连接器规范](../03-方案设计/03-接入与接口/Lark来源连接器规范.md)实现 `TaskStore`、`SourceIntake`、`LarkSourceConnector` 与 `SourceRefresher`。先完成原子持久化与本地来源，再接入公开 URL，最后接入 Lark MCP 与来源刷新；任务初始化在下一任务获得工作流模板 Registry 后实现。每一步只通过可注入端口访问文件、网络、Git 和 MCP。

- [x] **步骤 4：验证任务事实与来源接入**

运行：`pnpm vitest run tests/adapters/stdio-mcp-client.test.ts tests/services/task-store.test.ts tests/services/source-intake.test.ts tests/services/lark-source-connector.test.ts tests/services/source-refresher.test.ts tests/cli/task-source-refresh-command.test.ts && pnpm lint && pnpm typecheck`
预期：全部通过。

- [x] **步骤 5：提交来源接入**

```bash
git add src/ports/network-client.ts src/ports/mcp-client.ts src/ports/mcp-server-config-resolver.ts src/adapters/stdio-mcp-client.ts src/services/task-store.ts src/services/source-intake.ts src/services/lark-source-connector.ts src/services/source-refresher.ts src/cli/task-source-refresh-command.ts tests/adapters/stdio-mcp-client.test.ts tests/services/task-store.test.ts tests/services/source-intake.test.ts tests/services/lark-source-connector.test.ts tests/services/source-refresher.test.ts tests/cli/task-source-refresh-command.test.ts
git commit -m "feat: add task source intake and refresh"
```

### 任务 4：添加工作流模板、技能安装与任务初始化

**文件：**

- 新建：`src/domain/skill.ts`、`src/domain/workflow-profile.ts`、`src/domain/method-source.ts`、`src/ports/git-client.ts`、`src/ports/method-source-resolver.ts`、`src/services/local-config.ts`、`src/services/method-source-resolver.ts`、`src/services/skill-registry.ts`、`src/services/skill-installer.ts`、`src/services/task-initializer.ts`
- 新建：`src/cli/skills-commands.ts`、`src/cli/task-init-command.ts`
- 新建：`tests/services/skill-installer.test.ts`、`tests/services/local-config.test.ts`、`tests/services/method-source-resolver.test.ts`、`tests/services/skill-registry.test.ts`、`tests/services/task-initializer.test.ts`、`tests/cli/skills-commands.test.ts`、`tests/cli/task-init-command.test.ts`

**接口：**

- 提供 `SkillSchema`、`InstalledSkillSchema`、`WorkflowProfileSchema`、`InstalledWorkflowProfileSchema` 和 `SkillRegistry`。
- 提供 `MethodSourceSchema`、`ResolvedMethodSourceSchema` 和 `MethodSourceResolver.resolve(input)`。
- 提供 `SkillInstaller.install(input: { url: string; ref?: string }): Promise<InstallResult>`，其中包含已安装技能与工作流模板。
- 提供 `SkillRegistry.list(): Promise<InstalledSkill[]>`、`listProfiles(): Promise<InstalledWorkflowProfile[]>`、`find(name: string, version?: string): Promise<InstalledSkill>` 与 `findProfile(name: string, version?: string): Promise<InstalledWorkflowProfile>`。
- 提供 `TaskInitializer.init(input: { projectRoot: string; source: string; skillProfile: string }): Promise<Task>`；任务 ID 由初始化器自动生成。

- [x] **步骤 1：编写技能安装失败测试**

```ts
it('records valid skills, a workflow profile, locked Git revisions, and resolved Superpowers methods', async () => {
  fakeGit.cloneResult = { revision: 'abc123', directory: fixture('valid-skill-repo') };
  const installed = await installer.install({ url: 'https://example.test/skills.git' });
  expect(installed.skills[0]).toMatchObject({ name: 'requirements-clarification', version: '1.0.0', revision: 'abc123' });
  expect(installed.skills[0].methodSources[0]).toMatchObject({ id: 'superpowers:brainstorming', source: 'configured:superpowers', version: '6.2.0', revision: '6.2.0', sha256: expect.any(String) });
  expect((await registry.listProfiles())[0]).toMatchObject({ name: 'standard-web-feature', version: '1.0.0' });
});

it('initializes a task only when the profile resolves and locks every executable stage', async () => {
  const task = await initializer.init({ projectRoot, source: requirementsPath, skillProfile: 'standard-web-feature@1.0.0' });
  expect(task.skillProfile.name).toBe('standard-web-feature');
  expect(task.nodes.clarify.skill?.name).toBe('requirements-clarification');
  expect(task.nodes.test.skill?.name).toBe('acceptance-testing');
});

it('does not mutate the registry when a method source is not configured', async () => {
  fakeGit.cloneResult = { revision: 'abc123', directory: fixture('invalid-skill-repo') };
  await expect(installer.install({ url: 'https://example.test/skills.git' })).rejects.toThrow('Method source is unavailable');
  await expect(registry.list()).resolves.toEqual([]);
});
```

- [x] **步骤 2：运行测试并确认失败**

运行：`pnpm vitest run tests/services/local-config.test.ts tests/services/method-source-resolver.test.ts tests/services/skill-installer.test.ts tests/services/skill-registry.test.ts tests/services/task-initializer.test.ts tests/cli/skills-commands.test.ts tests/cli/task-init-command.test.ts`
预期：因 Registry 和安装器尚不存在而失败。

- [x] **步骤 3：实现 Registry 和技能校验**

按[技能包规范](../03-方案设计/02-核心规范/技能包规范.md)实现 `GitClient`、`LocalConfig`、`MethodSourceResolver`、`SkillRegistry`、`SkillInstaller` 与 `TaskInitializer`；实现顺序为 Git 来源锁定、`SKILL.md`/`PROFILE.yaml` 解析与校验、显式本机 Profile 解析、上游方法论入口的 `realpath`/版本/revision/哈希校验、Registry 原子写入、工作流模板解析并锁定六阶段技能、`task init` 与模板列表命令接入。必须覆盖模板缺失、阶段映射不完整、引用技能不兼容、方法 Profile 缺失、版本不匹配、入口越界和运行时哈希变化时拒绝；不得实现 Codex 缓存扫描、网络下载或“最接近版本”回退。所有外部 Git 与文件操作均经可替换端口完成。

- [x] **步骤 4：验证技能功能**

运行：`pnpm vitest run tests/services/local-config.test.ts tests/services/method-source-resolver.test.ts tests/services/skill-installer.test.ts tests/services/skill-registry.test.ts tests/services/task-initializer.test.ts tests/cli/skills-commands.test.ts tests/cli/task-init-command.test.ts && pnpm lint && pnpm typecheck`
预期：全部通过。

- [x] **步骤 5：提交技能支持**

```bash
git add src/domain/skill.ts src/domain/workflow-profile.ts src/domain/method-source.ts src/ports/git-client.ts src/ports/method-source-resolver.ts src/services/local-config.ts src/services/method-source-resolver.ts src/services/skill-registry.ts src/services/skill-installer.ts src/services/task-initializer.ts src/cli/skills-commands.ts src/cli/task-init-command.ts tests/services/skill-installer.test.ts tests/services/local-config.test.ts tests/services/method-source-resolver.test.ts tests/services/skill-registry.test.ts tests/services/task-initializer.test.ts tests/cli/skills-commands.test.ts tests/cli/task-init-command.test.ts
git commit -m "feat: initialize tasks with locked workflow profiles"
```

### 任务 5：实现审批命令和 Context Manifest

**文件：**

- 新建：`src/domain/context.ts`、`src/services/context-builder.ts`、`src/services/task-fact-guard.ts`、`src/ports/repository-status.ts`、`src/cli/task-state-commands.ts`
- 新建：`tests/services/context-builder.test.ts`、`tests/services/task-fact-guard.test.ts`、`tests/cli/task-state-commands.test.ts`
- 修改：`src/services/task-store.ts`

**接口：**

- 使用 `TaskStore`、`transitionNode`、`SkillRegistry` 与节点已锁定技能。
- 提供 `ContextBuilder.build(input: { task: Task; nodeId: string; includes: string[] }): Promise<ContextManifest>`；它只从节点锁定读取技能。
- 提供 `TaskFactGuard.assertCommitted(input: { task: Task; paths: string[] }): Promise<void>`。
- 在 `src/domain/context.ts` 提供 schemaVersion 为 `aiw.context/v1` 的 `ContextManifestSchema`。

- [x] **步骤 1：编写审批、失效和预算失败测试**

```ts
it('approves the committed clarify revision and unlocks solution after its fact is committed', async () => {
  await git.commitTaskFacts('refund-123');
  await commands.approve('refund-123', 'clarify', { actor: 'tech-lead' });
  await git.commitTaskFacts('refund-123');
  expect((await store.load('refund-123')).nodes.solution.status).toBe('ready');
});

it('records requested changes with the reviewed hashes and a next-revision instruction', async () => {
  await git.commitTaskFacts('refund-123');
  await commands.requestChanges('refund-123', 'plan', { actor: 'tech-lead', note: '补充回滚方案' });
  expect(await readFile(taskPath('revisions/plan/r2.md'), 'utf8')).toContain('补充回滚方案');
  expect((await store.load('refund-123')).nodes.plan.status).toBe('ready');
});

it('rejects a downstream run when its approval fact is not committed', async () => {
  await expect(guard.assertCommitted(uncommittedPlanInput())).rejects.toMatchObject({ code: 'TASK_FACTS_UNCOMMITTED' });
});

it('builds a plan manifest with the locked writing-plans method', async () => {
  const manifest = await builder.build(planInput());
  expect(manifest.skill.methodSources).toContainEqual(expect.objectContaining({ id: 'superpowers:writing-plans', source: 'configured:superpowers', version: '6.2.0', revision: '6.2.0' }));
});

it('fails above the context budget without truncating any file', async () => {
  await expect(builder.build(overBudgetInput())).rejects.toMatchObject({ code: 'CONTEXT_BUDGET_EXCEEDED' });
  expect(await readFile(largeArtifact, 'utf8')).toBe(originalLargeArtifact);
});
```

- [x] **步骤 2：运行测试并确认失败**

运行：`pnpm vitest run tests/services/context-builder.test.ts tests/cli/task-state-commands.test.ts`
预期：因审批命令和 Context Builder 尚不存在而失败。

- [x] **步骤 3：实现 manifest 构建和任务状态命令**

按[任务模型规范](../03-方案设计/02-核心规范/任务模型规范.md)、[上下文包规范](../03-方案设计/02-核心规范/上下文包规范.md)和[CLI命令参考](../03-方案设计/03-接入与接口/CLI命令参考.md)实现单节点技能重新绑定、批准、要求修改、主动修订、状态查询、Git 事实校验与 Context Manifest。实施顺序为状态命令、任务模板/技能锁定提交校验、已提交事实校验、默认阶段上下文选择、修改说明注入、Manifest 生成及预算校验。

- [x] **步骤 4：验证审批和上下文功能**

运行：`pnpm vitest run tests/services/context-builder.test.ts tests/cli/task-state-commands.test.ts && pnpm lint && pnpm typecheck`
预期：全部通过。

- [x] **步骤 5：提交上下文逻辑**

```bash
git add src/domain/context.ts src/ports/repository-status.ts src/services/context-builder.ts src/services/task-fact-guard.ts src/services/task-store.ts src/cli/task-state-commands.ts tests/services/context-builder.test.ts tests/services/task-fact-guard.test.ts tests/cli/task-state-commands.test.ts
git commit -m "feat: add seven-phase approvals and context manifests"
```

### 任务 6：实现 Codex Adapter 和 Task Runner

**文件：**

- 新建：`src/domain/run.ts`、`src/ports/process-runner.ts`、`src/adapters/node-process-runner.ts`、`src/adapters/codex-adapter.ts`、`src/services/task-runner.ts`、`src/cli/task-run-command.ts`
- 新建：`tests/adapters/node-process-runner.test.ts`、`tests/adapters/codex-adapter.test.ts`、`tests/services/task-runner.test.ts`、`tests/cli/task-run-command.test.ts`

**接口：**

- 提供 `RunRequestSchema`、`RunResultSchema`、`CodexAdapter.run(request: RunRequest): Promise<RunResult>`。
- 提供 `TaskRunner.run(input: { taskId: string; nodeId: string; dryRun: boolean; includes: string[] }): Promise<RunResult>`。

- [x] **步骤 1：编写 dry-run 和进程结果失败测试**

```ts
it('writes a clarify dry-run manifest with the locked method without starting Codex', async () => {
  const result = await runner.run({ taskId: 'refund-123', nodeId: 'clarify', dryRun: true, includes: [] });
  expect(result.status).toBe('succeeded');
  expect(fakeProcess.calls).toHaveLength(0);
  expect(await readFile(join(result.localRunDirectory, 'context.md'), 'utf8')).toContain('<method-source id="superpowers:brainstorming"');
});

it('maps a missing executable to unavailable and marks the node failed', async () => {
  fakeProcess.throwOnStart = new ExecutableNotFoundError('codex');
  await expect(runner.run(executeInput())).resolves.toMatchObject({ status: 'unavailable' });
  expect((await store.load('refund-123')).nodes.clarify.status).toBe('failed');
});
```

- [x] **步骤 2：运行测试并确认失败**

运行：`pnpm vitest run tests/adapters/codex-adapter.test.ts tests/services/task-runner.test.ts tests/cli/task-run-command.test.ts`
预期：因 Runner、Adapter 和进程端口尚不存在而失败。

- [x] **步骤 3：实现受限的 Codex 执行**

按[Codex适配器规范](../03-方案设计/03-接入与接口/Codex适配器规范.md)、[上下文包规范](../03-方案设计/02-核心规范/上下文包规范.md)和[安全规范](../03-方案设计/02-核心规范/安全规范.md)实现 `ProcessRunner`、`CodexAdapter`、`TaskRunner` 与运行命令。实施顺序为运行请求/结果 schema、本机运行目录与上下文渲染、dry-run、执行结果映射、阶段产物校验与共享去敏结果写入。

- [x] **步骤 4：验证 Adapter 和 Runner**

运行：`pnpm vitest run tests/adapters/codex-adapter.test.ts tests/services/task-runner.test.ts tests/cli/task-run-command.test.ts && pnpm lint && pnpm typecheck`
预期：全部通过。

- [x] **步骤 5：提交执行支持**

```bash
git add src/domain/run.ts src/ports/process-runner.ts src/adapters/codex-adapter.ts src/services/task-runner.ts src/cli/task-run-command.ts tests/adapters/codex-adapter.test.ts tests/services/task-runner.test.ts tests/cli/task-run-command.test.ts
git commit -m "feat: run task nodes through Codex adapter"
```

### 任务 7：添加端到端覆盖并发布开发流程

**文件：**

- 新建：`tests/e2e/mvp-workflow.test.ts`、`tests/fakes/fake-git-client.ts`、`tests/fakes/fake-network-client.ts`、`tests/fakes/fake-process-runner.ts`、`tests/helpers/complete-node.ts`
- 修改：`README.md`

**接口：**

- 使用任务 1–6 提供的所有公开 CLI 命令。
- 产出基于确定性替身的完整主流程测试，以及 AC-1 至 AC-25 的回归测试。

- [x] **步骤 1：编写完整工作流失败测试**

```ts
it('initializes seven phases and dry-runs clarify with a committed locked Superpowers method', async () => {
  await runCli(['skills', 'install', fixtureRepoUrl]);
  const initialized = await runCli(['task', 'init', '--project', projectRoot, '--source', requirementsPath, '--skill-profile', 'standard-web-feature@1.0.0', '--json']);
  const taskId = JSON.parse(initialized.stdout).taskId;
  await fakeRepository.commitTaskFacts(taskId);
  const result = await runCli(['task', 'run', taskId, 'clarify', '--dry-run', '--json']);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: 'succeeded' });
  expect(JSON.parse(result.stdout).contextManifest.skill.methodSources[0]).toMatchObject({ id: 'superpowers:brainstorming', source: 'configured:superpowers', version: '6.2.0', revision: '6.2.0' });
});
```

- [x] **步骤 2：运行端到端测试并确认失败**

运行：`pnpm vitest run tests/e2e/mvp-workflow.test.ts`
预期：在所有公开命令和替身端口接通前失败。

- [x] **步骤 3：连接组合根并补充开发文档**

在 `src/cli.ts` 组合生产端口，测试仅注入替身；补全跨阶段测试辅助函数和 README 的本地开发说明。以[MVP需求与验收规范](../02-需求定义/MVP需求与验收规范.md)的 AC-1 至 AC-25 为唯一回归覆盖清单，在测试代码中维护 AC 与测试用例的映射，不在需求规范中回写实现文件名。

- [x] **步骤 4：运行完整验证套件**

运行：`pnpm lint && pnpm typecheck && pnpm test && pnpm build`
预期：全部以 `0` 退出；端到端测试遵守[安全规范](../03-方案设计/02-核心规范/安全规范.md)规定的外部依赖隔离边界。

- [x] **步骤 5：提交已验证的 MVP**

```bash
git add README.md docs/02-需求定义/MVP需求与验收规范.md tests/e2e tests/fakes src
git commit -m "test: cover aiw MVP workflow"
```

## 计划自检

- **需求覆盖：** FR-1 至 FR-6 分别由任务 1 至 6 覆盖；AC-1 至 AC-25 在任务 7 中映射到自动化测试。
- **执行完整性：** 各任务均定义文件、接口、失败测试、验证命令和提交范围；设计约束仅通过“实施必须遵守的设计约束”中的权威文档引用。
- **依赖顺序：** 任务 2 提供任务状态能力；任务 3 至 6 依次建立来源、技能、上下文和执行能力；任务 7 在全部公开命令可用后完成端到端验证。
