# CLI 命令参考

```bash
aiw task init --project <业务仓库> --source <需求文档 URL> [--skill-profile <名称>] [--force-new]
aiw task run <task-id> <node-id>
aiw task inputs <task-id>
aiw task review <task-id>
aiw task status <task-id>
aiw task ignore <task-id> <development-unit-name> --note <原因>
aiw task cancel <task-id> <node-id> --note <原因>
```

`task inputs` 需要交互终端。它先接收零个或多个接口文档 URL，再接收零张或一张设计图；已保存的回答不会重复询问。`task approve` 已不存在，计划完成后会直接生成开发单元。
