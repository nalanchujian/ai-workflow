# 变更评审输出模板

写入 `<tasks-root>/<task-id>/change-review.md`。

```yaml
---
task_id: <task-id>
node: change-review
status: completed | blocked
attempt: 1
template_version: 2
---
```

# 结果

| 项目 | 内容 |
| --- | --- |
| 评审结论 | 通过 / 修复后通过 / 拒绝完成 |
| 发现情况 | <P0/P1/P2 数量和范围偏差数量> |
| 代码一致性 | <change_fingerprint 一致 / 不一致> |

# 交付

## 审查范围

| 项目 | 内容 |
| --- | --- |
| 批准范围 | <需求、方案或工作包引用> |
| 实际范围 | <最终 diff 摘要> |
| 验证依据 | <质量报告与验收依据> |

## 发现项

| 发现 ID | 级别 | 文件或区域 | 问题 | 证据 | 处置 |
| --- | --- | --- | --- | --- | --- |
| RV-001 | P0 / P1 / P2 |  |  |  | 必须修复 / 接受风险 / 无需处理 |

没有发现项时写“无”。

## 一致性检查

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| 需求范围 | 一致 / 偏差 |  |
| 实施计划 | 一致 / 偏差 |  |
| 验证覆盖 | 充分 / 不足 |  |
| 回滚条件 | 可执行 / 不可执行 |  |

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
| RV-001 | 缺陷 / 风险 / 阻塞 |  |  |  |  | development-implementation / quality-verification / change-review |

没有未决项时写“无”。

# 交接

| 项目 | 内容 |
| --- | --- |
| 交付给 | `workflow-owner` / 对应责任节点 |
| 本节点提供 | 最终审查结论、发现项、范围一致性和冻结的代码身份 |
| 准入条件 | 结论为“通过”、无阻断发现、代码指纹与质量验证一致 |
| Gate 含义 | 确认最终变更评审并完成任务；blocked 时不创建 Gate |
