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

### 产品与协作

- [管理层决策方案](docs/product/管理层决策方案.md)：立项价值、MVP、风险、衡量指标与阶段决策。
- [方案选型与替代方案评估](docs/product/方案选型与替代方案评估.md)：与直接使用 Codex、Superpowers、Trellis 三条路径的取舍，以及 aiw 补齐的团队治理能力。
- [研发使用与协作方案](docs/product/研发使用与协作方案.md)：研发角色、日常工作流、产物和协作边界。
- [架构设计](docs/design/架构设计.md)：分层、任务 DAG、人工关卡、上下文与安全边界。

### MVP 规范与参考

- [最小可行产品需求与验收标准](docs/specs/最小可行产品需求与验收标准.md)：功能范围、错误行为与自动化验收场景。
- [研发工作流阶段规范](docs/specs/研发工作流阶段规范.md)：固定七阶段、产物、审批、方法论引用与失效规则。
- [技能包规范](docs/specs/技能包规范.md)：团队技能的目录、元数据、版本锁定和安全边界。
- [安全设计](docs/specs/安全设计.md)：来源接入、技能供应链、提示词隔离与 Codex 进程边界。
- [Lark来源连接器规范](docs/specs/Lark来源连接器规范.md)：通过已配置 MCP 获取、快照和刷新 Lark 需求资料。
- [任务模型规范](docs/specs/任务模型规范.md)：Git 共享的节点状态、审批、依赖和失效传播。
- [上下文包规范](docs/specs/上下文包规范.md)：共享任务产物、来源快照、注入规则和本机运行数据边界。
- [Codex 适配器契约](docs/specs/Codex适配器契约.md)：运行请求、结果、失败处理和适配边界。
- [CLI 命令参考](docs/reference/CLI命令参考.md)：MVP 命令、参数、输出和状态影响。

### MVP 实施

- [最小可行产品实施计划](docs/plans/最小可行产品实施计划.md)：按测试驱动分解的框架与功能实现步骤。

## 计划中的目录

```text
src/        # aiw CLI、任务编排和 Codex 适配器
skills/     # 示例声明式技能
docs/       # 设计与实施文档
tests/      # 单元和端到端测试
```
