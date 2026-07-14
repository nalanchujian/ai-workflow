---
name: 12-production-monitoring-retrospective
description: 读取发布记录和监控目标，沉淀线上观察结论、复盘项和后续治理动作。
---

# 运行监控与复盘

确认发布后的真实运行质量，将线上问题和经验沉淀回需求、测试和工程规范；默认不修改业务代码。

## 输入

用户必须提供任务目录。读取 `11-release-record.md` 和当前路径对应的监控、风险与回滚信息；必要时补充 Sentry、Datadog、日志、接口指标和用户反馈。

## 执行

1. 观察错误率、接口失败率、性能指标、核心路径转化和用户反馈。
2. 将异常归类为需求遗漏、设计问题、实现缺陷、接口问题、环境问题或流程问题。
3. 记录影响范围、根因、处置措施、长期修复和回归用例。
4. 输出需要回写到需求模板、验收清单、模块规范和组件规范的改进项。

## 输出

写入 `/Users/j/codes/ai-workflow/tasks/<task-id>/12-monitoring-retrospective.md`，包含线上监控结论、复盘记录、治理任务和流程改进项；同步更新 `task.yaml`。

缺少发布记录或监控目标时，本节点必须标记为 `BLOCKED`；发现阻断级问题时应回滚或止损，并将问题作为新任务重新进入需求受理。

## 调用方式

```text
使用 $12-production-monitoring-retrospective
任务目录：`/Users/j/codes/ai-workflow/tasks/<task-id>`
```
