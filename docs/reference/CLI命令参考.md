# CLI 命令参考（MVP）

## 约定

- 命令名为 `aiw`。
- 常规模式输出面向人阅读的结果；`--json` 时 stdout 仅输出一个 JSON 对象，进度与诊断写入 stderr。
- 所有失败均以非零退出码结束，错误信息写入 stderr；MVP 不承诺稳定的细分退出码。
- 路径参数必须通过真实路径校验；任务运行状态只写入项目根目录的 `.aiw/`，不得提交到 Git。
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

### `aiw task init <task-id> --project <path> --source <file-or-url>`

在目标项目创建任务、来源快照和默认任务图。

```bash
aiw task init refund-123 --project . --source ./requirements.md
aiw task init refund-123 --project /workspace/shop --source https://example.com/requirements
```

| 参数 | 说明 |
|---|---|
| `<task-id>` | 必填。匹配 `[a-z][a-z0-9-]{1,63}`，且在项目内唯一。 |
| `--project <path>` | 必填。业务项目根目录。 |
| `--source <file-or-url>` | 必填。本地文件或符合安全规则的公开 HTTP(S) 来源。 |

成功后创建 `.aiw/tasks/<task-id>/`、`task.yaml`、`task.md` 和 `sources/<source-id>/snapshot.md`。默认节点为 `intake → analysis → design → implementation → testing`。

失败情形包括：任务 ID 非法或重复、项目路径无效、来源是目录、URL 不符合协议或 IP 安全限制、来源类型不受支持。失败不得留下不完整来源快照。

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
aiw task run refund-123 analysis --skill requirements-analysis
aiw task run refund-123 design --skill architecture-design --dry-run
aiw task run refund-123 implementation --skill implementation --include docs/api-contract.md
```

| 参数 | 说明 |
|---|---|
| `<task-id>` | 必填。目标任务。 |
| `<node-id>` | 必填。任务图中的节点。 |
| `--skill <name>` | 必填。必须解析为节点记录的名称、版本和内容哈希，且适用于该节点阶段。 |
| `--dry-run` | 可选。不启动 Codex，只生成 `context.md`、manifest 和预演结果。 |
| `--include <relative-path>` | 可重复。可显式加入项目根目录内的文件；每项必须记录到 manifest。 |

节点仅在 `ready` 时可运行。执行成功后，无需审批的节点进入 `completed`；需要审批的节点进入 `awaiting_approval`。`--dry-run` 返回 `succeeded` 预演结果，但不改变节点执行状态。

失败情形包括：节点不存在或未 `ready`、技能不存在或版本不匹配、任务产物未获批准、附加路径越出项目根目录、上下文超出预算、Codex 不可用或执行失败。

### `aiw task approve <task-id> <node-id>`

批准一个等待审批的当前节点 revision。

```bash
aiw task approve refund-123 analysis
```

仅当节点处于 `awaiting_approval` 时可执行。成功后写入不可变审批事件，并将节点置为 `completed`；否则失败且不改变状态。

### `aiw task revise <task-id> <node-id> --note <text>`

退回节点以要求修改，并使所有已开始的下游节点失效。

```bash
aiw task revise refund-123 analysis --note "补充退款权限和异常场景"
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
| `task status` | 无。 |
| `task run --dry-run` | 无；仅创建运行预演记录。 |
| `task run` | `ready → running → completed`，或在需要审批时进入 `awaiting_approval`。 |
| `task approve` | `awaiting_approval → completed`。 |
| `task revise` | 当前节点变为 `pending`，下游已开始节点变为 `invalidated`。 |

节点状态及其完整约束以《任务模型规范》为准；上下文选择与预算以《上下文包规范》为准。
