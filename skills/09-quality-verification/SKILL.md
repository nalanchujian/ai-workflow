---
name: 09-quality-verification
description: 读取代码变更、自测和路径验收依据，执行前端质量验证并输出通过项、缺陷、阻塞项和回归风险。
---

# 质量验证

验证当前实现是否满足路径对应的验收依据；默认不修改业务代码。

## 输入

用户必须提供任务目录。读取 `task.yaml`、`08-development-record.md` 和当前路径的执行摘要、最小验收条件或完整验收清单；必要时读取设计截图和接口资料。

## 执行

1. 运行可用的 lint、类型检查、单元测试、构建和模块级测试。
2. 验证正常、异常、边界、权限、空状态、加载状态、回填、清空、分页与重复请求。
3. 对照设计资料验证布局、颜色、间距、字体和交互状态。
4. 将问题标为实现、接口、环境、数据或需求责任，并提供可复现步骤。

## 输出

写入 `/Users/j/codes/ai-workflow/tasks/<task-id>/09-quality-verification.md`，包含验证命令、通过项、失败项、阻塞项、风险和发布建议。同步更新 `task.yaml`。

P0/P1 未解决时不得标记为通过；发现范围外风险时退回影响分析或变更评估。

## 调用方式

```text
使用 $09-quality-verification
任务目录：`/Users/j/codes/ai-workflow/tasks/<task-id>`
```
