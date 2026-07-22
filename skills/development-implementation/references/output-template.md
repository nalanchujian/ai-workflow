# 开发实现输出模板

写入 `<tasks-root>/<task-id>/development-record.md`。

```yaml
---
task_id: <task-id>
node: development-implementation
status: completed | blocked
attempt: 1
artifact_schema_version: 1
---
```

# 1. 结果

> **状态：** <完成 / 阻塞>
> **结论：** <一句话实际变化>
> **规模：** <完成工作包、变更文件和自测数量>

# 2. 产出

**实际变更**

| 工作包 | 文件或目录 | 实际改动 | 计划偏差 | 状态 |
| --- | --- | --- | --- | --- |
| WP-01 |  |  | 无 / <原因与影响> | 完成 / 未完成 |

**计划偏差**

没有偏差时写“无”；存在偏差时仅列 `WP-*`、原因、影响及是否需要回退方案节点，不复制计划原文。

**自测结果**

| 命令或场景 | 结果 | 证据或说明 |
| --- | --- | --- |
|  | 通过 / 失败 / 未运行 |  |

**交付证据**

- `repository_root`：
- `base_commit`：
- `candidate_tree`：
- `change_fingerprint`：

实际变更通过 `WP-*` 关联实施计划，只记录最终差异和证据。

# 3. 待确认

| ID | 类型 | 事项与影响 | Owner | 责任节点 | 完成条件 |
| --- | --- | --- | --- | --- | --- |
| BLK-DEV-001 | 风险 / 缺陷 / 资料依赖 / 环境阻塞 |  |  | development-implementation |  |

没有未决项时写“无”。

# 4. 下一步

- 当前动作：关闭未决项；无未决项时由编排器展示代码变更 Gate
- 完成条件：计划内工作包完成、自测可复现、代码身份已冻结
