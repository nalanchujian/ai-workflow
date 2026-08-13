# AI Workflow MVP需求与验收规范

## 目标

交付可在开发者本机运行、以 Git 共享任务事实的 `aiw` CLI。它能安装并锁定声明式团队技能及其上游方法论引用、建立包含来源快照的七阶段任务，并通过可验证的 Codex Adapter 预演或执行节点运行。

本规范定义“必须实现什么、如何验收”；需求范围的来源、已确认取舍和待验证假设见[需求来源与关键决策记录](需求来源与关键决策记录.md)。

## 产品边界与质量约束

- MVP 仅支持开发者本机运行、单 Agent、单节点串行执行。
- 共享任务事实必须由业务仓库读者通过 Git 审阅；敏感运行数据不得进入业务仓库。
- 所有 CLI 成功输出必须可供人阅读；`--json` 时输出单个 JSON 对象到 stdout。
- 所有外部输入必须在信任边界校验；失败不得破坏已有快照、已批准产物、审批事件或历史运行记录。
- 系统必须能够调用已配置的 Codex 执行器，并区分不可用、失败和取消等执行结果。

具体技术栈与验证工具以[MVP版本实施计划](../04-实施规划/MVP版本实施计划.md)为准；共享与本机数据边界以[架构设计](../03-方案设计/01-总体设计/架构设计.md)和[上下文包规范](../03-方案设计/02-核心规范/上下文包规范.md)为准；Codex CLI 的调用约定以[Codex适配器规范](../03-方案设计/03-接入与接口/Codex适配器规范.md)为准。

## 功能需求

### FR-1：CLI 基础

- `aiw --help`、`aiw --version`、`aiw <command> --help` 可用。
- `aiw init` 首次创建带注释的 `~/.aiw/config.yaml` 安全模板；模板仅保留可选连接器配置，不写入凭据、不创建任务文件，也绝不覆盖既有文件。
- 错误命令以非零退出码结束，错误信息写入 stderr。
- `--json` 不能与正常文本混写；进度信息写入 stderr。

### FR-2：技能安装与查询

- `aiw skills install <git-url> [--ref <tag-or-commit>]` 将仓库克隆到用户级缓存目录。
- 安装仅接受含 `skills/<skill-name>/SKILL.md` 或 `profiles/<profile-name>/PROFILE.yaml` 的仓库；两者均无效时失败且不写入 Registry。
- `aiw skills list` 输出已安装技能的名称、版本、来源 URL 与锁定 revision；`aiw skills profiles list` 输出可选工作流模板及其六阶段映射。
- 同一个来源再次安装应更新该来源，而不创建重复 Registry 条目。
- 技能 front matter 必须含 `name`、`version`、`description` 与 `phases`；阶段只能是 `clarify`、`solution`、`plan`、`implement`、`verify` 或 `test`。
- 默认七阶段的技能必须声明至少一个 `methodSources`。新标准技能使用 `bundled:superpowers`，由团队技能包的 `method-sources/` 提供上游方法正文与来源清单；不得要求最终用户安装或配置 Superpowers。
- Registry 与节点锁定记录每项方法论的 ID、来源标识、版本、上游 revision 与 `SKILL.md` SHA-256；用户级 Registry 还保存经校验的内置方法正文，本机绝对路径不进入共享任务事实或运行清单。
- `methodSources` 缺少字段、声明的内置方法或 `SOURCE.yaml` 不存在/不合法、上游 revision 或许可证缺失，或 `SKILL.md` 哈希无法记录时，拒绝整个技能来源安装。`configured:` 仅兼容既有任务锁定。

### FR-3：任务创建、来源快照与刷新

- `aiw task init --project <path> --source <source> --skill-profile <name[@version]>` 以 UTC 日期时间自动生成任务 ID（`task-YYYYMMDD-HHmmss-SSS`），创建 `.aiw/config.yaml`（首次）、`.aiw/tasks/<task-id>/`、`task.yaml`、`task.md` 与首个来源快照；不接受调用者指定任务 ID。
- `--project` 必须是 Git 工作树，且 `.aiw/` 不得被 Git 忽略；不满足时初始化失败且不写入任务事实。
- 本地来源必须是项目目录内的真实普通文件；符号链接、目录、设备文件、FIFO 以及解析后落在项目目录外的路径均必须拒绝，其文本保存为 `sources/<source-id>/r1/snapshot.md`。
- URL 来源仅支持 `http`/`https` 的 `text/plain`、`text/markdown`、`text/html`；HTML 必须转换为纯 Markdown/文本。
- URL 请求必须拒绝回环、私网、链路本地及保留 IP，并限制重定向次数、响应大小与请求超时。
- 已配置 Lark Connector 时，Lark `docx` 文档 URL 必须通过本机 Lark MCP Server 获取；Connector 返回的 Markdown、规范化 URL、文档标识和获取时间形成 `lark-mcp/v1` 快照。MCP 配置、令牌和原始响应不得进入任务事实。
- 快照元数据记录来源类型、来源、revision、获取时间、内容 SHA-256 与提取器版本；不得记录本机绝对路径、Cookie、令牌或授权头。
- 需要团队审批的来源快照必须可由业务仓库读者访问，并通过 Git 提交；敏感来源必须先形成脱敏快照。
- `aiw task source refresh <task-id> <source-id>` 重新读取指定来源；正文哈希未变化时不创建 revision、不改变任务状态；哈希变化时创建新 revision、保留旧快照并递归使已开始下游节点失效。

