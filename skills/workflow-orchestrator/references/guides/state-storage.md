# 状态存储指南

节点 skill 只能读取任务状态并原子写入自己的产物。普通状态推进由 `workflow-orchestrator` actor 写入；`approve-gate`、`reject-gate` 只接受 `workflow-owner` actor 和当前 Gate 的精确确认指令。

`--actor workflow-orchestrator` 与 `--actor workflow-owner` 是流程策略和审计标签，不是操作系统身份认证。CLI 的 actor 白名单、精确确认指令、`flock`、revision 和契约校验可以阻止误操作、模糊确认和旧确认重放；若威胁模型包含同一系统用户下恶意直接改文件、伪造用户原文或冒充 actor，必须把 Gate 决策封装到带用户认证的独立服务、受权限保护的 Unix socket 或不同系统账户中，不能仅靠本地参数实现身份隔离。

`<tasks-root>` 首次创建任务时解析为绝对路径：优先使用 `AI_WORKFLOW_TASKS_DIR`，否则从 orchestrator 的真实路径定位仓库根目录并使用 `runtime/tasks`。后续节点必须复用现有任务目录。

状态 CLI 修改前通过 `<task-dir>/.workflow.lock` 获取内核排他 `flock`，按任务状态 Schema 校验完整嵌套结构，并严格校验调用方传入的 `revision`。锁文件内容只记录最近一次 owner 供审计；互斥由内核锁保证，进程退出后自动释放，不依赖删除锁文件或 PID 过期判断。成功写入时 revision 加 1；内容先写入同目录临时文件，校验后原子替换 `task.yaml`。

任务状态的 `artifacts` 以节点名为 key，每项只保存当前产物的 `attempt` 和文件 SHA-256；`attempts` 保存各节点已经使用到的最大 attempt。文件位置直接从节点注册表推导。除取消外，状态命令会核对已登记的当前产物，文件被静默覆盖时停止推进；受控重跑通过 `invalidate-from` 删除旧文件并保留 attempt 计数。旧任务若仍使用文件名 key、纯文件名索引、对象型 `next_node` 或旧历史字段，下一次成功写入时会按字段形态自动归一化。

`invalidate-from` 删除文件前先写入 `.workflow-transaction.json`，并把待删除文件临时移动到 `.workflow-discard/`。状态未提交时自动移回原位；状态已提交时永久删除临时文件。事务结束后临时目录和日志都必须消失。

恢复中断任务时，先调用 `task-state.rb audit` 对账任务状态、当前产物、attempt 计数、gate 和交付证据。`audit` 获取任务锁并处理遗留事务日志，但不修改 `task.yaml` 或 revision。`active` 执行中任务的当前节点产物存在但未登记时，可以在验证身份、状态和连续 `attempt` 后用 `record-result` 补登记；需要重做或任务已为 `blocked` 时，先用 `invalidate-from` 清理并恢复。`completed`、`cancelled` 只允许审计，不得补写或重开；发现终态证据异常时创建新任务处理。

CLI 在 pending Gate 的写入结果和 `audit` 输出中返回 `approve_confirmation`、`reject_confirmation`。调用方必须原样展示；批准格式固定为 `确认节点：<task-id>/<node-id>@<revision>`，拒绝格式固定为 `拒绝节点：<task-id>/<node-id>@<revision>`，不能自行生成近似文本。revision 变化后旧指令自动失效。
