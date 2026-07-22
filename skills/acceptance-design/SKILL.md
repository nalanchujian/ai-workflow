---
name: acceptance-design
description: 读取任务目录中的已确认需求定义和需求分流产物，生成并写入结构化、可执行的前端验收清单与测试用例。适用于复杂需求的开发前验收设计与提测前回归范围整理；默认只输出文档，不修改业务代码。
---

# 验收设计

任务目录统一写作 `<tasks-root>/<task-id>`；只读取 `task.yaml` 校验准入，不得直接创建、修改或替换它。节点只原子写入本节点产物并向 `$workflow-orchestrator` 报告结果；普通状态由 `workflow-orchestrator` actor 推进，人工 Gate 仅在用户原样提交精确确认指令后由 `workflow-owner` actor 决策，状态处理遵循 [任务生命周期指南](../workflow-orchestrator/references/guides/task-lifecycle.md)。产物结构必须符合 [节点产物 Schema](../workflow-orchestrator/references/contracts/node-artifact.schema.json)，Markdown 正文遵循 [统一产物结构](../workflow-orchestrator/references/four-section-artifact-template.md)和[本节点输出模板](references/checklist-template.md)，重跑时遵循 [节点重跑指南](../workflow-orchestrator/references/guides/node-rerun.md)。

将已确认需求转为 QA、开发和产品都能观察和执行的验收标准。

## 输入

用户必须提供任务目录。读取 `task.yaml`、已确认的 `requirement-analysis.md` 和 `requirement-routing.json`。仅处理 `path=complex` 的任务；轻量需求的最小验收条件由实施设计写入实施计划。

## 执行

1. 从需求事实中的业务规则、视觉要求和路径风险拆分正常、异常、边界和回归场景。
2. 每条用例必须包含优先级、前置数据、步骤、可观察预期结果和责任边界。
3. 覆盖入口、权限、表单、列表、状态机、接口错误、日期时区、视觉与极端数据；不将后端职责误写为前端验收。
4. 将未确认资料标记为待确认或联调依赖，不编造规则。

## 输出

按 [references/checklist-template.md](references/checklist-template.md) 写入 `<tasks-root>/<task-id>/acceptance-checklist.md`：结果写覆盖摘要，交付写验收范围、带 `AC-*` 编号的用例和测试数据，未决项写风险或 blocker，交接写影响分析的准入和 Gate 含义。完成后报告结果给编排器。编排器创建本节点 pending gate，只有 `workflow-owner` 确认验收清单后才进入影响分析。聊天只摘要验收范围、阻塞项、产物路径和确认请求。

## 调用方式

```text
使用 $acceptance-design
任务目录：`<tasks-root>/<task-id>`
```
