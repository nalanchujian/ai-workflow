# 任务模型规范（v1）

## 目的

任务模型将一个复杂需求表示为本地、可追溯的有向无环图（DAG）。它负责子任务依赖、审批、重试与上游变更后的下游失效；不负责选择技能或调用 Agent。

## 存储位置

每个任务位于 `.aiw/tasks/<task-id>/task.yaml`。`task-id` 必须匹配 `[a-z][a-z0-9-]{1,63}`，并在本地任务目录中唯一。

```yaml
schemaVersion: aiw.task/v1
id: refund-123
title: 实现退款功能
projectRoot: /absolute/path/to/repository
status: active # active | blocked | completed | cancelled
nodes:
  analysis:
    title: 分析需求
    phase: analysis
    dependsOn: []
    skill: requirements-analysis@1.0.0
    requiresApproval: true
    status: ready
    revision: 0
    outputs: [artifacts/brief.md, artifacts/questions.md, artifacts/acceptance.md]
  design:
    title: 设计方案
    phase: design
    dependsOn: [analysis]
    skill: architecture-design@1.0.0
    requiresApproval: true
    status: pending
    revision: 0
    outputs: [artifacts/plan.md]
approvals: []
events: []
```

## 节点状态

`status` 只描述节点的执行状态；审批决定单独保存在 `approvals` 中，避免将 `approved` 与 `completed` 混为一谈。

```text
pending → ready → running → awaiting_approval → completed
                  │                 │
                  ├→ failed         ├→ pending  (changes requested)
                  └→ cancelled      └→ completed (approved)

任意节点 → invalidated（已使用的上游 revision 改变）
invalidated → pending（重新规划或确认后）
```

- `pending`：依赖、人工输入或规划尚未满足。
- `ready`：所有依赖均为 `completed`，可开始执行。
- `running`：Runner 已启动一次 Agent 调用。
- `awaiting_approval`：节点已产出结果，等待人工决定。
- `completed`：节点已成功结束；若要求审批，则已经批准。
- `failed`：Agent 调用或产物校验失败；保留错误信息与运行记录。
- `invalidated`：上游输出发生新 revision，旧产物不可再作为当前任务依据。
- `cancelled`：用户终止；不得自动重试。

## 审批

审批是一条不可变事件：

```yaml
- nodeId: analysis
  nodeRevision: 1
  decision: approved # approved | changes_requested
  actor: local-user
  at: 2026-08-11T12:00:00Z
  note: 验收标准已补齐
```

只有 `awaiting_approval` 节点可接受审批。`approved` 将节点转为 `completed`；`changes_requested` 将节点转为 `pending`，并创建下一次执行所需的修订说明。审批记录必须引用确切的 `nodeRevision`，不能批准已过期的产物。

## 依赖与失效传播

- 节点可运行的前提是所有 `dependsOn` 节点均为 `completed`。
- 一次节点成功运行会使其 `revision` 加一，并记录实际产物的哈希。
- 已完成节点的新 revision、来源快照刷新、或人工将节点退回修改时，编排器必须递归标记所有已开始的下游节点为 `invalidated`。
- `invalidated` 节点的旧产物只读保留，不能被自动注入。用户必须重新运行或明确取消该节点。
- 失效传播仅沿 DAG 出边进行；节点不能依赖自身或形成环。创建或更新任务时必须检测环。

## 默认任务图

```text
intake → analysis → [人工确认] → design → [人工确认] → implementation → testing → [人工确认]
```

`implementation` 可以替换为多个依赖节点，例如 `schema`、`api`、`ui` 和 `integration-test`。MVP 仍按单 Agent、单节点串行运行；DAG 仅表达顺序与阻塞关系，不表示并发调度。

## 命令语义

- `aiw task init <id>`：创建任务、资料接入节点和默认 DAG。
- `aiw task run <id> <node-id> --skill <name>`：仅在节点为 `ready` 时运行；技能必须与节点记录的版本一致，除非显式更新任务图。
- `aiw approve <id> <node-id>`：批准当前 revision 的 `awaiting_approval` 节点。
- `aiw revise <id> <node-id> --note <text>`：退回当前节点并触发下游失效。
- `aiw task status <id>`：显示节点、依赖、审批和失效原因。

## 验证规则

解析时必须拒绝重复节点 ID、未知依赖、环、非法状态、缺少产物路径，以及任务根目录外的产物路径。所有状态迁移、审批、失效和运行结果都写入 `events`，以便复现。
