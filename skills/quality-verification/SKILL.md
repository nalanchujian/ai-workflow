---
name: quality-verification
description: 读取代码变更、自测和路径验收依据，执行前端质量验证并输出通过项、缺陷、阻塞项和回归风险。
---

# 质量验证

任务目录统一写作 `<tasks-root>/<task-id>`；只读取 `task.yaml` 校验准入，不得直接创建、修改或替换它。节点只原子写入本节点产物并向 `$workflow-orchestrator` 报告结果；普通状态由 `workflow-orchestrator` actor 推进，人工 Gate 仅在用户原样提交精确确认指令后由 `workflow-owner` actor 决策，状态处理遵循 [任务生命周期指南](../workflow-orchestrator/references/guides/task-lifecycle.md)。产物结构必须符合 [节点产物 Schema](../workflow-orchestrator/references/contracts/node-artifact.schema.json)，Markdown 正文遵循 [统一产物结构](../workflow-orchestrator/references/four-section-artifact-template.md)和[本节点输出模板](references/output-template.md)，重跑时遵循 [节点重跑指南](../workflow-orchestrator/references/guides/node-rerun.md)，代码身份遵循 [交付证据指南](../workflow-orchestrator/references/guides/delivery-evidence.md)。

验证当前实现是否满足路径对应的验收依据；默认不修改业务代码。

## 输入

用户必须提供任务目录。读取 `task.yaml`、`development-record.md` 和当前路径的固定验收依据：轻量需求读取 `implementation-plan.md` 的“最小验收条件”，复杂需求读取 `acceptance-checklist.md`；必要时读取设计截图和接口资料。

## 执行

1. 运行可用的 lint、类型检查、单元测试、构建和模块级测试。
2. 验证正常、异常、边界、权限、空状态、加载状态、回填、清空、分页与重复请求。
3. 对照设计资料验证布局、颜色、间距、字体和交互状态。
4. 将问题标为实现、接口、环境、数据或需求责任，并提供可复现步骤。
5. 重新生成 `candidate_tree` 和 `change_fingerprint`，与开发实现记录逐项比对；验证期间代码变化时结果无效，退回开发实现后重新执行。

## 输出

按 [references/output-template.md](references/output-template.md) 写入 `<tasks-root>/<task-id>/quality-verification.md`：结果写验证结论、覆盖情况和代码一致性，交付写逐项验收结果、工程检查、缺陷详情与代码身份，未决项写缺陷责任和回归风险，交接写评审准入、重试节点和 Gate 含义。完成后报告结果给编排器。

验证通过且交付代码指纹一致后，在产物中记录验证结论并报告交付证据；编排器用 `record-result --gate-owner workflow-owner` 登记质量验证产物并创建 pending gate，只有 `workflow-owner` 确认验证结果后才进入变更评审，不得修改已冻结的开发证据。验证不通过或指纹变化时报告 blocker 和责任节点，由编排器写为 `blocked`。

P0/P1 未解决时不得标记为通过；发现范围外风险时退回影响分析或需求分流。

## 调用方式

```text
使用 $quality-verification
任务目录：`<tasks-root>/<task-id>`
```
