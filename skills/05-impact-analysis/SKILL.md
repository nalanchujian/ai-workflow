---
name: 05-impact-analysis
description: 读取复杂需求的任务产物并扫描真实代码边界，输出受影响文件、接口、权限、状态、公共依赖和回归风险。
---

# 影响分析

只定位真实影响范围，不在本节点设计实现细节或修改业务代码。

## 输入

用户必须提供任务目录。读取 `task.yaml`、需求解析、澄清结论、`03-change-assessment.json` 和 `04-acceptance-checklist.md`。仅处理 `path=complex` 的任务。

## 执行

1. 定位路由、入口、页面装配、组件、hooks、API、类型、mapper、样式和测试。
2. 扫描权限、功能开关、公共组件、全局样式、旧入口、旧接口、缓存、轮询和跨 Tab 状态。
3. 梳理请求触发、数据映射、表单回填、日期时区、错误处理和并发风险。
4. 将风险分为：必须修改、需要回归、不可直接修改、外部依赖和遗留风险。

## 输出

写入 `/Users/j/codes/ai-workflow/tasks/<task-id>/05-impact-analysis.md`，包含关键文件、职责、受影响行为、风险级别、回归范围、公共依赖与建议边界。同步更新 `task.yaml`。

聊天只摘要高风险项和产物路径。发现公共能力或跨模块影响时，明确标记，不得隐藏为局部改动。

## 调用方式

```text
使用 $05-impact-analysis
任务目录：`/Users/j/codes/ai-workflow/tasks/<task-id>`
```
