# AI Workflow

`aiw`（AI Workflow）是一个面向开发团队的本地 CLI。它将团队沉淀的开发方法保存为版本化 `SKILL.md` 技能，并把复杂需求组织为可审阅的任务流程，交由 Codex CLI 执行。

## 项目定位

AI Workflow 不替代 Codex，也不创建新的聊天系统。它负责四件事：

- 通过 Git 共享、审阅和版本化团队技能；
- 将复杂需求拆为固定七阶段及其可扩展子任务；
- 在需求澄清、实施计划和最终测试等关键阶段引入人工确认；
- 只为当前阶段向 Codex 传递最小、已确认的上下文。

业务代码、任务资料和运行记录默认保留在开发者本机。

## MVP 边界

MVP 聚焦“本机单 Agent + 团队共享技能仓库”。它不会：

- 构建云端调度、账号体系或多 Agent 协作平台；
- 自动选择技能，或执行技能包携带的任意脚本；
- 保存完整聊天记录，或在未授权时读取需要登录的在线文档。

## 目标工作流

```bash
aiw skills install git@github.com:your-org/agent-skills.git
aiw skills list
aiw task init req-123 --project . --source https://example.com/requirements
aiw task run req-123 clarify --skill requirements-clarification
aiw task approve req-123 clarify
aiw task run req-123 solution --skill technical-solution
aiw task run req-123 plan --skill implementation-planning
aiw task approve req-123 plan
aiw task run req-123 implement --skill implementation
aiw task run req-123 verify --skill implementation-verification
aiw task run req-123 test --skill acceptance-testing
aiw task approve req-123 test
```

这个流程将在线需求资料固化为本地快照，经人工确认后逐步产出需求澄清、技术方案、实施计划、实现说明、工程验证与测试证据。工作流在测试验证获批后结束，不管理 PR、发布或线上运维。

## 当前状态

**设计审阅中，命令尚未实现。**

固定七阶段、任务失效传播、上下文产物契约、URL 抓取安全规则、Superpowers 方法论引用和 Codex Adapter 接口已完成文档定义，下一步是按实施计划初始化框架并编写测试。

## 文档

### 产品与协作

- [管理层决策方案](docs/product/管理层决策方案.md)：立项价值、MVP、风险、衡量指标与阶段决策。
- [方案选型与替代方案评估](docs/product/方案选型与替代方案评估.md)：为什么复用 Codex，并以轻量工作流层补齐团队治理能力。
- [研发使用与协作方案](docs/product/研发使用与协作方案.md)：研发角色、日常工作流、产物和协作边界。
- [架构设计](docs/design/架构设计.md)：分层、任务 DAG、人工关卡、上下文与安全边界。

### MVP 规范与参考

- [最小可行产品需求与验收标准](docs/specs/最小可行产品需求与验收标准.md)：功能范围、错误行为与自动化验收场景。
- [研发工作流阶段规范](docs/specs/研发工作流阶段规范.md)：固定七阶段、产物、审批、方法论引用与失效规则。
- [技能包规范](docs/specs/技能包规范.md)：团队技能的目录、元数据、版本锁定和安全边界。
- [安全设计](docs/specs/安全设计.md)：来源接入、技能供应链、提示词隔离与 Codex 进程边界。
- [任务模型规范](docs/specs/任务模型规范.md)：节点状态、审批、依赖和失效传播。
- [上下文包规范](docs/specs/上下文包规范.md)：任务产物、来源快照、注入规则和 URL 安全边界。
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
