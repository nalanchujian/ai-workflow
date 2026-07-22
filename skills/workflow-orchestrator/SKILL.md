---
name: workflow-orchestrator
description: 读取新需求或现有任务目录，按任务状态自动选择并执行研发工作流节点，处理轻量需求、复杂需求分流以及人工关口。适用于启动完整研发流程、继续中断任务、判断下一节点或要求端到端推进任务的场景。
---

# 研发流程编排

任务目录统一写作 `<tasks-root>/<task-id>`。先读取 `AI_WORKFLOW_TASKS_DIR`；未设置时，以本 skill 的真实路径定位 ai-workflow 仓库根目录，再使用其中的 `runtime/tasks`。不得按当前业务仓库或当前工作目录猜测 `<tasks-root>`。

只负责任务状态推进、路径分流和节点调度。每个节点的业务操作必须读取并遵循对应 `skills/<node-id>/SKILL.md`，不能在本 skill 中重新实现节点职责。节点只写自己的产物并报告结果；普通状态推进只能使用 `scripts/task-state.rb --actor workflow-orchestrator`，Gate 批准或拒绝只能转发用户精确确认指令并使用 `--actor workflow-owner`。

## 启动方式

- 新任务：从 `$requirement-intake` 开始，创建任务目录和 `task.yaml`。
- 现有任务：先调用 `task-state.rb audit`，通过后再读取用户提供的 `task.yaml`、已登记产物和当前 Git 状态，从首个未完成的必经节点继续。
- 指定节点：先校验当前路径的准入产物；准入不满足时退回缺失产物的责任节点。

## 推进规则

1. 每次只执行一个节点。继续现有任务时先调用 `task-state.rb audit`；执行前读取该节点完整的 `SKILL.md`、[契约清单](references/contract-manifest.json) 和 [任务生命周期指南](references/guides/task-lifecycle.md)，按清单加载节点、路径、状态、gate 与产物机器契约；节点重跑或解除阻塞时，必须先调用 `task-state.rb invalidate-from` 受控删除当前及下游产物、保留 attempt 计数并失效旧批准，再调用 `start-node`。`start-node` 成功后会消费 `next_node`，在节点报告前不得重复启动。节点返回后验证新增产物，再以 `record-result --gate-owner workflow-owner` 登记结果并创建人工 gate；只有开发实现需要先调用 `set-delivery` 写入代码身份，不得手工覆盖已登记产物。
2. 人工确认前必须先展示“节点产出”，固定顺序为：可点击的产物绝对路径、产物状态与一句话结论、本节点实际生成的内容及数量、风险或阻塞，然后才展示当前 `RQ-*` 或 CLI 返回的精确 `approve_confirmation`。不得只抛出人工确认项，也不得只说“产物已生成”而不说明产出了什么。普通节点登记产物并进入 `awaiting_confirmation` 后停止自动推进并按此顺序展示；需求受理节点的未登记草稿使用 `status: awaiting_confirmation`，初始草稿写入后、展示首个 `RQ-*` 前同样先展示草稿产出，后续每次确认或修改时先说明已写入的 `CL-*` 决策，再展示下一项。`blocked` 只用于缺少资料、存在缺陷或无法继续，不得用于正常等待确认。需求受理与确认在同一节点内完成：先整理 `RF-*` 事实和 `RQ-*` 疑点，再按编号逐条对话；每轮只展示当前 `RQ-*`，并完整提供疑点标题、具体问题、产生原因、推荐答案和影响范围，仅接受匹配当前编号的 `确认` 或 `修改`。确认或修改后才展示下一项，“可以”“继续”等模糊回复不能确认疑点。全部 `RQ-*` 都形成“已人工确认”的 `CL-*` 后，才能登记节点一 `completed` 产物并创建最终 Gate；该 Gate 确认整份需求定义准确。只有当用户整条消息去除首尾空白后与 `确认节点：<task-id>/<node-id>@<revision>` 完全一致时，才可将该原文作为 `--confirmation` 转发给 `approve-gate --actor workflow-owner --gate-owner workflow-owner`；“继续”“执行下一节点”“可以”“没问题”及任何附加说明都不构成批准。最终 Gate 拒绝时仍要求用户提交 CLI 返回的 `reject_confirmation` 并提供原因，再以 `--actor workflow-owner` 调用 `reject-gate`。待确认期间收到执行节点请求时，只能重新展示当前节点产出、当前疑点或精确确认指令，不能批准或启动下一节点。
3. 需求分流只选择 `lightweight` 或 `complex`。状态 CLI 会在登记节点一产物时强制校验全部 `RQ-*` 均被 `CL-*` 覆盖，且每条决策状态均为“已人工确认”；存在未确认疑点时保持节点一执行中，不能创建 Gate 或进入需求分流。
4. 需求分流成功后，按机器工作流契约中的 `paths` 寻找首个未完成节点并继续推进。
5. 每个节点都是人工关口；遇到缺失资料或 `blocked` 状态时同样停止推进。若批准后的下一节点会修改业务代码，确认文案必须明确说明该批准同时授权进入代码修改；未获得明确授权不得启动开发实现。blocker 的 `retry_node` 必须使失效范围覆盖来源节点，确认处理方式后调用 `invalidate-from`，不得直接启动重试节点。
6. 不跳过当前路径的必经产物，不用聊天结论替代文件，不在未授权时修改业务代码、提交、推送或合并。
7. 交付终点和 gate 的正常批准后节点由路径契约决定；路径外恢复点与拒绝回退节点由 gate 契约决定，不在本文件维护副本。
8. 当前路径的变更评审通过且交付代码指纹一致时，先登记产物并创建终点 gate；只有用户批准该 gate 后，状态 CLI 才将任务标记为 `completed`。

## 验收依据

- `lightweight`：读取 `implementation-plan.md` 的“最小验收条件”。
- `complex`：读取 `acceptance-checklist.md`。

开发实现和质量验证必须读取当前路径对应的验收依据，不能自行选择或临时生成另一套标准。

## 状态写入

每次更新任务状态或人工关口前，按 [契约清单](references/contract-manifest.json) 加载 [任务状态 Schema](references/contracts/task-state.schema.json) 与 [审批 Gate](references/contracts/approval-gates.json)，按照 [状态存储指南](references/guides/state-storage.md) 只通过 `scripts/task-state.rb` 写入。创建节点产物时执行 [节点产物 Schema](references/contracts/node-artifact.schema.json)，节点注册表声明子 Schema 时还必须执行对应子 Schema；开发实现、质量验证和变更评审还必须执行 [交付证据 Schema](references/contracts/delivery-evidence.schema.json) 和 [交付证据指南](references/guides/delivery-evidence.md)。开发实现先用 `set-delivery` 写入代码身份，再用 `record-result --gate-owner workflow-owner` 完成节点；其他节点也必须用同一 gate owner 登记结果。普通命令使用 `--actor workflow-orchestrator`，Gate 决策使用 `--actor workflow-owner` 并携带用户原样提交的精确 `--confirmation`；不得由 AI 构造确认指令。旧任务若停在已登记但未创建 gate 的节点，调用 `request-gate --gate-owner workflow-owner` 迁移当前节点，不回滚更早的已完成产物。不要在本文件复制另一套规则。

## 调用方式

```text
使用 $workflow-orchestrator
新任务：<需求资料与目标模块>
```

```text
使用 $workflow-orchestrator
继续任务：<tasks-root>/<task-id>
```
