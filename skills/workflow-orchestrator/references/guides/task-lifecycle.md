# 任务生命周期指南

任务状态字段和值以 [任务状态 Schema](../contracts/task-state.schema.json) 为唯一机器规范，节点路径以 [工作流路径](../contracts/workflow-paths.json) 为准，人工确认以 [审批 Gate](../contracts/approval-gates.json) 为准。

任务创建、待启动和节点执行期间使用 `active`。每个节点完成后创建人工 gate，并将任务写为 `awaiting_confirmation`；节点无法继续时写为 `blocked`；变更评审 gate 批准且交付证据完整时写为 `completed`；明确取消时写为 `cancelled`。

`completed` 和 `cancelled` 是不可变终态，状态 CLI 拒绝后续 gate、交付证据、重跑和取消写入。`blocked` 任务不能直接启动下一节点；确定处理方式后，编排器先按节点重跑指南调用 `invalidate-from`，清除当前 blocker 并恢复为 `active`。

`active` 只有两种合法形态：待启动时有 `next_node`；执行中有 `current_node` 且 `next_node=null`。`awaiting_confirmation` 表示当前产物已登记并存在 pending gate；非终点 gate 同时保存批准后的 `next_node`，终点 gate 的 `next_node=null`。`start-node` 会消费 `next_node`，同一节点不能重复启动。

## 状态转换矩阵

| 命令 | 允许的任务状态 | 核心前置条件 | 成功后的关键状态 |
| --- | --- | --- | --- |
| `init` | 不存在 | 任务目录没有 `task.yaml` | `active`，下一节点为需求受理 |
| `audit` | 任意已存在状态 | `task.yaml`、当前产物、attempt 计数、gate 和交付证据满足契约 | 只读校验，不修改状态和 revision |
| `start-node` | `active` | 节点等于 `next_node`；路径和 gate 准入满足 | `current_node` 为该节点，`next_node=null` |
| `record-result` | `active` 执行中 | 当前节点匹配；产物身份、attempt、摘要有效；完成结果提供 gate owner | 完成时创建 pending gate 并进入 `awaiting_confirmation`；失败时进入 `blocked` |
| `request-gate` | `active` 已登记产物 | 旧任务当前产物已登记、尚未批准且下一节点正确 | 补建 pending gate 并进入 `awaiting_confirmation` |
| `approve-gate` | `awaiting_confirmation` | `workflow-owner` actor；Owner 和精确确认指令匹配；当前产物未变化 | 非终点 gate 为 `approved` 并恢复 `active`；终点 gate 将任务写为 `completed` |
| `reject-gate` | `awaiting_confirmation` | `workflow-owner` actor；精确拒绝指令匹配且提供原因 | 清除 gate，创建当前 blocker，任务为 `blocked` |
| `set-delivery` | `active` 开发实现中 | 开发产物为 `completed` | 写入四项代码身份 |
| `invalidate-from` | `active`、`awaiting_confirmation` 或 `blocked` | 目标有当前证据；失效范围覆盖全部 blocker 来源 | 删除范围内产物，保留 attempt 计数，恢复 `active` |
| `cancel` | `active`、`awaiting_confirmation` 或 `blocked` | 提供取消人和原因 | 清除 gate/blocker，任务为不可变 `cancelled` |

每个节点先生成 `completed` 产物，再由编排器创建 pending gate。gate 只保存当前节点、状态和 Owner；CLI 根据当前任务、节点和 revision 返回唯一批准指令 `确认节点：<task-id>/<node-id>@<revision>` 与拒绝指令 `拒绝节点：<task-id>/<node-id>@<revision>`。只有 `workflow-owner` actor 携带完全匹配的指令才能决策，revision 变化后旧指令立即失效。批准前 CLI 会按 `artifacts` 中的 SHA-256 再次核对当前产物，批准后在当前产物记录中标记 `approved: true`。路径已经确定且 gate 节点属于当前路径时，批准后的下一节点从工作流路径推导；路径尚未确定时使用 gate 的 `approvedNext`。终点 `change-review` 没有下一节点，批准后直接进入 `completed`。拒绝时清除 gate，任务进入 `blocked` 并指向 `rejectedNext`。

统一 gate owner 使用 `workflow-owner`，表示当前任务的人工决策者。需求受理与确认节点先整理 `RF-*` 事实和 `RQ-*` 疑点，再在执行阶段通过多轮对话按顺序处理每个 `RQ-*`：未登记草稿使用 `status: awaiting_confirmation`，Owner 确认或修改后才进入下一项。全部疑点均形成状态为“已人工确认”的 `CL-*` 后，草稿改为 `completed`，CLI 才允许登记并创建 Gate；该 Gate 确认整份需求定义准确。编排器不得代替用户确认疑点、批准 Gate、补写或推导确认文本；“继续”“执行下一节点”等自然语言不具备确认效力。

需求分流产物完成后，状态 CLI 从产物读取 `path`。写入路径前必须确认该路径在需求分流之前的全部必经产物均为 `completed`；本节点随后同样等待人工确认。路径确定后，后续节点不得由调用方自由跳转。

blocker 的 `retry_node` 必须位于来源节点自身或其上游，使从该节点计算出的失效范围能够覆盖 blocker 来源。路径尚未确定时只允许需求受理与确认、需求分流两个节点，不能通过 blocker 或手工状态跳到开发阶段。

恢复现有任务或检查终态任务时，编排器先调用 `task-state.rb audit`。该命令获取同一任务锁并恢复未完成的文件删除事务，但不修改 `task.yaml` 或 revision；审计失败时不得选择或启动节点。

节点只能读取 `task.yaml`；所有状态、gate 和交付字段更新都由 `workflow-orchestrator` 调用 `scripts/task-state.rb` 完成。
