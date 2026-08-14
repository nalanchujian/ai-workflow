# CLI 命令参考（MVP）

## 约定

- 命令名为 `aiw`。
- 交互式终端中的长耗时命令会在 stderr 显示 spinner、当前动作和等待时间，完成后显示 `✓` 或 `✗`；瞬时查询和状态变更命令直接输出最终结果。
- 默认输出统一遵循“结论 → 关键信息 → 下一步”，不直接打印 JSON；多个下一步按 `1.`、`2.` 编号。会写入任务事实的状态变更命令，会先列出必须执行的 `git add .aiw && git commit ...`，再列出下一条可运行或审批命令。`--json` 时 stdout 仅输出一个 JSON 对象，且不显示进度；非交互环境（CI、脚本、管道）同样自动关闭进度，需要机器解析时必须显式传入 `--json`。
- 所有失败均以非零退出码结束，错误信息写入 stderr；MVP 不承诺稳定的细分退出码。
- 路径参数必须通过真实路径校验；项目根目录的 `.aiw/` 保存共享任务事实，必须通过既有 Git 流程提交。技能缓存和原始运行数据只写入用户目录的 `~/.aiw/`。
- `<...>` 是必填参数，`[...]` 是可选参数。

## 全局命令

### `aiw --help`

显示根命令及命令组帮助。

### `aiw --version`

输出当前 `aiw` 版本。

### `aiw <command> --help`

显示指定命令的参数和示例，不修改本地状态。

### `aiw init`

在 `~/.aiw/config.yaml`（或 `AIW_HOME/config.yaml`）首次创建带中文注释的安全模板，并安装或复用模板中锁定的默认团队技能包与工作流。模板不包含凭据、不包含 Superpowers 路径，也不创建任务或运行目录；技能内容只写入用户目录的本机 Registry。文件已存在时原样保留，随后仍会校验并安装或复用其配置的默认工作流；默认工作流安装失败时保留配置并返回修复提示。

命令还会尝试从 Codex 配置中发现唯一的 Lark MCP Server，查询其工具清单，并仅在同时存在 `docx_v1_document_rawContent` 与 `docx_v1_documentBlock_list` 时自动写入 `connectors.lark`，以保证正文读取和章节读取均可用。已有映射绝不覆盖；没有候选、多个候选、工具不支持或 MCP 不可用都不会使初始化失败。多个候选时输出候选名称，可使用 `--lark-server <name>` 显式选择其中一个；该参数只指定 Server，工具名仍由 MCP 自动发现。

### `aiw doctor [--project <path>] [--lark-url <lark-url>]`

只读检查本机研发环境，返回 Git CLI、目标项目 Git 状态、Codex CLI、本机配置、已安装的内置方法和 Lark MCP 的诊断结果。每项结果包含 `passed`、`warning` 或 `failed`、原因及可执行修复建议；`--json` 时输出单个 `aiw.doctor/v1` JSON 对象。该命令不创建任务、不写入快照、不调用 Codex 执行任务。

```bash
aiw doctor --project .
aiw doctor --project /workspace/shop --lark-url https://<tenant>.larksuite.com/wiki/<node-token>
```

| 参数 | 说明 |
|---|---|
| `--project <path>` | 可选。要检查的业务仓库；未提供时使用当前目录。 |
| `--lark-url <lark-url>` | 可选。显式使用 Lark docx 或 Wiki 链接验证 MCP 的读取权限；不会保存其正文或创建任务快照。 |

未传 `--lark-url` 时，命令仅检查 Lark Connector Profile 和对应 MCP Server 定义是否可解析，并将 Lark 授权标记为未验证；不得将此状态误报为已授权。传入该参数后，命令通过已配置的 MCP 读取一次指定文档，仅报告成功或失败，不输出令牌、MCP 参数或文档正文。Lark Connector 是可选能力；未配置时显示警告，只有显式请求验证 Lark URL 时才成为失败项。

### `aiw run show <task-id> <run-id> [--project <path>]`

查看一次已完成或失败运行的共享结果、本机日志路径和上下文摘要。完整 `context.md`、标准输出、标准错误和请求文件均不写入 stdout；命令只报告它们在本机是否存在以及可查看路径。

