# 质量验证输出模板

写入 `<tasks-root>/<task-id>/quality-verification.md`。

```yaml
---
task_id: <task-id>
node: quality-verification
status: completed | blocked
attempt: 1
template_version: 2
---
```

# 结果

| 项目 | 内容 |
| --- | --- |
| 验证结论 | 通过 / 不通过 |
| 覆盖情况 | <通过、失败、未执行用例数及工程检查数> |
| 代码一致性 | <change_fingerprint 一致 / 不一致> |

# 交付

## 验收结果

| 用例 ID | 结果 | 证据 | 关联缺陷 |
| --- | --- | --- | --- |
| AC-001 | 通过 / 失败 / 阻塞 / 未执行 |  | 无 / BUG-001 |

轻量路径使用实施计划中的最小验收项编号代替 `AC-*`。

## 工程检查

| 命令 | 结果 | 证据或失败摘要 |
| --- | --- | --- |
|  | 通过 / 失败 / 未运行 |  |

## 缺陷详情

| 缺陷 ID | 级别 | 复现步骤 | 预期 | 实际 | 责任方 |
| --- | --- | --- | --- | --- | --- |
| BUG-001 | P0 / P1 / P2 |  |  |  |  |

没有缺陷时写“无”。

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
| BUG-001 | 缺陷 / 环境 / 数据 / 阻塞 |  | AC-000 |  |  | development-implementation / quality-verification |

没有未决项时写“无”。

# 交接

| 项目 | 内容 |
| --- | --- |
| 交付给 | `change-review` / 对应责任节点 |
| 本节点提供 | 验收结果、工程检查、缺陷证据和已核对的代码身份 |
| 准入条件 | P0/P1 无未关闭缺陷，必测项完成，代码指纹与开发记录一致 |
| Gate 含义 | 确认验证证据可进入最终变更评审；不授权修改代码。blocked 时不创建 Gate |
