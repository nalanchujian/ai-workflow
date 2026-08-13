# AI Workflow

`aiw`（AI Workflow）是一个面向开发团队、Git 原生的 AI 研发变更治理 CLI。它将需求来源、阶段产物、决策记录和运行证据固化为可追溯事实；仅在这些事实有效的前提下，复用团队技能并交由 Codex CLI 执行。

## 项目定位

AI Workflow 不替代 Codex，也不创建新的聊天系统。它负责四件事：

- 通过 Git 共享、审阅和版本化团队技能；
- 将复杂需求拆为固定七阶段及其可扩展子任务；
- MVP 在需求澄清、实施计划和最终测试等关键阶段引入人工确认；后续支持由版本化策略自动完成门禁，同时保留全过程证据；
- 只为当前阶段向 Codex 传递最小、已确认的上下文。

`aiw` 不需要云端服务：团队通过 Git 共享业务仓库中的任务事实与独立技能仓库；技能缓存、原始运行日志和临时文件保留在开发者本机。

## 与 Superpowers、Trellis 的关系

`aiw` 不重新实现通用编码 Agent 或通用研发方法，而是明确分层：

- **Superpowers**：通用研发方法论来源。标准团队技能包受控内置实际引用的方法正文，并记录上游版本、commit、许可证与内容哈希；最终用户无需安装或配置它，`aiw` 只叠加任务输入、产物、审批与失效约束。
- **aiw**：Git 原生的 AI 研发变更治理层。它管理来源快照、任务依赖、产物 revision、决策门禁、最小可信上下文与下游失效；MVP 使用人工审批，后续可接入策略自动门禁。
- **Codex CLI**：实际执行者，负责分析仓库、修改代码和运行验证。
- **Trellis**：面向 Coding Agent 的完整研发执行框架，提供任务、Spec、Skill、Hook 与子 Agent 工作方式；它是能力对标对象。在不要求版本化事实、审批门禁与失效传播的场景，可作为低治理要求的降级选项；但不是 `aiw` 的同级替代方案或当前 MVP 的运行时依赖。

当前 MVP 选择 Superpowers 作为方法论来源，不同时引入 Trellis。这样业务仓库中只有 `.aiw/` 一套任务事实，避免两套任务状态、上下文和工作流规则互相冲突。

## MVP 边界

MVP 聚焦“本机单 Agent + Git 共享任务事实与团队技能仓库”。它不会：

- 构建云端调度、账号体系或多 Agent 协作平台；
- 实现策略自动门禁或取消当前人工审批；
- 自动选择技能，或执行技能包携带的任意脚本；
- 保存完整聊天记录，或在未授权时读取需要登录的在线文档。

## 目标工作流

```bash
npm install -g @nalanchujian/ai-workflow
aiw init
aiw skills install https://github.com/nalanchujian/ai-workflow-skills.git --ref v2.0.0
aiw skills profiles list
aiw task init --project . --source https://example.com/requirements --skill-profile standard-web-feature@2.0.0
# 输出 taskId，例如 task-20260813-120000-000；将其填入下方命令
git add .aiw && git commit -m "chore(aiw): initialize task"
aiw task run <task-id> clarify
git add .aiw && git commit -m "chore(aiw): clarify task"
aiw task approve <task-id> clarify --actor tech-lead
git add .aiw && git commit -m "chore(aiw): approve clarification"
aiw task run <task-id> solution
aiw task run <task-id> plan
git add .aiw && git commit -m "chore(aiw): plan task"
aiw task approve <task-id> plan --actor tech-lead
git add .aiw && git commit -m "chore(aiw): approve plan"
aiw task run <task-id> implement
aiw task run <task-id> verify
aiw task run <task-id> test
git add .aiw && git commit -m "chore(aiw): test task"
aiw task approve <task-id> test --actor tech-lead
git add .aiw && git commit -m "chore(aiw): approve test"
```

