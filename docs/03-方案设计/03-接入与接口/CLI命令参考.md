# CLI 命令参考

```bash
aiw task init --project <业务仓库> [--skill-profile <名称>]
aiw task run <task-id> <node-id>
aiw task review <task-id>
aiw task status <task-id>
aiw task ignore <task-id> <development-unit-name> --note <原因>
aiw task cancel <task-id> <node-id> --note <原因>
```

执行 `requirement-analysis` 时，CLI 交互收集一个 Lark 文档 URL 和可选章节名称。执行 `api-analysis` 时收集多个 YApi 文章 URL；执行 `design-slicing` 时收集一张本地 PNG/JPEG。接口或设计资料留空会直接通过对应节点。需求分析完成后，`task review` 始终是必经的人工审核关口。
