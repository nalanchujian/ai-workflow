# AI Workflow

`aiw`（AI Workflow）是一个面向开发团队、Git 原生的 AI 研发变更治理 CLI。它将需求来源、阶段产物、审批和运行证据固化为可追溯事实；仅在这些事实有效的前提下，复用团队技能并交由 Codex CLI 执行。

## 项目定位

AI Workflow 不替代 Codex，也不创建新的聊天系统。它负责四件事：

- 通过 Git 共享、审阅和版本化团队技能；
- 将复杂需求拆为固定七阶段及其可扩展子任务；
- 在需求澄清、实施计划和最终测试等关键阶段引入人工确认；
- 只为当前阶段向 Codex 传递最小、已确认的上下文。

`aiw` 不需要云端服务：团队通过 Git 共享业务仓库中的任务事实与独立技能仓库；技能缓存、原始运行日志和临时文件保留在开发者本机。

## 与 Superpowers、Trellis 的关系

`aiw` 不重新实现通用编码 Agent 或通用研发方法，而是明确分层：

- **Superpowers**：通用研发方法论来源。阶段技能按版本和哈希引用其中的方法（如需求澄清、写计划、测试驱动开发），`aiw` 只叠加任务输入、产物、审批与失效约束。
- **aiw**：Git 原生的 AI 研发变更治理层。它管理来源快照、任务依赖、产物 revision、人工审批、最小可信上下文与下游失效。
- **Codex CLI**：实际执行者，负责分析仓库、修改代码和运行验证。
- **Trellis**：面向 Coding Agent 的完整研发执行框架，提供任务、Spec、Skill、Hook 与子 Agent 工作方式；它是能力对标对象。在不要求版本化事实、审批门禁与失效传播的场景，可作为低治理要求的降级选项；但不是 `aiw` 的同级替代方案或当前 MVP 的运行时依赖。

当前 MVP 选择 Superpowers 作为方法论来源，不同时引入 Trellis。这样业务仓库中只有 `.aiw/` 一套任务事实，避免两套任务状态、上下文和工作流规则互相冲突。

## MVP 边界

MVP 聚焦“本机单 Agent + Git 共享任务事实与团队技能仓库”。它不会：

- 构建云端调度、账号体系或多 Agent 协作平台；
- 自动选择技能，或执行技能包携带的任意脚本；
- 保存完整聊天记录，或在未授权时读取需要登录的在线文档。

## 目标工作流

```bash
aiw skills install git@github.com:your-org/agent-skills.git
aiw skills list
aiw task init req-123 --project . --source https://example.com/requirements
git add .aiw && git commit -m "chore(aiw): initialize req-123"
aiw task run req-123 clarify --skill requirements-clarification
git add .aiw && git commit -m "chore(aiw): clarify req-123"
aiw task approve req-123 clarify --actor tech-lead
git add .aiw && git commit -m "chore(aiw): approve clarification"
aiw task run req-123 solution --skill technical-solution
aiw task run req-123 plan --skill implementation-planning
git add .aiw && git commit -m "chore(aiw): plan req-123"
aiw task approve req-123 plan --actor tech-lead
git add .aiw && git commit -m "chore(aiw): approve plan"
aiw task run req-123 implement --skill implementation
aiw task run req-123 verify --skill implementation-verification
aiw task run req-123 test --skill acceptance-testing
git add .aiw && git commit -m "chore(aiw): test req-123"
aiw task approve req-123 test --actor tech-lead
git add .aiw && git commit -m "chore(aiw): approve test"
```

这个流程将经允许共享的需求资料固化为业务仓库中的来源快照，经人工确认后逐步产出需求澄清、技术方案、实施计划、实现说明、工程验证与测试证据。每个阶段产物、待审批状态和审批记录均需通过 Git 固化后，才可作为下游依据；工作流在测试验证获批后结束，不管理 PR、发布或线上运维。

## 当前状态

**设计审阅中，命令尚未实现。**

固定七阶段、任务失效传播、上下文产物契约、Lark MCP 来源接入、来源安全规则、Superpowers 方法论引用和 Codex Adapter 接口已完成文档定义，下一步是按实施计划初始化框架并编写测试。

## 文档

### 01 立项与规划

- [立项申请](docs/01-立项与规划/立项申请.md)：说明为何立项、MVP 范围、投入风险、试点指标与阶段决策。
- [发展规划](docs/01-立项与规划/发展规划.md)：定义从 MVP 到团队级、组织级能力的演进方向与进入条件。
- [方案调研](docs/01-立项与规划/方案调研.md)：比较直接使用 Codex、Superpowers、Trellis 三条路径，明确 aiw 的治理定位。

### 02 需求定义

- [MVP需求与验收规范](docs/02-需求定义/MVP需求与验收规范.md)：功能范围、错误行为与自动化验收场景。
- [需求来源与关键决策记录](docs/02-需求定义/需求来源与关键决策记录.md)：记录 MVP 范围的来源、已确认取舍、待验证假设与变更规则。

### 03 方案设计

- [产品设计](docs/03-方案设计/产品设计.md)：定义用户角色、核心流程、任务产物与团队协作方式。
- [架构设计](docs/03-方案设计/架构设计.md)：定义系统分层、任务模型、审批机制、上下文与安全边界。
- [研发工作流阶段规范](docs/03-方案设计/研发工作流阶段规范.md)：固定七阶段、产物、审批、方法论引用与失效规则。
- [技能包规范](docs/03-方案设计/技能包规范.md)：团队技能的目录、元数据、版本锁定和安全边界。
- [安全规范](docs/03-方案设计/安全规范.md)：来源接入、技能供应链、提示词隔离与 Codex 进程边界。
- [Lark来源连接器规范](docs/03-方案设计/Lark来源连接器规范.md)：通过已配置 MCP 获取、快照和刷新 Lark 需求资料。
- [任务模型规范](docs/03-方案设计/任务模型规范.md)：Git 共享的节点状态、审批、依赖和失效传播。
- [上下文包规范](docs/03-方案设计/上下文包规范.md)：共享任务产物、来源快照、注入规则和本机运行数据边界。
- [Codex适配器规范](docs/03-方案设计/Codex适配器规范.md)：运行请求、结果、失败处理和适配边界。
- [CLI 命令参考](docs/03-方案设计/CLI命令参考.md)：MVP 命令、参数、输出和状态影响。

### 04 实施规划

- [MVP版本实施计划](docs/04-实施规划/MVP版本实施计划.md)：按测试驱动分解的框架与功能实现步骤。

### 05 开发实现

当前尚无正式文档；后续补充开发指南。

### 06 测试验证

当前尚无正式文档；后续补充测试计划与验收记录。

### 07 发布运营

当前尚无正式文档；后续补充发布方案、运维手册与复盘报告。

## 计划中的目录

```text
src/        # aiw CLI、任务编排和 Codex 适配器
skills/     # 示例声明式技能
docs/       # 设计与实施文档
tests/      # 单元和端到端测试
```