```bash
aiw run show refund-123 run_01JABC --project .
```

返回运行状态、开始/结束时间、产物哈希、失败摘要，以及 Context Manifest 的节点、revision、文件数量、角色、估算 token 与预算。共享 `result.json` 或 `context-manifest.json` 缺失、无效或与请求任务不一致时命令失败，不猜测或重建运行记录。

### `aiw run prune [--older-than <days>d] [--apply]`

安全清理本机 `~/.aiw/runtime/<task-id>/<run-id>/` 目录。默认保留期为 30 天，且默认只预览候选目录，不删除任何文件。

```bash
aiw run prune
aiw run prune --older-than 60d
aiw run prune --older-than 30d --apply
```

| 参数 | 说明 |
|---|---|
| `--older-than <days>d` | 可选。保留期，默认 `30d`；必须是正整数天数。 |
| `--apply` | 可选。明确执行删除；未提供时只输出候选目录。 |

命令只遍历本机运行根目录下的直接 `<task-id>/<run-id>` 普通目录，跳过符号链接、锁目录和其他非运行条目；不会删除业务仓库 `.aiw/`、技能缓存或用户指定的任意路径。输出同时列出候选项和实际删除项，便于审计。

## 技能命令

### `aiw skills install <git-url> [--ref <tag-or-commit>]`

从 Git 来源安装技能到用户级缓存并记录锁定 revision。团队技能必须随包提供 `bundled:superpowers` 方法正文和上游来源清单；安装器校验后缓存并锁定它们，最终用户无需配置或理解 Superpowers。本机 `configured:` 来源不受支持。

```bash
aiw skills install git@github.com:your-org/agent-skills.git
aiw skills install https://github.com/your-org/agent-skills.git --ref v1.2.0
```

| 参数 | 说明 |
|---|---|
| `<git-url>` | 必填。Git 仓库地址。 |
| `--ref <tag-or-commit>` | 可选。要锁定的 tag 或 commit；未指定时使用来源默认分支解析到的 commit。 |

成功时显示来源、锁定 revision、已安装技能与工作流模板。相同来源再次安装时更新该来源记录，而不创建重复条目。安装记录中的每项方法论来源包含 ID、来源标识、版本、解析 revision 与 SHA-256；不输出本机绝对路径。

失败情形包括：Git 来源不可访问、指定 ref 不存在、仓库不含有效技能和工作流模板、内置方法清单或正文不合法，或任一技能/模板不符合《技能包规范》。失败时 Registry 保持不变。

### `aiw skills list`

列出已安装技能。

```bash
aiw skills list
aiw skills list --json
```

每项至少包含技能名称、版本、来源 URL 和锁定 revision。未安装任何技能时，常规模式显示空结果，`--json` 返回空列表。

### `aiw skills update --ref <tag-or-commit>`

安装并切换本机默认团队技能版本。

```bash
aiw skills update --ref v2.1.0
```

命令读取 `~/.aiw/config.yaml` 中的默认技能仓库地址，先安装和校验指定 ref；成功后将默认 ref 与该技能包中同名工作流模板的新版本一并更新。若新包缺少当前默认模板名，配置保持不变。命令不改写已有任务的锁定事实；Registry 按 Git revision 保留同一来源的多个副本，进行中的旧任务仍解析其锁定版本。

### `aiw skills profiles list`

列出可在创建任务时选择的已安装工作流模板。

```bash
aiw skills profiles list
aiw skills profiles list --json
```

每项至少包含模板名称、版本、描述、来源 revision 及六阶段技能映射。未安装模板时显示空结果；此时 `task init` 必须拒绝，不会回退到逐节点选技能。

## 任务命令

### `aiw task init --project <path> --source <source> [--source-section <title>] [--skill-profile <name[@version]>] [--force-new]`

在目标项目创建任务、来源快照和默认任务图。

```bash
aiw task init --project . --source ./requirements.md
aiw task init --project /workspace/shop --source https://example.com/requirements
aiw task init --project . --source https://<tenant>.larksuite.com/wiki/<node-token>
aiw task init --project . --source https://<tenant>.larksuite.com/wiki/<node-token> --source-section "订单退款流程"
aiw task init --project . --source ./requirements.md --skill-profile standard-web-feature@2.0.0
aiw task init --project . --source ./requirements.md --force-new
```

