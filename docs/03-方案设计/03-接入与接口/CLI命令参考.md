# CLI 命令参考

## 核心问题

本文回答：当前 MVP 有哪些命令，各自用于什么场景。

## 首次使用

```bash
aiw init
aiw doctor --project <业务仓库>
aiw doctor --project <业务仓库> --source <文档地址>
```

- `init`：创建或补全安全的本机配置，安装默认技能包并发现可用文档连接器。
- `doctor`：检查 Git、业务仓库、Codex、本机配置、方法来源和连接器；传入来源时验证读取权限。

## 日常任务

```bash
aiw task init --project <业务仓库> --source <地址或文件> [--section <标题>] [--force-new]
aiw task run <task-id> <node-id> [--dry-run] [--include <项目内路径>]
aiw task review <task-id>
aiw task approve <task-id> plan --note <说明>
aiw task status <task-id>
aiw task source refresh <task-id> requirements
```

- `task init`：固化来源并创建任务。默认拒绝相同来源的重复未完成任务。
- `task run`：首次执行和重跑统一入口。`intake` 不能运行。
- `task review`：逐项确认澄清决策，并批准澄清节点。
- `task approve ... plan`：批准开发计划并生成开发单元。
- `task status`：查看主干、开发单元和汇总开发进度。
- `task source refresh`：重新读取来源；内容变化后使下游重新执行。

`status`、`review`、`approve` 和 `source refresh` 当前从执行命令所在的业务仓库读取任务。`task run` 提供 `--project` 选项，但当前运行时仍以创建 CLI 时的项目目录为准；MVP 推荐始终先 `cd` 到业务仓库再执行任务命令。

## 高级和例外

```bash
aiw task cancel <task-id> <node-id> --note <原因>
aiw skills install <git-url> [--ref <ref>]
aiw skills update --ref <tag-or-commit>
aiw skills list
aiw skills profiles list
aiw history show <task-id> <run-id>
aiw history prune --older-than 30d
aiw history prune --older-than 30d --apply
```

- `cancel`：请求安全停止正在运行的节点。
- `skills`：维护团队技能包和默认模板，普通用户通常不需要。
- `history show`：查看某次本机运行的状态、上下文摘要和日志路径。
- `history prune`：默认只预览；加 `--apply` 才删除过期本机运行目录。

## 输出约定

- 默认输出面向用户的中文摘要和编号化下一步。
- `--json` 输出机器可读 JSON。
- 下一步只有在确实存在未提交任务事实时才提示 Git 提交。
- 节点失败时给出失败原因、需检查的业务路径和可执行重试命令。
