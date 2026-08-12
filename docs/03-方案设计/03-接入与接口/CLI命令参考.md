# CLI 命令参考（MVP）

## 约定

- 命令名为 `aiw`。
- 常规模式输出面向人阅读的结果；`--json` 时 stdout 仅输出一个 JSON 对象，进度与诊断写入 stderr。
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

## 技能命令

### `aiw skills install <git-url> [--ref <tag-or-commit>]`

从 Git 来源安装技能到用户级缓存并记录锁定 revision。

```bash
aiw skills install git@github.com:your-org/agent-skills.git
aiw skills install https://github.com/your-org/agent-skills.git --ref v1.2.0
```

| 参数 | 说明 |
|---|---|
| `<git-url>` | 必填。Git 仓库地址。 |
| `--ref <tag-or-commit>` | 可选。要锁定的 tag 或 commit；未指定时使用来源默认分支解析到的 commit。 |

成功时显示来源、锁定 revision 与已安装技能。相同来源再次安装时更新该来源记录，而不创建重复条目。

失败情形包括：Git 来源不可访问、指定 ref 不存在、仓库不含有效技能，或任一技能不符合《技能包规范》。失败时 Registry 保持不变。

### `aiw skills list`

列出已安装技能。

```bash
aiw skills list
aiw skills list --json
```

每项至少包含技能名称、版本、来源 URL 和锁定 revision。未安装任何技能时，常规模式显示空结果，`--json` 返回空列表。

## 任务命令

### `aiw task init <task-id> --project <path> --source <source>`

在目标项目创建任务、来源快照和默认任务图。

```bash
aiw task init refund-123 --project . --source ./requirements.md
aiw task init refund-123 --project /workspace/shop --source https://example.com/requirements
aiw task init refund-123 --project . --source https://<tenant>.larksuite.com/docx/<token>
```

| 参数 | 说明 |
|---|---|
| `<task-id>` | 必填。匹配 `[a-z][a-z0-9-]{1,63}`，且在项目内唯一。 |
| `--project <path>` | 必填。业务项目根目录。 |
| `--source <source>` | 必填。本地文件、符合安全规则的公开 HTTP(S) 来源，或由已配置 Lark Connector 识别的 Lark `docx` 文档 URL。 |

成功后创建 `.aiw/config.yaml`（首次）、`.aiw/tasks/<task-id>/`、`task.yaml`、`task.md` 和 `sources/<source-id>/r1/snapshot.md`。Lark URL 由本机已配置的 Lark MCP Server 读取；MCP 配置、令牌和原始响应不写入任务目录。这些任务事实必须由调用者按既有 Git 流程提交后，才可作为后续节点的共享依据。默认节点为：

```text
intake → clarify → solution → plan → implement → verify → test
```

来源快照成功后，`intake` 自动完成，`clarify` 成为 `ready`。`clarify`、`plan`、`test` 完成执行后等待人工审批；`intake` 不允许通过 `task run` 运行。

失败情形包括：任务 ID 非法或重复、项目路径无效或不是 Git 工作树、`.aiw/` 被 Git 忽略、来源是目录、URL 不符合协议或 IP 安全限制、Lark Connector 未配置或无权限、来源类型不受支持。失败不得留下不完整来源快照。

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

### `aiw task run <task-id> <node-id> --skill <name> [--dry-run] [--include <relative-path>]`

使用指定技能运行一个已就绪节点；`--dry-run` 仅生成上下文与运行预演，不启动 Codex。

```bash
aiw task run refund-123 clarify --skill requirements-clarification
aiw task run refund-123 plan --skill implementation-planning --dry-run
aiw task run refund-123 implement --skill implementation --include docs/api-contract.md
```

| 参数 | 说明 |
|---|---|
| `<task-id>` | 必填。目标任务。 |
| `<node-id>` | 必填。任务图中的节点。 |
| `--skill <name>` | 必填。必须解析为节点记录的名称、版本、内容哈希和上游方法论来源，且适用于该节点阶段。 |
| `--dry-run` | 可选。不启动 Codex，只生成 `context.md`、manifest 和预演结果。 |
| `--include <relative-path>` | 可重复。可显式加入项目根目录内的文件；每项必须记录到 manifest。 |

节点仅在 `ready` 时可运行。`intake` 不是可运行节点。执行成功后，无需审批的节点进入 `completed`；`clarify`、`plan`、`test` 进入 `awaiting_approval`。`--dry-run` 返回 `succeeded` 预演结果，但不改变节点执行状态。

运行前，Runner 必须确认所有默认上游产物、审批文件与状态变化已经提交到当前 Git 分支；否则拒绝运行并列出待提交路径。`task run` 不自动执行 Git 操作。共享 `runs/` 仅写入 manifest 和去敏结果，完整提示词与原始日志位于 `~/.aiw/runtime/`。

失败情形包括：节点不存在或未 `ready`、技能不存在或版本不匹配、任务产物未获批准、附加路径越出项目根目录、上下文超出预算、Codex 不可用或执行失败。

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

退回节点以要求修改，并使所有已开始的下游节点失效。

```bash
aiw task revise refund-123 clarify --note "补充退款权限和异常场景"
```

| 参数 | 说明 |
|---|---|
| `<task-id>` | 必填。目标任务。 |
| `<node-id>` | 必填。需要修订的节点。 |
| `--note <text>` | 必填。写入下一次运行所需的修订说明。 |

成功后当前节点变为 `pending`，下游已开始节点变为 `invalidated`；旧产物与历史事件保留，只是不再自动注入后续运行。

## 命令与任务状态

| 命令 | 状态影响 |
|---|---|
| `task init` | 创建默认任务图与初始节点状态。 |
| `task source refresh` | 内容变化时创建新的来源 revision，并使已开始下游节点失效。 |
| `task status` | 无。 |
| `task run --dry-run` | 无；仅创建运行预演记录。 |
| `task run` | `ready → running → completed`，或在需要审批时进入 `awaiting_approval`。 |
| `task approve` | `awaiting_approval → completed`。 |
| `task revise` | 当前节点变为 `pending`，下游已开始节点变为 `invalidated`。 |

节点状态及其完整约束以《任务模型规范》为准；上下文选择与预算以《上下文包规范》为准。
