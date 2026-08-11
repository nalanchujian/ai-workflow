# Codex Adapter 契约（v1）

## 目的

Codex Adapter 将 Runner 的通用运行请求转换为一次 Codex CLI 调用。它不做任务调度、不解析技能业务逻辑、不直接修改业务代码；这些改动只能由被启动的 Codex 进程在指定工作目录完成。

## 输入：RunRequest

```json
{
  "schemaVersion": "aiw.run/v1",
  "runId": "run_01JABC",
  "task": {
    "id": "refund-123",
    "nodeId": "design",
    "nodeRevision": 0,
    "projectRoot": "/absolute/path/to/repository"
  },
  "instruction": "为退款功能生成实施计划。",
  "skill": {
    "name": "architecture-design",
    "version": "1.0.0",
    "contentPath": "/absolute/path/to/SKILL.md",
    "sha256": "<hex>"
  },
  "contextManifestPath": "/absolute/path/to/context-manifest.json",
  "runDirectory": "/absolute/path/to/.aiw/tasks/refund-123/runs/run_01JABC",
  "mode": "execute"
}
```

Runner 在调用 Adapter 前负责验证所有路径、技能版本、上下文审批条件和 token 预算。`projectRoot` 必须存在；`runDirectory` 必须位于任务目录内；`mode` 仅能是 `dry-run` 或 `execute`。

## 输出：RunResult

```json
{
  "schemaVersion": "aiw.run-result/v1",
  "runId": "run_01JABC",
  "status": "succeeded",
  "startedAt": "2026-08-11T12:00:00Z",
  "finishedAt": "2026-08-11T12:02:00Z",
  "process": {"exitCode": 0, "signal": null},
  "artifacts": ["artifacts/plan.md"],
  "error": null
}
```

`status` 为 `succeeded`、`failed`、`cancelled` 或 `unavailable`。只有 Codex 进程正常退出、声明的产物存在且均位于允许的任务目录内时，才能返回 `succeeded`。非零退出码返回 `failed`；找不到或无法启动 Codex 返回 `unavailable`；收到取消信号返回 `cancelled`。

## 执行步骤

1. `validate(request)`：验证 schema、路径边界、文件哈希和运行模式。
2. `prepare(request)`：在 `runDirectory` 生成只读的 `context.md`，其中包含技能、用户任务和 manifest 列出的文件，并保留路径边界。
3. `execute(request)`：以 `projectRoot` 为工作目录启动 Codex CLI；将 stdout、stderr 和退出信息写入运行目录。
4. `collect(request)`：校验预期产物并写入 `result.json`。
5. `cleanup(request)`：仅删除 Adapter 创建的临时文件；不得删除任务产物、来源快照或业务代码。

`dry-run` 只执行第 1、2 步并输出将要执行的 Codex 调用，绝不启动 Codex。

## Codex CLI 调用（MVP）

Adapter 将 `AIW_CODEX_BIN` 解析为可执行文件；变量未设置时使用 `codex`。执行模式下，它必须以如下形式启动非交互式会话：

```text
<AIW_CODEX_BIN|codex> exec
  --cd <projectRoot>
  --sandbox workspace-write
  --ask-for-approval never
  --output-last-message <runDirectory>/last-message.md
  -
```

`context.md` 通过 stdin 传递，因为末尾 `-` 指示 Codex 从 stdin 读取初始指令。`workspace-write` 将 Agent 写入范围限制为项目工作目录；`never` 仅适用于用户显式运行的 `aiw task run`，并且不得替换为绕过 sandbox 的参数。Adapter 必须将实际二进制路径、参数和运行模式写入 `request.json`。

## 失败与恢复

- Runner 将 `failed`、`cancelled` 或 `unavailable` 映射为节点 `failed`，保留运行记录。
- 用户可在修正环境或输入后重新运行；新的运行使用新的 `runId`，不覆盖旧记录。
- Adapter 超时或收到取消时必须终止其启动的子进程并记录信号；不得将节点错误标为成功。
- Adapter 不得把完整来源、凭据、环境变量或未授权文件写入 `request.json`、日志或终端输出。

## 兼容边界

Adapter 是唯一了解 Codex CLI 具体命令、参数或原生技能加载机制的模块。若 Codex 的集成方式变化，只修改 Adapter；任务模型、上下文包、技能目录和 Runner 的 `RunRequest` 契约保持不变。