这是 MVP 流程：经允许共享的需求资料固化为业务仓库中的来源快照，任务创建时一次选择并锁定团队工作流模板，再经人工确认逐步产出需求澄清、技术方案、实施计划、实现说明、工程验证与测试证据。每个阶段产物、待审批状态和审批记录均需通过 Git 固化后，才可作为下游依据；审批人要求修改时使用 `task request-changes`，它保留退回证据和下一版修改说明。仅在例外情况才使用 `task skill rebind` 替换单个节点的方法。工作流在测试验证获批后结束，不管理 PR、发布或线上运维。后续自动模式只替换人工门禁的决定方式，不省略过程产物、策略版本或运行证据。

上例使用公开的 `ai-workflow-skills` 标准模板来源。团队应 Fork 该仓库后再定义自己的技能、版本和治理规则；已有任务始终使用创建时锁定的来源版本。

## 当前状态

**MVP 核心链路已可运行。** `aiw` 已组合技能安装、任务初始化、来源刷新、阶段审批与修订、`task run` 和 Codex Adapter；顶层 CLI 在开发者本机创建实际 Git、网络、Lark MCP 和 Codex 适配器，测试通过确定性替身覆盖完整七阶段主流程。

真实使用前仍需准备 Git、兼容的 Node.js、已授权的 Lark MCP（如使用 Lark 来源）以及本机 Codex CLI；这些外部依赖不会由测试自动调用。可先运行 `aiw doctor --project .` 检查 Git、Codex、已安装的内置方法与 Lark MCP 配置；需要验证 Lark 文档授权时，显式传入 `--lark-url <docx-url>`。

## 本地运行

```bash
pnpm install --frozen-lockfile
pnpm exec tsx src/cli.ts --help
pnpm exec tsx src/cli.ts doctor --project .
pnpm exec tsx src/cli.ts run prune --older-than 30d
pnpm exec tsx src/cli.ts skills install <git-url>
```

### 安装为 `aiw` 命令

推荐从 npm 公共 Registry 安装：

```bash
npm install -g @nalanchujian/ai-workflow
aiw --help
aiw init
aiw doctor --project /你的业务仓库
```

升级和卸载：

```bash
npm update -g @nalanchujian/ai-workflow
npm uninstall -g @nalanchujian/ai-workflow
```

`aiw init` 只生成不含凭据、且不会覆盖的 `~/.aiw/config.yaml` 模板。标准团队技能包已经提供 Superpowers 方法，不要求用户了解或配置其本机目录；只有使用 Lark 文档来源时才需要按模板补充 Lark MCP 映射。

升级时应删除旧配置中的 `methodSources`；当前版本仅支持团队技能包提供的 `bundled:*` 方法，旧任务需使用新版技能包重新创建。

