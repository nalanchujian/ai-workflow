---
name: requirement-routing
description: 读取已确认的需求产物和代码扫描结果，按固定规则将需求分流到轻量需求或复杂需求路径。
---

# 需求分流

任务目录统一写作 `<tasks-root>/<task-id>`；只读取 `task.yaml` 校验准入，不得直接创建、修改或替换它。节点只原子写入本节点产物并向 `$workflow-orchestrator` 报告结果；普通状态由 `workflow-orchestrator` actor 推进，人工 Gate 仅在用户原样提交精确确认指令后由 `workflow-owner` actor 决策，状态处理遵循 [任务生命周期指南](../workflow-orchestrator/references/guides/task-lifecycle.md)。产物公共结构必须符合 [节点产物 Schema](../workflow-orchestrator/references/contracts/node-artifact.schema.json)，路由字段必须符合 [需求分流 Schema](../workflow-orchestrator/references/contracts/artifacts/requirement-routing.schema.json)，重跑时遵循 [节点重跑指南](../workflow-orchestrator/references/guides/node-rerun.md)。

根据需求事实和真实代码边界确定工作流路径，不凭主观印象分类。

## 输入

用户必须提供任务目录。始终读取 `task.yaml` 和已批准的 `requirement-analysis.md`。该产物已经包含需求事实、疑点及 Owner 逐条确认形成的决策。从其中的“分流线索”出发，只验证路径分流所需的边界证据。

## 扫描边界

- 验证是否涉及跨模块、公共能力、权限、安全、金额、数据迁移、全局配置或破坏性接口契约。
- 每个候选触发器只收集足以支持分流结论的代码位置或依赖证据。
- 不枚举完整改动文件，不展开请求链、状态流、并发风险和回归范围；复杂路径的完整扫描交给影响分析。

## 判定顺序

1. 缺少已批准的需求定义产物：不得执行需求分流。
2. 资料不完整、存在未被 `CL-*` 覆盖的 `RQ-*` 或仍有未确认决策：写为 `status=blocked`、`path=null`，退回需求受理与确认。
3. 命中权限、安全、金额、数据迁移、公共组件/包、全局样式/路由、破坏性接口或跨模块影响：`complex`。
4. 资料明确、影响范围局限于单模块且未命中复杂触发器：`lightweight`。局部缺陷修复也归入此路径。

需求分流不在产物中维护人工确认字段。分流成功后由编排器创建本节点 pending gate，`workflow-owner` 确认路径后才进入对应后续节点。需要补充或重新确认需求时，由编排器根据阻塞结果退回需求受理与确认。

## 输出

写入 `<tasks-root>/<task-id>/requirement-routing.json`。新产物使用版本 2：

```json
{
  "task_id": "<task-id>",
  "node": "requirement-routing",
  "status": "completed",
  "attempt": 1,
  "template_version": 2,
  "path": "lightweight",
  "reason": "<一句话分流原因>",
  "evidence": [
    "<需求事实或代码位置：观察到的轻量/复杂信号>"
  ]
}
```

`reason` 只保存一句话结论；`evidence` 每项保存一条可核验的需求事实、代码位置或边界信号，不写实施方案。报告路径、结果状态和分流原因，由编排器根据路径契约推导后续节点、创建人工 gate 并写入 `task.yaml`。聊天中仅说明判定结果、关键证据、产物路径和确认请求。

`status=completed` 时 `path` 必须是已注册路径；`status=blocked` 时 `path` 必须为 `null`。后续节点从 [工作流路径](../workflow-orchestrator/references/contracts/workflow-paths.json) 推导，产物文件名从节点注册表推导。

## 约束

- 资料冲突时不得强行归类为轻量需求。
- 需求定义未通过节点一 Gate 时不得执行分流。
- 每个命中规则必须有需求片段、代码位置或最小扫描证据。
- 证据不足时写为阻塞并退回需求受理与确认；人工覆盖只能升级到更严格路径。命中复杂触发器后不得仅凭人工意见降级，只有需求或代码证据变化、重新评估后不再命中触发器时才可降级。

## 调用方式

```text
使用 $requirement-routing
任务目录：`<tasks-root>/<task-id>`
```
