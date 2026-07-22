---
name: change-review
description: 读取最终 diff、提交记录、验证报告和方案产物，执行提交前变更审查并输出必须修复项、可接受风险和完成建议。
---

# 变更评审

任务目录统一写作 `<tasks-root>/<task-id>`；只读取 `task.yaml` 校验准入，不得直接创建、修改或替换它。节点只原子写入本节点产物并向 `$workflow-orchestrator` 报告结果；普通状态由 `workflow-orchestrator` actor 推进，人工 Gate 仅在用户原样提交精确确认指令后由 `workflow-owner` actor 决策，状态处理遵循 [任务生命周期指南](../workflow-orchestrator/references/guides/task-lifecycle.md)。产物结构必须符合 [节点产物 Schema](../workflow-orchestrator/references/contracts/node-artifact.schema.json)，Markdown 正文遵循 [统一产物结构](../workflow-orchestrator/references/four-section-artifact-template.md)和[本节点输出模板](references/output-template.md)，重跑时遵循 [节点重跑指南](../workflow-orchestrator/references/guides/node-rerun.md)，代码身份遵循 [交付证据指南](../workflow-orchestrator/references/guides/delivery-evidence.md)。

在提交前独立审查最终差异是否超出已批准范围，以及是否存在回归、权限、数据或维护风险。

## 输入

用户必须提供任务目录。读取 `task.yaml`、`quality-verification.md`、当前路径实施依据，以及由 `base_commit`、`candidate_tree` 和 `change_fingerprint` 冻结的最终 Git 变更集；提交已经存在时可同时读取提交记录。默认只审查，不修改业务代码。

## 执行

1. 对照实施计划或执行摘要，检查实际改动是否超范围。
2. 审查请求重复、竞态、状态同步、表单回填、接口映射、权限和错误处理。
3. 审查公共组件覆盖、全局样式污染、死代码、临时开关和无效兼容逻辑。
4. 检查验证覆盖、已知风险、回滚条件和提交前置要求。
5. 重新生成并比对质量验证记录的交付代码指纹；Review 期间发生任何代码变化时，开发实现、质量验证和变更评审的证据链全部失效，必须退回开发实现并顺序重跑质量验证和变更评审。

## 输出

按 [references/output-template.md](references/output-template.md) 写入 `<tasks-root>/<task-id>/change-review.md`：结果写评审结论、发现数量和代码一致性，交付写审查范围、发现项、一致性检查与代码身份，未决项写剩余风险和责任节点，交接写修复建议或终点 Gate 含义。完成后报告结果给编排器。

结论为“通过”且交付代码指纹一致时，在产物中写入评审结论并报告交付证据；编排器调用 `record-result --gate-owner workflow-owner` 登记变更评审产物并创建终点 pending gate。只有 `workflow-owner` 确认最终评审结果后，状态 CLI 才将任务写为 `completed` 且 `next_node: null`。代码变化、“修复后通过”或实现问题报告为 blocker 并退回开发实现；仅验证证据不足且代码未变时退回质量验证；“拒绝完成”按责任节点阻断。

发现阻断问题时退回开发实现或质量验证；不提交、不推送。

## 调用方式

```text
使用 $change-review
任务目录：`<tasks-root>/<task-id>`
```
