# AI Workflow

`aiw`（AI Workflow）是一个本地 CLI：团队可通过 Git 共享声明式 `SKILL.md` 技能，将复杂需求拆成可审阅的子任务，并调用 Codex CLI 完成分析、设计、实现和验证。

## 目标

- 团队通过 Git 共享、评审和版本化开发技能。
- 复杂任务可拆成有依赖的子任务，并在关键阶段等待人工确认。
- 每个阶段只向 Codex 提供最小、已确认的上下文。
- 业务代码、任务资料和运行记录默认保留在开发者本机。

## 非目标（MVP）

- 不构建云端调度、账号体系或多 Agent 协作平台。
- 不自动选择技能，也不执行技能包携带的任意脚本。
- 不保存完整聊天记录，或在未授权时读取需要登录的在线文档。

## 预期使用方式

```bash
aiw install git@github.com:your-org/agent-skills.git
aiw task init req-123 --source https://example.com/requirements
aiw task analyze req-123 --skill requirements-analysis
aiw approve req-123 analysis
aiw task run req-123 implementation --skill implementation
```

这些命令仍在设计阶段，尚未实现。

## 当前状态

项目处于设计审阅阶段。框架实现将在架构设计中列出的状态失效、上下文产物、URL 抓取安全和 Codex Adapter 契约明确后开始。

## 文档

- [架构设计](docs/superpowers/specs/2026-08-11-agent-skill-orchestrator-design.md)

## 计划中的目录

```text
src/        # aiw CLI、任务编排和 Codex 适配器
skills/     # 示例声明式技能
docs/       # 设计与实施文档
tests/      # 单元和端到端测试
```
