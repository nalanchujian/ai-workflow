# 质量验证输出模板

写入 `<tasks-root>/<task-id>/quality-verification.md`。

```yaml
---
task_id: <task-id>
node: quality-verification
status: completed | blocked
attempt: 1
artifact_schema_version: 1
---
```

# 1. 结果

> **状态：** <完成 / 阻塞>
> **结论：** <通过 / 不通过>
> **规模：** <通过、失败、未执行用例和工程检查数量>

# 2. 产出

**验收与工程检查**

| 检查 ID 或命令 | 类型 | 结果 | 证据 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| AC-001 / `<command>` | 验收 / 工程 | 通过 / 失败 / 阻塞 / 未执行 |  | 无 / BUG-001 |

**缺陷详情**

| 缺陷 ID | 级别 | 复现步骤 | 预期 | 实际 | 责任方 |
| --- | --- | --- | --- | --- | --- |
| BUG-001 | P0 / P1 / P2 |  |  |  |  |

没有缺陷时写“无”。

**交付证据**

- `repository_root`：
- `base_commit`：
- `candidate_tree`：
- `change_fingerprint`：

验收项通过 `AC-*` 或轻量路径最小验收项引用，工程检查通过命令引用；不复制验收定义和开发记录原文。

# 3. 待确认

| ID | 类型 | 事项与影响 | Owner | 责任节点 | 完成条件 |
| --- | --- | --- | --- | --- | --- |
| BUG-001 | 风险 / 缺陷 / 资料依赖 / 环境阻塞 |  |  | quality-verification |  |

没有未决项时写“无”。

# 4. 下一步

- 当前动作：关闭未决项；通过时由编排器展示验证结果 Gate
- 完成条件：P0/P1 关闭、必测项完成、代码指纹一致