| 参数 | 说明 |
|---|---|
| `--project <path>` | 必填。业务项目根目录。 |
| `--source <source>` | 必填。本地文件、符合安全规则的公开 HTTP(S) 来源，或由已配置 Lark Connector 识别的 Lark `docx` / `wiki` URL。 |
| `--source-section <title>` | 可选，仅适用于 Lark 文档。按 Lark 标题块精确选择该章节及全部子标题内容，减少快照和后续上下文体积；MCP 还需启用 `docx_v1_documentBlock_list`。 |
| `--skill-profile <name[@version]>` | 可选。省略时使用 `~/.aiw/config.yaml` 的默认模板；显式传入时覆盖默认值。模板一次锁定 `clarify` 至 `test` 的六阶段技能。 |
| `--force-new` | 可选。默认发现同一仓库、同一规范化需求来源和章节存在未完成任务时拒绝创建；仅在确需另建任务时显式使用。 |

命令以 UTC 日期时间自动生成 `task-YYYYMMDD-HHmmss-SSS` 形式的任务 ID，并在输出中返回 `taskId`；调用者不得指定 ID。成功后创建 `.aiw/config.yaml`（首次）、`.aiw/tasks/<task-id>/`、`task.yaml`、`task.md` 和 `sources/<source-id>/r1/snapshot.md`，并原子锁定所选模板和六个节点的技能。Lark docx 由本机已配置的 Lark MCP Server 读取；Wiki 链接会先解析为 docx，任务元数据保留原始 Wiki 节点 ID 和解析后的文档 ID。指定 `--source-section` 时，来源元数据额外锁定实际标题、起止文档块 ID 和截取内容哈希，后续刷新仍使用该标题。MCP 配置、令牌和原始响应不写入任务目录。这些任务事实必须由调用者按既有 Git 流程提交后，才可作为后续节点的共享依据。默认节点为：

`--project` 也可用于后续的 `task status`、`task run`、`task approve`、`task revise`、`task request-changes`、`task fail`、`task cancel`、`task source refresh` 与 `task skill rebind`。AIW 会在该目录执行命令；因此任务事实不保存本机绝对路径，其他成员在自己的仓库目录或显式传入 `--project` 均可继续同一任务。

```text
intake → clarify → solution → plan → implement → verify → test
```

来源快照成功后，`intake` 自动完成，`clarify` 成为 `ready`。`clarify`、`plan`、`test` 完成执行后等待人工审批；`intake` 不允许通过 `task run` 运行。

初始化前会检查同一业务仓库内、同一规范化需求来源和章节的未完成任务。命中时输出已有 `taskId`，不会再次抓取本地、公开 URL 或 Lark 文档；应使用该 ID 继续任务。只有需要并行处理或重新开始时才加 `--force-new`。

失败情形包括：自动生成的任务 ID 与现有任务冲突、同一需求已有未完成任务、模板不存在/版本不唯一/阶段不匹配/引用技能不可用、项目路径无效或不是 Git 工作树、`.aiw/` 被 Git 忽略、来源是目录、URL 不符合协议或 IP 安全限制、Lark Connector 未配置或无权限、来源类型不受支持，以及章节参数用于非 Lark 来源、章节为空、不存在或重名。失败不得留下不完整来源快照或任务目录。

### `aiw task source refresh <task-id> <source-id>`

显式重新读取一个已有来源；MVP 不轮询或订阅在线文档变化。

```bash
aiw task source refresh refund-123 requirements
```

| 参数 | 说明 |
|---|---|
| `<task-id>` | 必填。目标任务。 |
| `<source-id>` | 必填。任务中的来源标识。 |

若正文哈希不变，命令返回“未变化”，不创建新 revision，也不改变任务状态。若正文变化，命令在 `sources/<source-id>/r<revision>/` 创建新快照和元数据，保留旧 revision，更新 `intake` 的当前输出并递归使已开始下游节点 `invalidated`。调用者必须提交新 revision 与状态变化，下游节点才可重新运行。

来源不存在、公共 URL 不符合安全规则、Lark Connector 不可用或无权限、正文为空或超限时，命令失败且不改变已有快照或任务状态。

