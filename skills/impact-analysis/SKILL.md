---
name: impact-analysis
description: 读取复杂需求的任务产物并扫描真实代码边界，输出受影响文件、接口、权限、状态、公共依赖和回归风险。
---

# 影响分析

任务目录统一写作 `<tasks-root>/<task-id>`；只读取 `task.yaml` 校验准入，不得直接创建、修改或替换它。节点只原子写入本节点产物并向 `$workflow-orchestrator` 报告结果；普通状态由 `workflow-orchestrator` actor 推进，人工 Gate 仅在用户原样提交精确确认指令后由 `workflow-owner` actor 决策，状态处理遵循 [任务生命周期指南](../workflow-orchestrator/references/guides/task-lifecycle.md)。产物结构必须符合 [节点产物 Schema](../workflow-orchestrator/references/contracts/node-artifact.schema.json)，Markdown 正文遵循 [统一产物结构](../workflow-orchestrator/references/four-section-artifact-template.md)和[本节点输出模板](references/output-template.md)，重跑时遵循 [节点重跑指南](../workflow-orchestrator/references/guides/node-rerun.md)。

作为唯一的完整代码影响扫描节点，定位真实影响范围；不在本节点设计实现细节或修改业务代码。

## 输入

用户必须提供任务目录。读取 `task.yaml`、需求解析、澄清结论、`requirement-routing.json` 和 `acceptance-checklist.md`。仅处理 `path=complex` 的任务，并以需求受理的入口线索和需求分流的触发器证据作为扫描起点，但必须独立验证完整边界。

## 执行

1. 定位路由、入口、页面装配、组件、hooks、API、类型、mapper、样式和测试。
2. 扫描权限、功能开关、公共组件、全局样式、旧入口、旧接口、缓存、轮询和跨 Tab 状态。
3. 梳理请求触发、数据映射、表单回填、日期时区、错误处理和并发风险。
4. 将风险分为：必须修改、需要回归、不可直接修改、外部依赖和遗留风险。

## 输出

按 [references/output-template.md](references/output-template.md) 写入 `<tasks-root>/<task-id>/impact-analysis.md`：结果写影响等级和规模，交付写影响概览、改动候选、调用链与回归范围，未决项写外部依赖和 blocker，交接写实施设计准入及 Gate 含义。完成后报告结果给编排器。编排器创建本节点 pending gate，只有 `workflow-owner` 确认影响范围后才进入实施设计。

聊天只摘要高风险项、产物路径和确认请求。发现公共能力或跨模块影响时，明确标记，不得隐藏为局部改动。

## 调用方式

```text
使用 $impact-analysis
任务目录：`<tasks-root>/<task-id>`
```
