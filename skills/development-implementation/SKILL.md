---
name: development-implementation
description: 读取当前路径已满足准入的实施依据完成代码改动和基础自测，并将实际变更、验证结果和遗留风险写入开发记录。
---

# 开发实现

任务目录统一写作 `<tasks-root>/<task-id>`；只读取 `task.yaml` 校验准入，不得直接创建、修改或替换它。节点只原子写入本节点产物并向 `$workflow-orchestrator` 报告结果；普通状态由 `workflow-orchestrator` actor 推进，人工 Gate 仅在用户原样提交精确确认指令后由 `workflow-owner` actor 决策，状态处理遵循 [任务生命周期指南](../workflow-orchestrator/references/guides/task-lifecycle.md)。产物结构必须符合 [节点产物 Schema](../workflow-orchestrator/references/contracts/node-artifact.schema.json)，Markdown 正文遵循 [统一产物结构](../workflow-orchestrator/references/four-section-artifact-template.md)和[本节点输出模板](references/output-template.md)，重跑时遵循 [节点重跑指南](../workflow-orchestrator/references/guides/node-rerun.md)，代码身份遵循 [交付证据指南](../workflow-orchestrator/references/guides/delivery-evidence.md)。

按任务路径已满足准入的产物实施最小、可回滚的代码改动。

## 输入

用户必须提供任务目录，并明确允许实施。读取 `task.yaml` 与当前路径要求的实施依据：轻量需求读取状态为 `completed` 且包含“最小验收条件”的 `implementation-plan.md`；复杂需求读取状态为 `completed` 的 `implementation-plan.md` 和 `acceptance-checklist.md`。

## 执行

1. 修改前检查 Git 状态；准备提交时必须使用干净、隔离的任务分支或 worktree，并记录 `repository_root` 和 `base_commit`。无法隔离既有改动时停止，不得混入任务变更。
2. 按实施计划修改代码，不额外扩展业务范围。
3. 复用公共组件默认行为；局部样式覆盖必须限制在模块内。
4. 运行可用的 lint、类型检查、模块自测和关键交互验证。
5. 使用临时 Git index 生成包含新增文件的 `candidate_tree` 和 `change_fingerprint`，记录实际文件改动、验证命令、未完成项、风险和与计划不一致的原因。

## 输出

按 [references/output-template.md](references/output-template.md) 写入 `<tasks-root>/<task-id>/development-record.md`：结果写实施结论和完成度，交付写实际变更、计划偏差、自测结果与四项代码身份，未决项写未完成项和遗留风险，交接写质量验证准入和 Gate 含义。向编排器报告后，编排器验证产物，先用 `set-delivery` 写入四项代码身份，再用 `record-result --gate-owner workflow-owner` 完成本节点并创建 pending gate。只有 `workflow-owner` 确认实际代码变更后才进入质量验证。未经用户明确授权，不提交、推送或合并。

发现需求、接口或方案错误时停止堆叠补丁，更新记录并退回对应前序节点。

## 调用方式

```text
使用 $development-implementation
任务目录：`<tasks-root>/<task-id>`
执行授权：允许修改代码
```
