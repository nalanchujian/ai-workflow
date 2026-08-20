# CLI 命令参考

## 日常使用

```bash
aiw init
aiw doctor [--project <path>] [--source <地址>]
aiw task init --project <path> --source <地址或文件> [--section <标题>] [--force-new]
aiw task status <task-id> [--project <path>]
aiw task run <task-id> <node-id> [--project <path>] [--dry-run]
aiw task review <task-id> [--project <path>] [--confirm]
aiw task approve <task-id> <node-id> [--project <path>] [--note <说明>]
```

`--project` 不传时使用当前目录。所有任务事实写入 `<project>/.aiw/`。

## 初始化和环境

### `aiw init`

创建或补全 `~/.aiw/config.yaml`，自动安装默认技能包并尝试发现已配置的文档 MCP。它不创建业务任务，也不写入业务仓库。

默认工作流为 `standard-web-feature@11.0.0`，来源为 `ai-workflow-skills@v11.0.0`。

### `aiw doctor`

检查 Git、Codex CLI、本机配置、已安装方法来源、文档连接器和可选文档读取授权。`--source` 会实际检查指定文档是否可读；不传时只检查连接器配置能否解析。

## 任务来源

### `aiw task init`

创建任务、固化来源快照并锁定工作流模板和技能版本。

```bash
aiw task init --project . --source "https://example.com/requirements"
aiw task init --project . --source "./requirements.md"
aiw task init --project . --source "https://<tenant>.larksuite.com/wiki/<token>" --section "二期"
```

地址由内部规则路由：Lark/飞书地址使用连接器，其他 HTTP(S) 地址作为公开网页，本地路径作为本地文件。重复创建同一来源和章节的未完成任务会被拒绝；明确需要新任务时加 `--force-new`。

### `aiw task source refresh <task-id> requirements`

重新读取需求来源并生成新快照。需求变化必须使用此命令，不得手改 `snapshot.md`、方案、计划或交付报告来伪造需求更新。

## 推进节点

### `aiw task run <task-id> <node-id>`

统一执行入口，适用于首次运行、失败重试和已完成节点的覆盖式重跑。`intake` 不可运行。

可运行节点包括：`clarify`、标准需求中的 `solution`、`plan`，以及计划批准后生成的 `delivery-<unit-id>`。快速修改选定后不产生可运行的 `solution`，状态页会直接引导到 `plan`。

运行前 AIW 校验来源和上游产物哈希、Git 提交状态、业务工作树基线和上下文预算；`plan` 还会校验所选项目测试能力的健康状态。运行后保存 Prompt 清单、Diff、补丁、结果和产物哈希。

重跑校验成功后会覆盖当前节点产物、交接和审批事实，并使当前节点和下游结果失效；每次运行的日志和证据独立留在运行目录。

### `aiw task status <task-id>`

展示任务整体状态、当前交付状态、主干节点、业务交付单元、决策阻塞和唯一下一步。出现多个可执行交付单元时会逐条输出对应的 `task run` 命令。

### `aiw task review <task-id>`

只用于 `clarify` 的人工确认。系统逐项展示待确认业务结论；每项先选“本期继续”或“等待外部条件”，继续时可在 AI 推荐与人工结论间选择。随后 AIW 根据当前澄清结果的来源规模、AC 数量、决策项和事实可信度建议“快速修改 / 标准需求”：只有快速条件全部满足时可选快速修改，否则固定按标准需求推进。该命令同时写入决策事实、路径评估和澄清审批。已确认的快速修改在尚未生成计划前可再次执行 `task review` 升级为标准需求；反向降级不支持。

### `aiw task approve <task-id> <node-id>`

用于 `plan` 和每个 `delivery-<unit-id>`。审批前必须先提交当前 `.aiw` 产物。

- `plan` 审批会校验每个 AC 的唯一覆盖，然后生成交付单元；
- 交付单元普通审批要求 AIW 生成的 `acceptance-results.yaml` 中所有 AC 都是 `passed`；Codex 只能写 `acceptance-intent.yaml`，不能自行声明通过；
- `clarify` 必须使用 `task review`，不能使用此命令。

## 高级和例外场景

### `aiw task close-with-risk <task-id> <delivery-node-id>`

仅当交付单元有未通过或阻塞 AC、且业务明确接受风险时使用。必填 `--owner`、`--reason`、`--expires-at`。命令会写入该单元的风险接受事实，不会隐藏失败证据。

### `aiw task decision list <task-id>`

查看决策登记和当前结论，通常用于排查阻塞。

### `aiw task decision resolve <task-id> <decision-id>`

解除外部等待。`--impact execution-only` 只恢复执行时机；`--impact replan` 必须附加 `--fact` 与 `--evidence`，并使方案、计划和下游交付单元失效，要求重新规划。

### `aiw task cancel <task-id> <node-id> --note <说明>`

向当前运行节点发送取消请求。取消后证据保留，节点可再次使用 `task run` 重试。

### `aiw skills update --ref <tag-or-commit>`

升级本机默认技能包并切换同名默认模板版本。它只影响新任务；旧任务继续使用创建时锁定版本。当前交付单元模型需要 `ai-workflow-skills@v11.0.0` 及以上版本。

### `aiw runtime`

查看运行记录；`aiw runtime prune --older-than <天数> --apply` 可清理已过保留期的本机运行目录。未加 `--apply` 只列出候选目录。
