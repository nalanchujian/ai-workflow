# ADR-001：采用 TypeScript、Node.js 与 pnpm

- 状态：已接受
- 日期：2026-08-11

## 背景

AI Workflow 是本地 CLI，需要可靠处理 YAML/JSON、文件系统、Git、HTTP/DNS 和外部 Codex 子进程，同时需要便捷的跨平台分发和快速的单元测试。仓库尚无既有技术栈。

## 决策

MVP 使用 Node.js 22+ 和 TypeScript 严格模式实现，使用 pnpm 管理依赖与 lockfile。CLI 使用 Commander；边界数据使用 Zod 校验；测试使用 Vitest；YAML 使用 `yaml` 包解析。所有生产代码位于 `src/`，测试位于 `tests/`。

## 理由

- Node 的标准库直接覆盖文件、路径、加密、子进程、DNS 与 HTTP 所需能力。
- TypeScript 可将任务状态、上下文 manifest 与 Adapter 请求/结果在编译期关联，减少跨层数据契约错误。
- pnpm 使用确定性 lockfile 且适合 CLI 项目的快速安装与脚本管理。
- Commander、Zod、Vitest 和 YAML 解析库均为小而独立的依赖，符合 MVP 的边界。

## 后果

- 贡献者必须安装 Node.js 22+ 和 pnpm，并通过 `pnpm lint`、`pnpm typecheck`、`pnpm test` 验证变更。
- 外部接口优先使用 JSON/YAML schema，避免把 Node 运行时类型泄漏到领域模型。
- Codex Adapter 将 Node 的 `child_process` 封装在 `ProcessRunner` port 后，便于测试替身和未来替换。

## 被拒绝的替代方案

- **Python**：适合文本处理，但会引入单独的虚拟环境、打包与类型校验方案；对本 MVP 没有超过 Node 标准库的必要收益。
- **Go**：便于生成单一二进制文件，但实现 YAML、CLI 测试替身与快速迭代的初始成本更高。
- **直接脚本化 Shell**：难以表达任务状态机、路径边界与可替换的网络/进程端口，因此不满足可测试性要求。

## 重新评估条件

当需要原生单文件分发、长期后台守护进程、超过单机规模的并发调度，或 Node 的安全沙箱能力无法满足需求时，重新评估该技术栈。