### FR-4：默认任务图与状态机

- `task init` 必须接收一个已安装的 `--skill-profile <name[@version]>`，原子锁定模板及 `clarify` 至 `test` 六个阶段的技能、Git revision、内容哈希和方法论来源；模板或任一技能不可用时初始化失败且不写入任务目录。
- 模板锁定提交前，`task run` 与 dry-run 均必须拒绝；运行命令不再接收或选择技能。
- `aiw task skill rebind <task-id> <node-id> --skill <name[@version]> --note <text>` 是例外命令，仅允许对待执行或失效节点显式变更单个节点锁定；它记录前后锁定与原因，并递归使已开始下游节点失效。已完成节点必须先修订，待审批节点必须先获得审批决定。
- 节点仅在全部依赖 `completed` 时变为 `ready`；MVP 调度器以任务为粒度持有本机文件锁，一次只允许运行一个节点（包括 dry-run），并发运行必须返回 `TASK_BUSY`。
- 需要审批的 `clarify`、`plan`、`test` 节点，在运行成功后进入 `awaiting_approval`；`solution` 可由高风险任务模板额外设置审批。
- `aiw task approve <task-id> <node-id> [--actor <name>] [--note <text>]` 仅可批准当前 revision 的 `awaiting_approval` 节点；待审产物和当前状态均已提交时，写入绑定全部输出哈希的审批文件并将节点置为 `completed`。未提供 `--actor` 时必须读取 Git 用户名，否则失败。
- `aiw task revise <task-id> <node-id> --note <text>` 写入修改说明并递归将所有已开始下游节点置为 `invalidated`；当前节点随后重新评估，全部依赖已完成时置为 `ready`，否则保持 `pending`。
- `aiw task request-changes <task-id> <node-id> --note <text> [--actor <name>]` 仅用于 `awaiting_approval` 节点。它写入 `decision: changes_requested` 的审批事实、下一 revision 的修改说明并使已开始下游节点失效；当前节点随后按依赖状态重新评估为 `ready` 或 `pending`，不得用 `task revise` 代替该审批决定。
- `aiw task status <task-id>` 显示全部节点状态、依赖、revision、审批与失效原因。

### FR-5：上下文包与运行预演

- `aiw task run <task-id> <node-id> --dry-run` 仅对 `ready` 节点有效；它不调用 Codex。
- Runner 根据七阶段规则生成共享的 `context-manifest.json` 与本机 `context.md`，仅包含被允许、已提交且已确认的任务文件、阶段技能、锁定的方法论来源和用户任务。
- `intake` 不允许通过 `task run` 启动；`clarify`、`solution`、`plan`、`implement`、`verify`、`test` 只允许使用适配其阶段的技能。
- 单次上下文预算默认 12,000 tokens；估算超限必须失败并列出超限文件，不得静默截断。
- `--include <relative-path>` 允许显式增加项目内文件，必须写入 manifest；任务目录外和项目根目录外的路径必须拒绝。
- 下游节点运行前，Runner 必须拒绝未提交的上游产物、审批文件或状态变化；`aiw` 不自动执行 Git 提交、推送或 PR 操作。
- dry-run 输出符合 `aiw.run-result/v1` 的 `RunResult`，状态为 `succeeded`，并列出将传递给 Codex 的参数与上下文文件。

### FR-6：Codex Adapter 执行接口

- `aiw task run <task-id> <node-id>` 使用 `CodexAdapter` 构建请求并启动已配置的 Codex CLI。
- 缺少 Codex 可执行文件时返回 `unavailable`；非零退出码返回 `failed`；取消信号返回 `cancelled`；执行超过默认 15 分钟时必须终止子进程并返回 `failed` / `CODEX_TIMEOUT`。
- 一次运行必须在共享任务事实中保留可审阅的去敏结果，并将完整请求、上下文和原始日志仅保留在本机。
- 只有进程退出码为 0 且节点声明的产物存在于任务目录内，节点才能进入后续状态。

## 非功能需求

- 所有外部输入（CLI、YAML、JSON、Git、文件路径、URL、子进程输出）必须在信任边界校验。
- 来源、技能、用户任务与 Runner 指令在 Agent 上下文中必须以带路径的显式分隔块呈现。
- 任何失败不应破坏已有快照、已批准产物、审批事件或历史运行记录。
- 自动化验证必须隔离真实网络、远程 Git、Lark MCP 和 Codex，不依赖外部服务稳定性。

