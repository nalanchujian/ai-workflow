# AI Workflow

`aiw`（AI Workflow）是一个面向开发团队、Git 原生的 AI 研发变更治理 CLI。它将需求来源、阶段产物、决策记录和运行证据固化为可追溯事实；仅在这些事实有效的前提下，复用团队技能并交由 Codex CLI 执行。

## 项目定位

AI Workflow 不替代 Codex，也不创建新的聊天系统。MVP 的唯一目标链路是：

```text
来源快照
  → 事实/疑问拆分
  → 决策关卡
  → 业务单元图
  → 单元交付（代码 + 验证 + 测试 + 验收）
  → 汇总交付状态
```

围绕这条链路，它负责：

- 通过 Git 共享、审阅和版本化团队技能；
- 将不确定的需求事实与待决业务结论分开，不把猜测包装为方案；
- 将复杂需求拆为可独立交付、验证和验收的业务单元；
- MVP 在需求澄清、实施计划和每个交付单元引入人工确认；后续支持由版本化策略自动完成门禁，同时保留全过程证据；
- 只为当前阶段向 Codex 传递最小、已确认的上下文，并在超预算时要求进一步拆分而不静默丢失事实。

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
- 在任务执行中自动切换技能，或执行技能包携带的任意脚本；
- 保存完整聊天记录，或在未授权时读取需要登录的在线文档。

## 目标工作流

```bash
npm install -g @nalanchujian/ai-workflow
aiw init
aiw task init --project . --source https://example.com/requirements
# 输出 taskId，例如 task-20260813-120000-000；将其填入下方命令
git add .aiw && git commit -m "chore(aiw): initialize task"
aiw task run <task-id> clarify
git add .aiw && git commit -m "chore(aiw): clarify task"
aiw task review <task-id>
git add .aiw && git commit -m "chore(aiw): review clarification"
aiw task run <task-id> solution
git add .aiw && git commit -m "chore(aiw): record solution result"
aiw task run <task-id> plan
git add .aiw && git commit -m "chore(aiw): record plan result"
aiw task approve <task-id> plan --actor tech-lead
git add .aiw && git commit -m "chore(aiw): approve plan"
aiw task status <task-id> # 按输出执行 delivery-<业务单元> 节点
```

若不在业务仓库目录中执行，所有后续任务命令均可附加 `--project /业务仓库路径`；共享任务事实不保存发起人电脑的绝对路径。

这是 MVP 流程：`aiw init` 自动安装并设置 `standard-web-feature@11.0.0` 为本机默认工作流，任务创建时锁定该模板及其具体技能。需求澄清会生成可审阅的验收标准和机器可读验收清单，并将不能直接确认的问题沉淀为带 AI 推荐和业务化问题详情的决策登记；`task review` 逐项记录唯一的人工结论：本期继续或等待外部条件。计划必须逐项说明每个验收项由哪个交付单元完成，或因已记录的外部等待而被阻塞；任何遗漏都会阻止计划批准。需求范围改变只能更新来源并执行 `task source refresh`，再重新澄清、规划；不得在计划或验收中用“拆期”替代来源变更。计划获批后，AIW 依据机器可读工作单元生成 `delivery-<unit-id>` 节点。每个交付单元在同一次运行中完成代码、工程验证、测试和所属 AC 的验收；Codex 只声明测试计划和验收判断，AIW 在其结束后作为唯一测试执行者运行已批准命令，并保存命令、退出码、原始输出哈希和运行证据。AC 只有引用这些实际通过的测试记录，才能标记为通过；不再有汇总全部单元的全局 `verify`、`test` 节点。每个阶段产物、决策、待审批状态和审批记录均需通过 Git 固化后，才可作为下游依据。任一非 intake 节点都可再次 `task run` 生成新 revision；旧产物与审批事实保留。交付单元存在未通过或阻塞 AC 时必须修复重跑，或使用 `task close-with-risk <task-id> <delivery-node-id>` 明确记录风险接受；风险接受只影响该单元的交付状态，不会改写验收结论。工作流在全部当前交付单元闭环后结束，不管理 PR、发布或线上运维。

