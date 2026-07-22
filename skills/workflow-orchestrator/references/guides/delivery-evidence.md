# 交付代码证据指南

交付字段和值以 [交付证据 Schema](../contracts/delivery-evidence.schema.json) 为唯一机器规范。

开发实现、质量验证和变更评审使用同一份 Git 变更证据，证明实现、验证和 Review 针对同一份代码。任务应位于干净、隔离的任务分支或 worktree。

开发实现形成 `completed` 产物后，由编排器先调用 `set-delivery` 写入 `repository_root`、`base_commit`、`candidate_tree` 和 `change_fingerprint`，再调用 `record-result` 登记开发产物。质量验证和变更评审不得修改这四项代码身份；它们分别核对代码身份后，用 `record-result` 登记当前产物。

开发实现开始前记录仓库位置和 base commit；实现后通过临时 Git index 生成 candidate tree，并对 base commit 与 candidate tree 的 canonical binary diff 计算 SHA-256 指纹。四项代码身份在开发阶段写入后被冻结；代码发生变化时必须通过 `invalidate-from development-implementation` 退回并重建证据链。

临时 index 依次执行 `git read-tree <base_commit>`、`git add -A` 和 `git write-tree`。指纹输入固定为 `git diff-tree --binary --full-index --no-commit-id -r <base_commit> <candidate_tree>` 的原始字节。

开发实现、质量验证和变更评审完成前，状态 CLI 都会确认四项代码身份完整。任务完成前，开发实现、质量验证和变更评审的当前产物都必须已登记。提交和推送不属于任务状态流，仍需单独授权。
