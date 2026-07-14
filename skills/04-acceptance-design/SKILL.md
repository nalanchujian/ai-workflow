---
name: 04-acceptance-design
description: 读取任务目录中的需求、澄清和变更评估产物，生成并写入结构化、可执行的前端验收清单与测试用例。适用于复杂需求的开发前验收设计与提测前回归范围整理；默认只输出文档，不修改业务代码。
---

# 验收设计

将已确认需求转为 QA、开发和产品都能观察和执行的验收标准。

## 输入

用户必须提供任务目录。读取 `task.yaml`、`01-requirement-analysis.md`、已确认的 `02-requirement-clarification.md` 和 `03-change-assessment.json`。复杂需求必须额外进入本节点；轻量需求只输出最小验收条件。

## 执行

1. 从需求规则、视觉差异和路径风险拆分正常、异常、边界和回归场景。
2. 每条用例必须包含优先级、前置数据、步骤、可观察预期结果和责任边界。
3. 覆盖入口、权限、表单、列表、状态机、接口错误、日期时区、视觉与极端数据；不将后端职责误写为前端验收。
4. 将未确认资料标记为待确认或联调依赖，不编造规则。

## 输出

按 [references/checklist-template.md](references/checklist-template.md) 写入 `/Users/j/codes/ai-workflow/tasks/<task-id>/04-acceptance-checklist.md`，并更新 `task.yaml`。聊天只摘要验收范围、阻塞项和产物路径。

## 调用方式

```text
使用 $04-acceptance-design
任务目录：`/Users/j/codes/ai-workflow/tasks/<task-id>`
```
