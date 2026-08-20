# Codex适配器规范（v1）

## 目的

Codex Adapter 将 Runner 的通用运行请求转换为一次 Codex CLI 调用。它不做任务调度、不解析技能业务逻辑、不直接修改业务代码；这些改动只能由被启动的 Codex 进程在指定工作目录完成。

## 输入：RunRequest

```json
{
  "schemaVersion": "aiw.run/v2",
  "runId": "run_01JABC",
  "task": {
    "id": "refund-123",
    "nodeId": "plan",
    "projectRoot": "/absolute/path/to/repository"
  },
  "instruction": "为退款功能生成实施计划。",
  "contextManifestPath": "/absolute/path/to/repository/.aiw/tasks/refund-123/runs/run_01JABC/context-manifest.json",
  "runDirectory": "/absolute/path/to/user-home/.aiw/runtime/refund-123/run_01JABC",
  "mode": "execute",
  "artifacts": ["artifacts/plan/implementation-plan.md", "artifacts/plan/work-breakdown.yaml", "handoffs/plan.yaml"],
  "outputContract": {
    "schemaVersion": "aiw.task-output/v1",
    "entries": [{
      "finalPath": "artifacts/plan/implementation-plan.md",
      "stagingPath": "runs/run_01JABC/staging/artifacts/plan/implementation-plan.md",
      "writer": "codex"
    }]
  }
}
```

Runner 在调用 Adapter 前负责验证所有路径、技能版本、Git 已提交的上下文审批条件和 token 预算。执行模式还必须要求业务工作树干净，记录 Git 提交/分支和空工作树基线，以及当前节点的任务事实写入边界；Adapter 返回后采集全部 Git 变更路径、原始 diff 哈希、未跟踪文件补丁及变更文件哈希。业务代码和测试可按当前节点目标修改，不通过计划中的文件路径白名单阻断；但写入其他 `.aiw/` 任务事实、修改 Git 历史或切换分支必须保留证据、将节点标记失败，不能进入下一节点。检测到未授权 `.aiw/` 写入时，Runner 先将该文件恢复为交给 Codex 前的内容，再记录违规路径和恢复记录，避免当前任务事实被污染。每次成功事件关联 `change-evidence.json`，使实现说明、验证报告可追溯到实际变更。它还必须从本机 Registry 与显式配置的方法来源重新读取节点锁定的 `SKILL.md`，逐项校验 Git revision、技能 SHA-256、方法来源 revision 和 SHA-256；不匹配时拒绝运行，不能使用本机最新版本替代。随后 Runner 将锁定技能、方法正文和 Manifest 对应的文件内容作为**仅在进程内传递的运行上下文**交给 Adapter；这些正文不写入 `request.json`。`projectRoot` 必须存在；`contextManifestPath` 必须位于共享任务目录内；`runDirectory` 必须位于本机 `~/.aiw/runtime/` 内；`mode` 仅能是 `dry-run` 或 `execute`。

## 输出：RunResult

```json
{
  "schemaVersion": "aiw.run-result/v1",
  "runId": "run_01JABC",
  "status": "succeeded",
  "startedAt": "2026-08-11T12:00:00Z",
  "finishedAt": "2026-08-11T12:02:00Z",
  "process": {"exitCode": 0, "signal": null},
  "artifacts": [{"path": "artifacts/plan/implementation-plan.md", "sha256": "<hex>"}],
  "error": null
}
```

`status` 为 `succeeded`、`failed`、`cancelled` 或 `unavailable`。只有 Codex 进程正常退出、声明的产物存在且均位于允许的任务目录内时，才能返回 `succeeded`。`process` 仅记录退出码和信号；`artifacts` 记录路径及 SHA-256。非零退出码返回 `failed`；找不到或无法启动 Codex 返回 `unavailable`；收到取消信号返回 `cancelled`；达到执行超时时间返回 `failed`，错误码为 `CODEX_TIMEOUT`。

## 执行步骤

1. `validate(request)`：验证 schema、路径边界、文件哈希和运行模式。
2. `prepare(request)`：在本机 `runDirectory` 生成只读的 `context.md`，其中包含技能、用户任务和 manifest 列出的文件，并保留路径边界。
3. `execute(request)`：以 `projectRoot` 为工作目录启动 Codex CLI；默认最长运行 15 分钟，超时后先终止子进程，必要时强制终止；将 stdout、stderr 和退出信息写入本机运行目录。
4. `collect(request)`：采集全部 Git 变更路径、未跟踪文件补丁和变更文件哈希；校验 Git 历史、分支以及 `.aiw/` 任务事实写入边界，随后校验预期产物并返回去敏 `RunResult`。
5. `cleanup(request)`：仅删除 Adapter 创建的本机临时文件；不得删除任务产物、来源快照或业务代码。

Runner（而非 Adapter）将 Context Manifest 和去敏 `RunResult` 写入业务仓库 `.aiw/tasks/<id>/runs/<run-id>/`；完整请求、`context.md`、标准输出、标准错误和最后消息不得进入共享任务目录。

每次执行还会写入 `change-scope.json`（执行前的 Agent 可写产物与平台专属事实边界）、`agent-task-fact-baseline.json`（交给 Codex 前的 `.aiw/` 哈希快照）、`change-diff.json`（执行后实际变更路径、非法任务事实写入及自动恢复路径）、`change.patch`（全部未跟踪文本文件的补丁）和 `change-evidence.json`（Git 基线、文件哈希及 Agent 实际改写的 `.aiw/` 路径）。实施节点可以修改完成当前目标所需的任意业务代码和测试；计划与工作单元应说明目标、验收、依赖、步骤和验证方式，而不是穷举文件路径。

