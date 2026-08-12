# AI Workflow

`aiw`（AI Workflow）是一个面向开发团队的本地 CLI。它将团队沉淀的开发方法保存为版本化 `SKILL.md` 技能，并把复杂需求组织为可审阅的任务流程，交由 Codex CLI 执行。

## 项目定位

AI Workflow 不替代 Codex，也不创建新的聊天系统。它负责四件事：

- 通过 Git 共享、审阅和版本化团队技能；
- 将复杂需求拆为有依赖的子任务；
- 在需求、方案和验证等关键阶段引入人工确认；
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
aiw task run req-123 analysis --skill requirements-analysis
aiw task approve req-123 analysis
aiw task run req-123 design --skill architecture-design
aiw task approve req-123 design
aiw task run req-123 implementation --skill implementation
```

这个流程将在线需求资料固化为本地快照，经人工确认后逐步产出需求摘要、实施计划、代码与验证结果。

## 当前状态

**设计审阅中，命令尚未实现。**

在开始框架实现前，需先补充并确认任务失效传播、上下文产物契约、URL 抓取安全规则和 Codex Adapter 接口。

## 文档

- [产品方案](docs/product/产品方案.md)：面向管理层的立项价值、MVP、风险、衡量指标与阶段决策。
- [架构设计](docs/design/架构设计.md)：分层、任务 DAG、人工关卡、上下文与安全边界。
- [最小可行产品需求与验收标准](docs/specs/最小可行产品需求与验收标准.md)：功能范围、错误行为与自动化验收场景。
- [技能包规范](docs/specs/技能包规范.md)：团队技能的目录、元数据、版本锁定和安全边界。
- [安全设计](docs/specs/安全设计.md)：来源接入、技能供应链、提示词隔离与 Codex 进程边界。
- [任务模型规范](docs/specs/任务模型规范.md)：节点状态、审批、依赖和失效传播。
- [上下文包规范](docs/specs/上下文包规范.md)：任务产物、来源快照、注入规则和 URL 安全边界。
- [Codex 适配器契约](docs/specs/Codex适配器契约.md)：运行请求、结果、失败处理和适配边界。
- [CLI 命令参考](docs/reference/CLI命令参考.md)：MVP 命令、参数、输出和状态影响。
- [最小可行产品实施计划](docs/plans/最小可行产品实施计划.md)：按测试驱动分解的框架与功能实现步骤。

## 计划中的目录

```text
src/        # aiw CLI、任务编排和 Codex 适配器
skills/     # 示例声明式技能
docs/       # 设计与实施文档
tests/      # 单元和端到端测试
```
