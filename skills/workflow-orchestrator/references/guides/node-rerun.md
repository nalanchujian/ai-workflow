# 节点重跑指南

节点产物字段和值以 [产物 Schema](../contracts/node-artifact.schema.json) 为准，节点固定文件名以 [节点注册表](../contracts/node-registry.json) 为准。

节点重跑或解除 `blocked` 前，编排器必须先调用统一入口：

```text
scripts/task-state.rb invalidate-from --actor workflow-orchestrator --task-dir <task-dir> --node <node-id> --reason <reason> --expected-revision <revision>
```

不得手工覆盖产物、清理状态或直接再次调用 `start-node`。CLI 删除当前节点及下游产物，但在 `task.yaml.attempts` 保留各节点已经使用到的最大 attempt；新产物的 `attempt` 必须为该值加 1。旧产物不会保留到 `history/`。

上游重跑时，按当前路径删除依赖它的全部下游当前产物，再开始新的 attempt。路径尚未确定时，按所有路径的并集计算失效范围。

失效范围内的当前人工批准和 blocker 会被清除，`task.yaml` 不保存 gate、blocker 或失效操作的历史记录。

开发实现失效时，CLI 清除四项交付代码身份；质量验证或变更评审失效时保留代码身份，但删除对应的当前节点产物。

删除前 CLI 写入恢复日志并临时移动文件；若进程在事务期间中断，下一次状态命令会自动回滚未提交删除，或完成已提交删除。不得在恢复日志存在时手工移动产物或修改 revision。

已登记的正式产物只允许 `completed` 或 `blocked`。需求受理尚未登记的逐项确认草稿使用 `awaiting_confirmation`；gate 状态变化不修改已登记产物，也不增加 attempt。