Adapter 传递给 Codex 的任务产物地址必须来自本次 `outputContract`，不得仅传递逻辑名。正式产物路径和暂存路径均由 Runner 唯一生成；技能正文不拥有、也不得推断任何物理路径。技能内容之后必须追加“输出回执”，只列出本次运行的精确**暂存路径**、对应正式路径和写入者，以覆盖旧技能中可能存在的固定路径示例。Codex 只能写入回执中 `writer: codex` 的暂存文件；`test-results.yaml` 等 `writer: aiw` 文件由平台专属生成。Codex 退出后，Runner 先校验所有暂存产物、测试证据和 Handoff，再以原子方式发布并覆盖正式当前结果；校验失败时正式产物保持不变，暂存内容作为本次运行证据保留。`task.yaml`、审批、决策事实、运行证据和项目配置均只由 AIW 写入。Runner 在启动 Codex 后对整个 `.aiw/` 建立内容快照；任何越权写入均会自动还原、使节点失败并保留运行证据。

结构化产物格式同样不能在 Adapter 或技能中手写。每类 Agent 产物由一个程序化协议描述符绑定：唯一 Zod Schema、经过该 Schema 校验的示例和必要语义规则。Adapter 只按节点选择协议，并从 Zod JSON Schema 生成紧凑字段树、从已校验对象生成 YAML 示例；字段、枚举或 Schema 版本变化只修改协议源，提示词随程序生成。物理路径仍由当前 `outputContract` 单独注入，协议示例不能成为路径指令。

当前协议注册表覆盖正式事实登记、验收清单、待确认决策、工作单元声明、交付验收意图和结构化 Handoff。新增结构化产物时必须先新增 Zod Schema 和协议描述符，再由 Adapter 引用；禁止先在提示词或技能中增加独立字段说明。

验收证据映射同样属于平台约束。`clarify` 请求要求每个 AC 声明证据类型；`plan` 请求只暴露项目已声明的测试能力及其 `evidenceTypes`，并要求固定 profile、targets、evidenceType 与 acceptanceRefs。交付请求只下发批准后的映射；Codex 不得在 `acceptance-intent.yaml` 中填写测试引用。Runner 执行测试后逐字段核对测试记录与批准映射，防止交付阶段将浏览器、组件、契约或集成验收替换成更弱的单元测试。

Handoff 是摘要而不是新的事实来源：其中 `facts[].id` 必须复用正式事实登记中的 `FACT-*`，`decisions[].id` 必须是 AIW 已登记的 `DEC-*`，并引用对应的 `decisions/<DEC-id>.yaml`。Adapter 不得引导 Codex 将尚未确认的候选方案写成 Handoff 决策。

除非用户任务明确要求其他语言，Adapter 要求所有 Markdown 任务产物使用简体中文；代码标识、命令、路径、API 名称和必须保留的原文保持原始语言。上游方法论可以是英文，但不能改变该产物语言约束。

`dry-run` 只执行第 1、2 步，生成本机 `context.md`、`request.json` 和共享 Context Manifest，绝不启动 Codex。默认 CLI 仅展示预演结果摘要；完整调用参数只保留在本机 `request.json`。

## Codex CLI 调用（MVP）

Adapter 将 `AIW_CODEX_BIN` 解析为可执行文件；变量未设置时使用 `codex`。执行模式下，它必须以如下形式启动非交互式会话：

```text
<AIW_CODEX_BIN|codex> exec
  --cd <projectRoot>
  --approve-for-me
  --output-last-message <runDirectory>/last-message.md
  -
```

`context.md` 通过 stdin 传递，因为末尾 `-` 指示 Codex 从 stdin 读取初始指令。`--approve-for-me` 仅适用于用户显式运行的 `aiw task run`；当前 Codex CLI 会在该模式下使用 `workspace-write`，且不允许再显式传入 `--sandbox workspace-write`。Adapter 不得替换为绕过 sandbox 的参数。Adapter 必须将实际二进制路径、参数和运行模式写入本机 `request.json`；共享任务目录只记录去敏摘要。

## 失败与恢复

- Runner 将 `failed` 或 `unavailable` 映射为节点 `failed`；`cancelled` 映射为节点 `cancelled`。两类结果均保留运行记录；提交取消记录后，可通过同一条 `task run` 重新执行非 `intake` 节点。
- 若下一次命令已成功取得任务执行锁，但目标节点仍为 `running`，说明上次 AIW 进程已异常退出。Runner 必须自动记录 `fail` 事件并将节点置为 `failed`，返回 `RUN_RECOVERED`；不得继续启动新的 Codex。用户提交失败证据后可直接再次执行同一 `task run`。
- 用户可在修正环境或输入后重新运行；新的运行使用新的 `runId`。对已完成节点重跑时，Runner 会在校验通过后覆盖当前产物、交接和审批事实；各次运行日志与证据仍留在对应的运行目录。
- Adapter 超时或收到取消时必须终止其启动的子进程并记录信号；超时固定映射为 `failed` / `CODEX_TIMEOUT`，不得将节点错误标为成功。
- Adapter 不得把完整来源、凭据、环境变量或未授权文件写入 `request.json`、日志或终端输出。

## 兼容边界

Adapter 是唯一了解 Codex CLI 具体命令、参数或原生技能加载机制的模块。若 Codex 的集成方式变化，只修改 Adapter；任务模型、上下文包、技能目录和 Runner 的 `RunRequest` 契约保持不变。
