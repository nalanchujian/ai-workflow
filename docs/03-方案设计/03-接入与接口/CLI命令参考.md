# CLI 命令参考

```bash
aiw task init --project <业务仓库> [--skill-profile <名称>]
aiw task run <task-id> requirement-analysis --requirement-url <Lark文档URL> [--section <章节名称>]
aiw task run <task-id> api-analysis --api-url <YApi文章URL> [--api-url <YApi文章URL> ...] | --skip
aiw task run <task-id> design-slicing --design-image <本地PNG或JPEG路径> | --skip
aiw task run <task-id> <其他节点ID>
aiw task review <task-id>
aiw task status <task-id>
aiw task ignore <task-id> <development-unit-name> --note <原因>
aiw task cancel <task-id> <node-id> --note <原因>
```

需求分析使用 `--requirement-url` 和可选 `--section`。接口分析重复传入 `--api-url`；没有接口资料时传入 `--skip`。设计图切割使用 `--design-image`；没有设计图时传入 `--skip`。需求分析完成后，`task review` 始终是必经的人工审核关口。
