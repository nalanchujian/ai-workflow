---
name: implementation-design
description: 读取当前路径的任务产物，生成文件级实现方案、数据映射、验证策略和回滚方案，并写入实施计划。
---

# 实施设计

任务目录统一写作 `<tasks-root>/<task-id>`；只读取 `task.yaml` 校验准入，不得直接创建、修改或替换它。节点只原子写入本节点产物并向 `$workflow-orchestrator` 报告结果；普通状态由 `workflow-orchestrator` actor 推进，人工 Gate 仅在用户原样提交精确确认指令后由 `workflow-owner` actor 决策，状态处理遵循 [任务生命周期指南](../workflow-orchestrator/references/guides/task-lifecycle.md)。产物结构必须符合 [节点产物 Schema](../workflow-orchestrator/references/contracts/node-artifact.schema.json)，Markdown 正文遵循 [统一产物结构](../workflow-orchestrator/references/four-section-artifact-template.md)和[本节点输出模板](references/output-template.md)，重跑时遵循 [节点重跑指南](../workflow-orchestrator/references/guides/node-rerun.md)。

将需求和影响范围转换为开发可以直接执行的最小方案；默认不修改业务代码。

## 输入

用户必须提供任务目录。根据 `requirement-routing.json` 的路径读取准入产物：轻量需求读取已确认的需求定义；复杂需求额外读取验收清单和影响范围报告。

## 执行

1. 按页面装配、状态管理、组件、API、mapper、样式、测试划分改动。
2. 指明新增、修改和删除的文件，以及每个需求点的实现位置。
3. 定义请求参数、响应映射、状态流、错误处理、权限和刷新策略。
4. 给出验证命令、测试数据、灰度条件和回滚方案。
5. 对接口、状态码或权限的未确认项保持阻塞，不用临时猜测替代。
6. `path=lightweight` 时必须增加“最小验收条件”章节，覆盖正常、异常、边界和回归场景，并为每项写出可观察结果；复杂需求直接引用验收设计产出的完整验收清单。

## 输出

按 [references/output-template.md](references/output-template.md) 写入 `<tasks-root>/<task-id>/implementation-plan.md`：四个一级区块依次写结果、方案产出、待确认项和下一步；通过 `RF-*`、`AC-*`、`IA-*` 引用上游，方案只新增工作包、文件级决策、行为契约、验证与回滚，轻量需求增加粗体标签“最小验收条件”。非需求未决项使用统一六列表，整份产物不超过三张表。完成后报告结果给编排器。

实施计划为 `completed` 且不存在阻断项时，由编排器创建本节点 pending gate。`workflow-owner` 确认后，轻量需求和复杂需求都直接进入开发实现；确认文案必须明确说明批准后将开始修改业务代码。

实施计划无法形成有效结论时写为 `blocked`，通常由本节点重做；只有确认路径分类或需求范围本身错误时，才转交需求分流或需求受理与确认，不能默认把方案职责推给前序节点。

## 调用方式

```text
使用 $implementation-design
任务目录：`<tasks-root>/<task-id>`
```
