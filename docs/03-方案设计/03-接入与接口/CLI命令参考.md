# CLI 命令参考

## 核心问题

本文回答：当前 MVP 有哪些命令，各自用于什么场景。

## 首次使用

```bash
aiw init
aiw doctor
aiw doctor --source <文档地址>
aiw doctor --project <其他业务仓库>
```

- `init`：创建或补全安全的本机配置，安装默认技能包并发现可用文档连接器。
- `doctor`：检查 Git、业务仓库、Codex、本机配置、方法来源和连接器；传入来源时验证读取权限。

## 日常任务

```bash
aiw task init --project <业务仓库> --source <地址或文件> [--section <标题>] [--design <Figma URL>] [--force-new]
aiw task run <task-id> <node-name> [--dry-run] [--include <项目内路径>]
aiw task review <task-id>
aiw task approve <task-id> plan --note <说明>
aiw task ignore <task-id> <development-unit-name> --note <原因>
aiw task status <task-id>
```

- `task init`：固化来源并创建任务。`--design` 只登记带 `node-id` 的 Figma 地址并增加可选设计节点；设计节点由 Codex 使用已登录的 Chrome 截取完整页面与弹窗状态，AIW 不配置 Figma MCP；默认拒绝相同来源的重复未完成任务。
- `task run`：执行 CLI 指定的需求、方案、计划或开发节点。
- `task review`：逐项确认需求澄清产生的业务决策。
- `task approve`：批准开发计划和开发单元划分。
- `task ignore`：将不属于当前仓库或当前任务范围、且没有未完成下游依赖的开发单元标记为已忽略。
- `task status`：查看主干、开发单元和汇总开发进度。

每个命令完成后，CLI 都会直接输出下一条精准命令；用户无需自行推断节点 ID。

MVP 推荐始终先 `cd` 到业务仓库再执行任务命令。

## 高级和例外

```bash
aiw task source refresh <task-id> requirements
aiw task cancel <task-id> <node-id> --note <原因>
aiw skills install <git-url> [--ref <ref>]
aiw skills update --ref <tag-or-commit>
aiw skills list
aiw skills profiles list
aiw history show <task-id> <run-id>
aiw history prune --older-than 30d
aiw history prune --older-than 30d --apply
```

- `task source refresh`：重新读取需求来源，内容变化后使相关下游节点重新执行。
- `cancel`：请求安全停止正在运行的节点。
- `skills`：维护团队技能包和默认模板，普通用户通常不需要。
- `history show`：查看某次本机运行的状态、上下文摘要和日志路径。
- `history prune`：默认只预览；加 `--apply` 才删除过期本机运行目录。

## 输出约定

- 默认输出面向用户的中文摘要和编号化下一步。
- `--json` 输出机器可读 JSON。
- 下一步只有在确实存在未提交任务事实时才提示 Git 提交。
- 错误输出固定说明原因、已有结果是否受影响和可执行的下一步；不向普通用户暴露 Schema 等内部细节。
