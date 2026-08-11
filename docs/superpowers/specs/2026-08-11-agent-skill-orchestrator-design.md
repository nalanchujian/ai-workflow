# 本地 Agent 技能与任务编排器设计

## 目标与范围

构建本地 CLI 工具 `aiw`（AI Workflow），让团队从 Git 共享声明式 `SKILL.md` 技能，并将复杂需求组织为可审阅、可恢复的子任务图，交由 Codex CLI 执行。团队共享技能仓库，但所有业务代码、任务文档与执行数据都保留在每位成员的本机。

MVP 不构建新的模型、聊天系统、云端调度器或多 Agent 协作系统；不允许技能包携带可执行代码；不自动选择技能；不读取未经授权的登录态在线文档。

## 命令体验

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

`aiw skills install` 在首次运行时克隆技能仓库到本地缓存，验证结构并记录来源与锁定的 Git revision；`aiw skills update` 更新指定 revision。

## 七层架构

1. **交互层（aiw CLI）**：解析安装、任务、审批和执行命令，输出人类可读和机器可读结果。
2. **来源接入层**：读取本地文件、公开 URL 或受控连接器内容，转换为标准文本并生成来源快照。
3. **任务上下文与状态层**：保存来源、已确认产物、上下文注入规则、任务 DAG、状态和审批记录。
4. **技能目录层**：管理本地技能缓存，按名称定位 `SKILL.md`，记录来源、版本和校验结果。
5. **任务编排层**：验证任务依赖，选择当前阶段的已确认上下文与显式技能，管理状态和人工关卡。
6. **Agent 适配层**：将通用运行请求转换为 Codex CLI 的参数、提示词和临时上下文文件。未来可增加其他适配器。
7. **执行层（Codex CLI）**：外部执行者，负责分析、读写代码、调用工具和运行测试。

`aiw` 负责技能、任务图、上下文与关卡；Codex 负责实际执行。技能仓库由第 4 层读取，业务仓库只由第 7 层读写。

## 技能包

```text
skills/
  requirements-analysis/SKILL.md
  architecture-design/SKILL.md
  implementation/SKILL.md
  testing/SKILL.md
```

每个 `SKILL.md` 采用 YAML front matter，至少声明 `name`、`version`、`description` 和适用阶段；正文包含触发条件、步骤、禁止事项和验证要求。MVP 仅加载 Markdown 与受限元数据。

## 复杂任务、子任务和审批

任务是 DAG，而不是单条提示词。默认五个执行节点：资料接入、需求分析、方案设计、实现和验证。实现节点可继续拆成有依赖的 API、数据库、前端或测试子任务；这仍可由单个 Codex 依次执行。

需求分析、方案设计和最终验证后默认存在人工关卡：

```text
pending → ready → running → awaiting_approval → completed
                    │                 │
                    ├→ failed         └→ pending（要求修改）
                    └→ cancelled

任意节点 → invalidated（上游 revision 变化）
```

审批决定独立于节点状态；需要审批的节点仅在获批后进入 `completed`。每个子任务有 ID、标题、依赖、显式技能、状态、审批要求和产物路径。上游任务未完成时，下游任务不得执行；上游被修订后，已开始的下游任务会标记为 `invalidated`。

## 任务上下文

`aiw` 不保存完整聊天记录。它保存可追溯任务产物，并仅向当前阶段注入最小、已确认的上下文：

```text
.aiw/tasks/req-123/
  source.md        # 来源文档的文本快照
  source.meta.json # URL、获取时间、内容哈希
  brief.md         # 已确认的结构化需求
  questions.md     # 待确认事项
  plan.md          # 已确认的实施计划
  task.yaml        # DAG、状态、审批和上下文规则
  runs.jsonl       # 每次 Agent 调用的最小记录
```

来源快照是在线文档在某一时刻的本地文本副本，不是图片。来源内容变更时，由哈希检测并提示重新分析，绝不静默混入下游阶段。

默认注入规则：

```yaml
contextPolicy:
  analysis:
    include: [source.md, task.md]
  design:
    include: [brief.md, questions.md]
    requiresApproval: [brief.md]
  implementation:
    include: [brief.md, plan.md]
    requiresApproval: [plan.md]
  testing:
    include: [brief.md, plan.md, acceptance.md]
```

系统可自动生成来源快照和候选摘要；需求摘要、技术方案和高风险边界必须经人工批准。用户可显式增加上下文文件，所有覆盖都记录在运行记录中。

## 安全和验收

- 只读取显式提供的本地路径、公开 URL 或已授权连接器来源。
- 使用清晰分隔符传递来源文件、技能文本和用户任务，避免把不可信内容当作平台指令。
- 限制单个技能和单次注入上下文大小；超限时要求拆分。
- 记录技能版本、来源 revision、任务 ID、审批决定和注入文件清单，但默认不保存完整会话。

MVP 验收：能够安装和列出 Git 技能；从本地 Markdown 与公开 URL 创建快照；创建至少两个有依赖的子任务；阻止未批准的下游任务；组装限定上下文并通过 Codex Adapter 启动调用；记录可复现的本地运行元数据。

## 配套规范

- [任务模型规范](../../specs/task-model.md)
- [上下文包规范](../../specs/context-package.md)
- [Codex Adapter 契约](../../specs/codex-adapter-contract.md)