### `aiw task status <task-id>`

显示任务状态、节点依赖、revision、审批记录和失效原因。

```bash
aiw task status refund-123
aiw task status refund-123 --json
```

任务不存在时失败；该命令不修改任务状态。

### `aiw task skill rebind <task-id> <node-id> --skill <name[@version]> --note <text>`

显式替换待执行节点的已锁定技能。

```bash
aiw task revise refund-123 plan --note "方案边界改变，需要重新制定计划"
aiw task skill rebind refund-123 plan --skill implementation-planning@1.1.0 --note "采用补充了迁移检查的新方法"
```

仅允许 `pending`、`ready`、`failed` 或 `invalidated` 节点重新绑定；`running`、`awaiting_approval`、`completed` 节点必须先结束或修订。命令记录前后锁定及原因，并使所有已开始下游节点失效。重新绑定后的 `task.yaml` 必须提交后才能运行。

### `aiw task subtask add <task-id> <node-id>`

为复杂需求增加一个实施阶段子节点。`--depends-on <node-id>` 可重复，默认依赖 `plan`；`--before <node-id>` 可重复，默认让 `verify` 等待该子任务，形成明确汇合边；`--requires-approval` 使该子任务独立进入审批。子节点沿用当前任务锁定的实施技能，产物写入 `artifacts/subtasks/<node-id>.md`。只能修改尚未开始的汇合节点。所有 `task` 子命令均可加 `--project <业务仓库>`，无需先 `cd` 到业务仓库。

```bash
aiw task subtask add task-20260813-111606-115 implement-export \
  --project /path/to/business-repository \
  --title "实现导出文件名" \
  --depends-on plan \
  --before verify \
  --requires-approval
```

### `aiw task run <task-id> <node-id> [--dry-run] [--include <relative-path>]`

使用节点已锁定的技能运行一个已就绪节点；`--dry-run` 仅生成上下文与运行预演，不启动 Codex。

```bash
aiw task run refund-123 clarify
aiw task run refund-123 plan --dry-run
aiw task run refund-123 implement --include docs/api-contract.md
```

| 参数 | 说明 |
|---|---|
| `<task-id>` | 必填。目标任务。 |
| `<node-id>` | 必填。任务图中的节点。 |
| `--dry-run` | 可选。不启动 Codex，只生成 `context.md`、manifest 和预演结果。 |
| `--include <relative-path>` | 可重复。可显式加入项目根目录内的文件；每项必须记录到 manifest。 |

节点仅在 `ready` 且任务模板/技能锁定已提交时可运行。`intake` 不是可运行节点。执行成功后，无需审批的节点进入 `completed`；`clarify`、`plan`、`test` 进入 `awaiting_approval`。`--dry-run` 返回 `succeeded` 预演结果，但不改变任何共享任务事实。

运行前，Runner 必须确认所有默认上游产物、审批文件与状态变化已经提交到当前 Git 分支；否则拒绝运行并列出待提交路径。它还会记录当前 Git 提交与分支；执行期间发生提交、重置或切换分支时，节点失败并保留证据。`task run` 不自动执行 Git 操作。共享 `runs/` 写入 manifest、允许范围、变更路径、允许范围内未跟踪文件的补丁及去敏结果；完整提示词与原始日志位于 `~/.aiw/runtime/`。

失败情形包括：节点不存在或未 `ready`、任务模板/技能锁定未提交或哈希不匹配、任务产物未获批准、附加路径越出项目根目录、上下文超出预算、Codex 不可用或执行失败。

### `aiw task cancel <task-id> <node-id> --note <text>`

正式取消正在运行的节点。命令先写入本机取消请求；若已记录 Codex 子进程，则发送终止信号。当前运行结束后，AIW 保留日志和变更证据，并将节点置为 `cancelled`，不会解锁下游节点。

```bash
aiw task cancel refund-123 implement --note "需求暂停"
```

### `aiw task approve <task-id> <node-id> [--actor <name>] [--note <text>]`

批准一个等待审批的当前节点 revision。

```bash
aiw task approve refund-123 clarify --actor jeffrey --note "验收标准完整"
```