从安装到完成首个任务的完整操作，见 [用户使用手册](https://github.com/nalanchujian/ai-workflow/blob/codex/agent-skill-orchestrator/docs/07-%E5%8F%91%E5%B8%83%E8%BF%90%E8%90%A5/%E7%94%A8%E6%88%B7%E4%BD%BF%E7%94%A8%E6%89%8B%E5%86%8C.md)。

### 开发环境的全局链接

本地开发才使用 pnpm 全局链接。`package.json` 已将 `aiw` 映射到构建产物 `dist/cli.js`。首次使用前执行一次 `pnpm setup`，重开终端后确认 `PNPM_HOME` 已在 `PATH` 中；这是 pnpm 用于放置全局命令的目录。

```bash
pnpm setup                     # 仅首次执行；重开终端后继续
cd /Users/j/ai-workflow
pnpm run link:global           # 构建并链接当前仓库
aiw --help
aiw init
aiw doctor --project /Users/j/ai-workflow
```

源码更新后再次运行 `pnpm run link:global` 即可刷新构建产物。取消本机链接时执行：

```bash
cd /Users/j/ai-workflow
pnpm run unlink:global
```

若不希望全局安装，可始终使用 `pnpm dev -- <command>`，例如 `pnpm dev -- doctor`。

标准团队技能包把所需的 Superpowers 方法随版本安装并锁定；不需要额外的本机方法来源配置。如需读取 Lark 文档，再在 `aiw init` 生成的文件中配置 `connectors.lark`；完整字段见 [Lark来源连接器规范](docs/03-方案设计/03-接入与接口/Lark来源连接器规范.md)。可通过 `AIW_HOME` 覆盖默认的 `~/.aiw` 本机目录，便于隔离测试或多套配置。

## 文档

### 01 立项与规划

- [立项申请](docs/01-立项与规划/立项申请.md)：说明为何立项、MVP 范围、投入风险、试点指标与阶段决策。
- [发展规划](docs/01-立项与规划/发展规划.md)：定义从 MVP 到团队级、组织级能力的演进方向与进入条件。
- [方案调研](docs/01-立项与规划/方案调研.md)：比较直接使用 Codex、Superpowers、Trellis 三条路径，明确 aiw 的治理定位。

### 02 需求定义

- [MVP需求与验收规范](docs/02-需求定义/MVP需求与验收规范.md)：功能范围、错误行为与自动化验收场景。
- [需求来源与关键决策记录](docs/02-需求定义/需求来源与关键决策记录.md)：记录 MVP 范围的来源、已确认取舍、待验证假设与变更规则。

### 03 方案设计

#### 总体设计

- [产品设计](docs/03-方案设计/01-总体设计/产品设计.md)：定义用户角色、核心流程、任务产物与团队协作方式。
- [架构设计](docs/03-方案设计/01-总体设计/架构设计.md)：定义系统分层、任务模型、审批机制、上下文与安全边界。

#### 核心规范

- [研发工作流阶段规范](docs/03-方案设计/02-核心规范/研发工作流阶段规范.md)：固定七阶段、产物、审批、方法论引用与失效规则。
- [任务模型规范](docs/03-方案设计/02-核心规范/任务模型规范.md)：Git 共享的节点状态、审批、依赖和失效传播。
- [上下文包规范](docs/03-方案设计/02-核心规范/上下文包规范.md)：共享任务产物、来源快照、注入规则和本机运行数据边界。
- [技能包规范](docs/03-方案设计/02-核心规范/技能包规范.md)：团队技能的目录、元数据、版本锁定和安全边界。
- [安全规范](docs/03-方案设计/02-核心规范/安全规范.md)：来源接入、技能供应链、提示词隔离与 Codex 进程边界。

#### 接入与接口

- [Lark来源连接器规范](docs/03-方案设计/03-接入与接口/Lark来源连接器规范.md)：通过已配置 MCP 获取、快照和刷新 Lark 需求资料。
- [Codex适配器规范](docs/03-方案设计/03-接入与接口/Codex适配器规范.md)：运行请求、结果、失败处理和适配边界。
- [CLI 命令参考](docs/03-方案设计/03-接入与接口/CLI命令参考.md)：MVP 命令、参数、输出和状态影响。

### 04 实施规划

- [MVP版本实施计划](docs/04-实施规划/MVP版本实施计划.md)：按测试驱动分解的框架与功能实现步骤。

### 05 开发实现

- [开发指南](docs/05-开发实现/开发指南.md)：本地环境、开发命令、代码边界、测试和提交约定。

### 06 测试验证

- [MVP验收记录](docs/06-测试验证/验收记录.md)：AC-1 至 AC-25 的自动化测试证据与执行命令。

### 07 发布运营

- [用户使用手册](docs/07-发布运营/用户使用手册.md)：安装、个人配置、任务创建、七阶段推进、变更处理和常见问题。
- [公开 npm 发布实施计划](docs/04-实施规划/公开npm发布实施计划.md)：发布准备与人工发布顺序。

## 计划中的目录

```text
src/        # aiw CLI、任务编排和 Codex 适配器
skills/     # 示例声明式技能
docs/       # 设计与实施文档
tests/      # 单元和端到端测试
```