## 验收场景

本表是 MVP 唯一的产品验收清单。安全、Lark 等专项规范只能引用对应 AC 编号说明其验证重点，不得另行定义产品通过标准。

| ID | 场景 | 通过条件 |
|---|---|---|
| AC-1 | 安装有效技能与工作流模板仓库 | Registry 记录 revision；`skills list` 和 `skills profiles list` 显示对应元数据。 |
| AC-2 | 安装不含有效技能或工作流模板的仓库 | 命令非零退出，Registry 未新增条目。 |
| AC-3 | 从本地 Markdown 建立任务 | 创建七阶段默认 DAG；`intake` 已完成、`clarify` 已就绪；快照含 SHA-256 元数据。 |
| AC-4 | URL 初始地址或重定向地址解析到 `127.0.0.1` 或私网 | 请求在连接前被拒绝，任务目录不创建来源快照。 |
| AC-5 | 未批准澄清节点时运行方案 | 命令失败，提示 `solution` 节点尚未 `ready`。 |
| AC-6 | 批准澄清后修订澄清 | `solution` 至 `test` 被标记 `invalidated`，旧产物保留。 |
| AC-7 | 对可运行的计划节点执行 dry-run | 生成含方法论来源的 manifest 与 `context.md`，不启动子进程。 |
| AC-8 | 上下文超过预算 | 命令失败并列出造成超限的文件；任何文件内容未被截断。 |
| AC-9 | Codex 可执行文件缺失 | 生成 `RunResult(status=unavailable)`，节点转为 `failed`，保留日志。 |
| AC-10 | 安装内置方法缺失、清单不合法或版本不匹配的团队技能 | 命令非零退出，Registry 未新增条目；不读取 Codex 缓存、网络或用户本机目录作为回退。 |
| AC-11 | 下游节点依赖未提交的审批事实 | 命令非零退出并列出待提交路径；不启动 Codex。 |
| AC-12 | 审批当前澄清 revision | 生成含审批人和全部产物 SHA-256 的审批文件；待审批状态或审批文件未提交时 `solution` 不可运行。 |
| AC-13 | 敏感来源未脱敏 | 命令拒绝将正文写入共享 `.aiw/`。 |
| AC-14 | `.aiw/` 被 Git 忽略或项目不是 Git 工作树 | 初始化失败，不创建任务目录。 |
| AC-15 | 从已配置 Lark MCP 读取需求 | 生成 `lark-mcp/v1` Markdown 快照与不含凭据的元数据；`intake` 完成。 |
| AC-16 | Lark MCP 未配置、无权限、超时、正文超限或返回无效正文 | 命令失败，不创建或覆盖快照，不泄露 MCP 配置或令牌。 |
| AC-17 | 刷新 Lark 来源且正文未变化 | 不创建新 revision，任务状态与下游节点不变。 |
| AC-18 | 刷新 Lark 来源且正文变化 | 保留旧快照，创建新 revision；`clarify` 至 `test` 的已开始节点失效。 |
| AC-19 | 本地来源为目录、设备文件或符号链接逃逸 | 初始化失败，不创建来源快照。 |
| AC-20 | `--include` 指向项目根目录外的文件 | 命令失败，Context Manifest 不包含该文件。 |
| AC-21 | 来源或技能正文试图覆盖 Runner 规则 | 渲染的上下文将其标记为不可信数据，Runner 约束与阶段契约保持在前且不被覆盖。 |
| AC-22 | Codex 子进程超时、取消或非零退出 | 超时返回 `failed` / `CODEX_TIMEOUT` 并终止子进程；取消或非零退出正确标识为取消或失败；节点不被标记为成功，已存在的共享事实保留。 |
| AC-23 | Lark 来源进入后续节点运行 | Context Manifest 记录实际使用的快照路径、来源 revision 与 SHA-256，不记录 MCP 配置、令牌或原始响应。 |
| AC-24 | 以工作流模板创建并运行任务 | `task init --skill-profile` 原子写入模板及六阶段精确技能/方法来源锁定；提交前 `task run` 和 dry-run 均拒绝，提交后按节点锁定运行且不再传入技能。 |
| AC-25 | 审批人要求修改当前计划 revision | `task request-changes` 写入含产物哈希的 `changes_requested` 审批记录和下一版修改说明；当前节点按依赖状态重新评估为 `ready` 或 `pending`，已开始下游节点失效，旧产物与审批记录保留。 |

## 完成定义

所有验收场景均有自动化覆盖；项目的测试、静态检查和类型检查通过；README 的命令示例与实际 CLI 一致。具体工具和执行命令以[MVP版本实施计划](../04-实施规划/MVP版本实施计划.md)为准。
