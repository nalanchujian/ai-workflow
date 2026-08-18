# MVP 版本实施计划

## 目标

完成一个本机、Git 原生的 AI 研发工作流 CLI：从需求来源开始，经过澄清、方案、计划，最终由多个可独立审批的业务交付单元完成代码、工程验证、测试和验收。

## 已完成能力

1. CLI 基础：`init`、`doctor`、技能安装/升级、任务创建、状态、运行历史和安全清理。
2. 任务事实：任务 DAG、来源快照、版本化产物、Handoff、决策、审批和运行证据均保存到 `.aiw/`。
3. 来源接入：本地文件、公开 URL 和经规则路由的受控文档连接器（当前 Lark MCP）。
4. 技能与方法：独立团队技能仓库、模板锁定、内置 Superpowers 方法来源、版本和哈希校验。
5. 任务治理：逐项需求决策、外部等待、来源刷新、下游失效、重跑 revision、风险接受。
6. Codex 执行：受控 Context Manifest、最小子进程环境、Git 基线/Diff/补丁证据与产物校验。
7. 交付单元：计划审批后为每个业务单元生成 `delivery-<unit-id>`；单元在一次运行内完成开发、工程验证、测试和验收，不再执行全局 `verify`、`test`。

## 当前实施顺序

### 1. 领域与契约

- 固定主干为 `intake → clarify → solution → plan`；
- 计划生成 `delivery-<unit-id>`，每个 AC 唯一归属；
- 用集成交付单元表达跨单元验收；
- 删除全局 `verify`、`test` 阶段及对应技能契约。

### 2. 执行与上下文

- 为每个单元生成隔离上下文；
- 默认只注入计划 Handoff、当前单元上下文和直接依赖 Handoff；
- 保留完整 Markdown 供审计，禁止将其默认汇总到末端节点；
- 运行前核验来源、上游产物和审批哈希，运行后保存 Diff 证据。

### 3. 用户体验

- `status` 显示业务单元名称而非内部 `implement` 锚点；
- `run` 是统一执行与重跑入口；
- `review` 专用于需求澄清；`approve` 专用于计划和交付单元；
- `close-with-risk` 仅作用于一个交付单元。

### 4. 验证

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
git diff --check
```

重点覆盖：单单元和多单元计划、依赖单元交接、唯一 AC 归属、阻塞/重跑、风险接受、来源/产物哈希失配以及端到端的计划→交付单元闭环。

## 发布前置条件

- `ai-workflow-skills` 发布 `standard-web-feature@11.0.0` 并创建 Git tag `v11.0.0`；
- `ai-workflow` 发布包含该默认工作流的新版 npm 包；
- 旧七阶段任务不与新模型混用，升级后重新创建任务。