上例使用公开的 `ai-workflow-skills` 标准模板来源。团队应 Fork 该仓库后再定义自己的技能、版本和治理规则；已有任务始终使用创建时锁定的来源版本。

## 当前状态

**当前已实现该链路的基础闭环。** `aiw` 已组合技能安装、任务初始化、来源快照、决策门禁、业务单元交付、单元验收、交付状态汇总、`task run` 和 Codex Adapter；顶层 CLI 在开发者本机创建实际 Git、网络、文档连接器（当前含 Lark MCP）和 Codex 适配器，测试通过确定性替身覆盖主干与单元交付流程。

MVP 的剩余目标是把“大需求可控”做完整：超大来源的章节/领域分片、快速修改/标准需求/复杂需求的自动建议，以及上下文超预算时的自动拆分建议。事实可信度、来源证据和“来源—事实—决策—AC—单元”影响图已在澄清与计划链路中落盘并校验；来源未分片时仍保守地重新澄清/规划。这些能力的目标、验收与实施状态分别以[需求与验收规范](docs/02-需求定义/MVP需求与验收规范.md)和[MVP版本实施计划](docs/04-实施规划/MVP版本实施计划.md)为准。

真实使用前仍需准备 Git、兼容的 Node.js、与需求来源匹配的文档连接器（如使用受控在线文档）以及本机 Codex CLI；这些外部依赖不会由测试自动调用。可先运行 `aiw doctor --project .` 检查 Git、Codex、已安装的内置方法与文档连接器配置；需要验证某份在线文档时，显式传入 `--source <文档地址>`。CLI 只接收通用来源地址，内部再按地址路由到对应连接器；当前内置连接器支持 Lark 文档。

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

`aiw init` 生成不含凭据的 `~/.aiw/config.yaml`，并安装配置中锁定的默认团队技能包。标准团队技能包已经提供 Superpowers 方法，不要求用户了解或配置其本机目录；如 Codex 中存在唯一兼容的文档 MCP，初始化会自动建立映射。团队升级默认技能时执行 `aiw skills update --ref <tag-or-commit>`；安装成功后会同步切换同名默认模板的新版本。本机 Registry 以 Git revision 保留同一来源的多个版本，未完成任务仍可按其锁定版本继续执行。当前 MVP 不会自动删除旧版本，也尚未提供技能缓存清理命令。

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

若不希望全局安装，可始终使用 `pnpm dev <command>`，例如 `pnpm dev doctor`。

标准团队技能包把所需的 Superpowers 方法随版本安装并锁定；不需要额外的本机方法来源配置。`aiw init` 会尝试发现 Codex 中唯一兼容的文档 MCP，并仅保存不含凭据的本机映射；当前内置实现支持 Lark。连接器的供应商字段仅供维护者排障，普通使用者直接向 `--source` 传入文档地址即可；详见 [Lark来源连接器规范](docs/03-方案设计/03-接入与接口/Lark来源连接器规范.md)。可通过 `AIW_HOME` 覆盖默认的 `~/.aiw` 本机目录，便于隔离测试或多套配置。

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

- [研发工作流阶段规范](docs/03-方案设计/02-核心规范/研发工作流阶段规范.md)：固定主干、交付单元、产物、审批、方法论引用与失效规则。
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

- [MVP验收记录](docs/06-测试验证/验收记录.md)：AC-1 至 AC-28 的自动化测试证据与执行命令。

### 07 发布运营

- [用户使用手册](docs/07-发布运营/用户使用手册.md)：安装、个人配置、任务创建、交付单元推进、变更处理和常见问题。
- [公开 npm 发布实施计划](docs/04-实施规划/公开npm发布实施计划.md)：发布准备与人工发布顺序。

## 计划中的目录

```text
src/        # aiw CLI、任务编排和 Codex 适配器
skills/     # 示例声明式技能
docs/       # 设计与实施文档
tests/      # 单元和端到端测试
```
