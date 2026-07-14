---
name: 02-requirement-clarification
description: 读取任务目录中的需求解析包，生成带 AI 推荐结论的需求澄清产物并等待人工整体确认。适用于需求规则冲突、接口边界不明确或开发前需要确认范围的任务。
---

# 需求澄清

将需求受理结果收敛成可实施的规则，并在进入变更评估前设置一次整体确认关口。

## 输入

用户必须提供任务目录。读取其中的 `task.yaml` 和 `01-requirement-analysis.md`；需要时再读取当前实现和接口资料。不得重复要求用户上传已经解析过的截图。

## 执行

1. 区分已确认规则、资料冲突、设计推断、外部依赖和非本期范围。
2. 对每个关键歧义给出 AI 推荐结论与依据；优先级为：最新需求资料、设计资料、已确认接口契约、当前代码。
3. 不让用户逐项填写表格。将推荐结论写入 `02-requirement-clarification.md`，并把任务标记为 `awaiting_confirmation`。
4. 聊天中仅展示精简结论，要求用户回复“确认继续”或指出需要修改的项。
5. 用户确认后，将本文件和 `task.yaml` 的确认状态改为 `approved`，节点状态改为 `completed`；再由 `$03-change-assessment` 处理下一节点。

## 输出

写入 `/Users/j/codes/ai-workflow/tasks/<task-id>/02-requirement-clarification.md`，文件必须包含 `artifact`、`task_id`、`node`、`status`、`target_module`、`inputs`、`depends_on`、推荐结论、依据、风险和确认状态。

同步更新 `task.yaml` 的当前节点、状态、产物记录、确认状态和下一节点准入条件。聊天只输出摘要和文件路径。

## 约束

- 不能把截图无法证明的接口字段或状态机写成已确认事实。
- 仅在无法安全继续时阻塞；其他不确定项可作为实施假设，必须记录风险。
- 未获确认时不得进入变更评估或修改业务代码。

## 调用方式

```text
使用 $02-requirement-clarification
任务目录：`/Users/j/codes/ai-workflow/tasks/<task-id>`
```
