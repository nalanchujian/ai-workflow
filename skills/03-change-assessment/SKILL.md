---
name: 03-change-assessment
description: 读取已确认的需求产物和代码扫描结果，按固定规则评估改动风险并选择快速修复、轻量需求或复杂需求路径。
---

# 变更评估

根据需求事实和真实代码边界确定工作流路径，不凭主观印象分类。

## 输入

用户必须提供任务目录。读取 `task.yaml`、`01-requirement-analysis.md` 和已确认的 `02-requirement-clarification.md`；扫描目标模块的路由、接口、权限、公共依赖与改动边界。

## 判定顺序

1. 资料或确认未完成：`NEEDS_CLARIFICATION`，退回需求澄清。
2. 命中权限、安全、金额、数据迁移、公共组件/包、全局样式/路由、破坏性接口或跨模块影响：`complex`。
3. 仅修复已定义行为、影响单模块、无接口或公共能力变动且可快速回滚：`quick_fix`。
4. 其余资料明确、影响单模块、接口向后兼容的改动：`lightweight`。

## 输出

写入 `/Users/j/codes/ai-workflow/tasks/<task-id>/03-change-assessment.json`，至少包含：

```json
{
  "decisionState": "ROUTED | NEEDS_CLARIFICATION",
  "path": "quick_fix | lightweight | complex | null",
  "confidence": "high | medium | low",
  "matchedRules": [],
  "evidence": [],
  "complexTriggers": [],
  "requiredNodes": [],
  "requiredArtifacts": {},
  "requiresOwnerApproval": false
}
```

同步更新 `task.yaml` 的路径、状态、后续必经节点和准入产物。聊天中仅说明判定结果、关键证据和下一步。

## 约束

- 资料冲突时不得强行归类为轻量需求。
- 每个命中规则必须有需求片段、代码位置或扫描结果作为证据。
- 低置信度或需要人工覆盖路径时，标记为等待 Owner 确认。

## 调用方式

```text
使用 $03-change-assessment
任务目录：`/Users/j/codes/ai-workflow/tasks/<task-id>`
```
