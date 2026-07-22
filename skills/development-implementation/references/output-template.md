# 开发实现输出模板

写入 `<tasks-root>/<task-id>/development-record.md`。

```yaml
---
task_id: <task-id>
node: development-implementation
status: completed | blocked
attempt: 1
template_version: 2
---
```

# 结果

| 项目 | 内容 |
| --- | --- |
| 实施结论 | <已完成 / 部分完成并阻塞> |
| 完成情况 | <完成工作包数、变更文件数、自测通过数> |
| 核心变化 | <一句话说明用户可感知的实际变化> |

# 交付

## 实际变更

| 工作包 | 文件或目录 | 实际改动 | 状态 |
| --- | --- | --- | --- |
| WP-01 |  |  | 完成 / 未完成 |

## 计划偏差

| 工作包 | 计划 | 实际 | 原因与影响 |
| --- | --- | --- | --- |
| WP-01 |  |  |  |

没有偏差时写“无”。

## 自测结果

| 命令或场景 | 结果 | 证据或说明 |
| --- | --- | --- |
|  | 通过 / 失败 / 未运行 |  |

## 交付证据

| 字段 | 值 |
| --- | --- |
| repository_root |  |
| base_commit |  |
| candidate_tree |  |
| change_fingerprint |  |

# 未决项

| ID | 类型 | 问题 | 影响 | Owner | 关闭条件 | 重试节点 |
| --- | --- | --- | --- | --- | --- | --- |
| BLK-DEV-001 | 偏差 / 风险 / 阻塞 |  | WP-00 |  |  | development-implementation |

没有未决项时写“无”。

# 交接

| 项目 | 内容 |
| --- | --- |
| 交付给 | `quality-verification` / 对应责任节点 |
| 本节点提供 | 实际 diff、自测结果、计划偏差和冻结的代码身份 |
| 准入条件 | 计划内工作包完成，基础自测可复现，代码指纹已写入任务状态 |
| Gate 含义 | 确认实际代码变更可进入独立质量验证；不代表最终验收通过。blocked 时不创建 Gate |
