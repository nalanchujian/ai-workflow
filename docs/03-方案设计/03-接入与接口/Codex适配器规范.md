# Codex适配器规范（v1）

## 目的

Codex Adapter 将 Runner 的通用运行请求转换为一次 Codex CLI 调用。它不做任务调度、不解析技能业务逻辑、不直接修改业务代码；这些改动只能由被启动的 Codex 进程在指定工作目录完成。

## 输入：RunRequest

```json
{
  "schemaVersion": "aiw.run/v1",
  "runId": "run_01JABC",
  "task": {
    "id": "refund-123",
    "nodeId": "plan",
    "nodeRevision": 0,
    "projectRoot": "/absolute/path/to/repository"
  },
  "instruction": "为退款功能生成实施计划。",
  "contextManifestPath": "/absolute/path/to/repository/.aiw/tasks/refund-123/runs/run_01JABC/context-manifest.json",
  "runDirectory": "/absolute/path/to/user-home/.aiw/runtime/refund-123/run_01JABC",
  "mode": "execute",
  "artifacts": ["artifacts/implementation-plan.md"]
}
```

Runner 在调用 Adapter 前负责验证所有路径、技能版本、Git 已提交的上下文审批条件和 token 预算。执行模式还必须要求业务工作树干净，记录当前节点的允许变更范围、Git 提交/分支和空工作树基线，并在 Adapter 返回后采集 Git 变更路径、原始 diff 哈希、允许范围内未跟踪文件补丁及变更文件哈希；范围外变更或 Git 历史/分支变化必须保留证据、将节点标记失败，不能进入下一节点。每次成功事件关联 `change-evidence.json`，使实现说明、验证报告可追溯到实际变更。它还必须从本机 Registry 与显式配置的方法来源重新读取节点锁定的 `SKILL.md`，逐项校验 Git revision、技能 SHA-256、方法来源 revision 和 SHA-256；不匹配时拒绝运行，不能使用本机最新版本替代。随后 Runner 将锁定技能、方法正文和 Manifest 对应的文件内容作为**仅在进程内传递的运行上下文**交给 Adapter；这些正文不写入 `request.json`。`projectRoot` 必须存在；`contextManifestPath` 必须位于共享任务目录内；`runDirectory` 必须位于本机 `~/.aiw/runtime/` 内；`mode` 仅能是 `dry-run` 或 `execute`。

## 输出：RunResult

```json
{
  "schemaVersion": "aiw.run-result/v1",
  "runId": "run_01JABC",
  "status": "succeeded",
  "startedAt": "2026-08-11T12:00:00Z",
  "finishedAt": "2026-08-11T12:02:00Z",
  "process": {"exitCode": 0, "signal": null},
  "artifacts": [{"path": "artifacts/implementation-plan.md", "sha256": "<hex>"}],
  "error": null
}
```

`status` 为 `succeeded`、`failed`、`cancelled` 或 `unavailable`。只有 Codex 进程正常退出、声明的产物存在且均位于允许的任务目录内时，才能返回 `succeeded`。`process` 仅记录退出码和信号；`artifacts` 记录路径及 SHA-256。非零退出码返回 `failed`；找不到或无法启动 Codex 返回 `unavailable`；收到取消信号返回 `cancelled`；达到执行超时时间返回 `failed`，错误码为 `CODEX_TIMEOUT`。

## 执行步骤

1. `validate(request)`：验证 schema、路径边界、文件哈希和运行模式。
2. `prepare(request)`：在本机 `runDirectory` 生成只读的 `context.md`，其中包含技能、用户任务和 manifest 列出的文件，并保留路径边界。
3. `execute(request)`：以 `projectRoot` 为工作目录启动 Codex CLI；默认最长运行 15 分钟，超时后先终止子进程，必要时强制终止；将 stdout、stderr 和退出信息写入本机运行目录。
4. `collect(request)`：采集 Git 变更路径，与执行前写入的允许范围比较；超范围时写入 `change-diff.json` 并返回失败，否则校验预期产物并返回去敏 `RunResult`。
5. `cleanup(request)`：仅删除 Adapter 创建的本机临时文件；不得删除任务产物、来源快照或业务代码。

Runner（而非 Adapter）将 Context Manifest 和去敏 `RunResult` 写入业务仓库 `.aiw/tasks/<id>/runs/<run-id>/`；完整请求、`context.md`、标准输出、标准错误和最后消息不得进入共享任务目录。

每次执行还会写入 `change-scope.json`（执行前允许范围）、`change-diff.json`（执行后实际变更路径及违规路径）、`change.patch`（允许范围内未跟踪文本文件的补丁）和 `change-evidence.json`（Git 基线与文件哈希）。`implement` 节点的业务路径必须来自已批准实施计划中的 YAML 片段：

```yaml
allowedPaths:
  - src/refunds/**
  - tests/refunds/**
```

其他节点只允许写入其声明的 `.aiw` 产物；Adapter 传递给 Codex 的产物地址必须是相对于业务仓库根目录的完整路径，例如 `.aiw/tasks/<task-id>/artifacts/brief.md`，不得仅传递 `artifacts/brief.md`。任何范围外路径都会失败。

`plan` 节点还必须在 `implementation-plan.md` 中声明至少一个机器可读的后续实施范围：

```yaml
allowedPaths:
  - src/example/**
```

路径必须相对于业务仓库根目录，且不得使用占位路径、`.aiw/`、绝对路径或 `..`。Adapter 将这项要求放在最高优先级运行约束中；缺失时 Runner 拒绝该计划，避免实施节点在没有明确范围的情况下执行。

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
- 用户可在修正环境或输入后重新运行；新的运行使用新的 `runId`，不覆盖旧记录。
- Adapter 超时或收到取消时必须终止其启动的子进程并记录信号；超时固定映射为 `failed` / `CODEX_TIMEOUT`，不得将节点错误标为成功。
- Adapter 不得把完整来源、凭据、环境变量或未授权文件写入 `request.json`、日志或终端输出。

## 兼容边界

Adapter 是唯一了解 Codex CLI 具体命令、参数或原生技能加载机制的模块。若 Codex 的集成方式变化，只修改 Adapter；任务模型、上下文包、技能目录和 Runner 的 `RunRequest` 契约保持不变。