| 参数 | 说明 |
|---|---|
| `--actor <name>` | 可选。审批人的声明性身份；未提供时读取当前仓库的 `git config user.name`，读取失败则拒绝审批。 |
| `--note <text>` | 可选。审批备注。 |

仅当节点处于 `awaiting_approval`，且待审产物**及该等待审批状态**均已提交时可执行。成功后在 `approvals/<node-id>/r<revision>.yaml` 写入不可变审批事实（含产物哈希），并将节点置为 `completed`；调用者必须提交该审批文件与状态变化后，下游节点才可运行。`actor` 仅用于记录，不替代受保护分支、CODEOWNERS、签名提交或 Git 平台 PR 审批。否则失败且不改变状态。

### `aiw task revise <task-id> <node-id> --note <text>`

在非审批场景下退回节点以要求修改，并使所有已开始的下游节点失效。

```bash
aiw task revise refund-123 clarify --note "补充退款权限和异常场景"
```

| 参数 | 说明 |
|---|---|
| `<task-id>` | 必填。目标任务。 |
| `<node-id>` | 必填。需要修订的节点。 |
| `--note <text>` | 必填。写入下一次运行所需的修订说明。 |

节点处于 `awaiting_approval` 时必须使用 `task request-changes`，以记录审批决定。其他可修订节点会在 `revisions/<node-id>/r<next-revision>.md` 写入修改说明，下游已开始节点变为 `invalidated`；当前节点随后自动检查依赖，依赖均已完成时变为 `ready`，否则保持 `pending`。旧产物与历史事件保留，只是不再自动注入后续运行。

### `aiw task fail <task-id> <node-id> --note <text> [--actor <name>]`

将因进程异常、终端中断等原因遗留在 `running` 的节点正式标记为失败。

```bash
aiw task fail refund-123 clarify --note "Codex CLI 异常退出"
aiw task revise refund-123 clarify --note "修复执行环境后重试"
```

仅允许 `running` 节点使用；`--note` 必填，`--actor` 未提供时使用当前仓库的 Git 作者。命令不删除现有上下文、日志或产物，只在 `task.yaml` 中追加失败事件及原因，并将节点置为 `failed`。必须提交该状态变化后，再用 `task revise` 创建可重试的 revision。

### `aiw task request-changes <task-id> <node-id> --note <text> [--actor <name>]`

由审批人对当前 revision 要求修改。

```bash
aiw task request-changes refund-123 plan --actor tech-lead --note "补充数据迁移回滚方案"
git add .aiw && git commit -m "chore(aiw): request plan changes"
```

仅当节点处于 `awaiting_approval`，且待审产物及等待审批状态已提交时可执行。`--note` 必填；`--actor` 的读取规则与 `task approve` 相同。成功后在 `approvals/<node-id>/r<revision>.yaml` 写入 `decision: changes_requested` 及全部产物哈希，在 `revisions/<node-id>/r<next-revision>.md` 写入修改说明，并使已开始下游节点失效；当前节点随后自动检查依赖，依赖均已完成时变为 `ready`，否则保持 `pending`。审批记录、修改说明与状态变化必须提交后才能重新运行。

## 命令与任务状态

| 命令 | 状态影响 |
|---|---|
| `task init` | 创建默认任务图与初始节点状态。 |
| `task source refresh` | 内容变化时创建新的来源 revision，并使已开始下游节点失效。 |
| `task status` | 无。 |
| `task skill rebind` | 显式替换技能锁定，并使已开始下游节点失效。 |
| `task run --dry-run` | 无；仅创建运行预演记录。 |
| `task run` | `ready → running → completed`，或在需要审批时进入 `awaiting_approval`。 |
| `task fail` | `running → failed`，保留失败原因和运行记录。 |
| `task approve` | `awaiting_approval → completed`。 |
| `task request-changes` | 写入审批退回事实与修改说明；当前节点按依赖状态变为 `ready` 或 `pending`，下游已开始节点变为 `invalidated`。 |
| `task revise` | 非审批场景下写入修改说明；当前节点按依赖状态变为 `ready` 或 `pending`，下游已开始节点变为 `invalidated`。 |

节点状态及其完整约束以《任务模型规范》为准；上下文选择与预算以《上下文包规范》为准。
