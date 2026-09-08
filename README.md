# AI Workflow

AIW 是 Git 原生的 AI 研发工作流 CLI。它把需求、资料快照、AI 产物和节点状态保存在 `.aiw/`，以便提交、审计和重试。

## MVP 工作流

```text
requirement-analysis
  → task review（仅存在待决策事项时）
  → task inputs
  → api-analysis（提供接口文档时）
  → design-slicing（提供设计图时）
  → solution
  → plan
  → development-unit-*
```

- 需求输入为一个 HTTP(S) 需求文档 URL。
- 接口资料为多个 HTTP(S) 文档 URL；每个地址都会固化快照后再分析。
- 设计资料为一张本地 PNG/JPEG；只切割并建立图片索引。
- 技术方案使用需求事实、已确认决策和可选接口分析，不读取设计资产。
- 开发计划引用真实接口 ID 和图片 ID，校验成功后自动生成开发单元，无需人工批准。

## 使用

```bash
aiw init
aiw doctor
aiw task init --project . --source "https://docs.example.com/requirements"
git add .aiw && git commit -m "chore(aiw): initialize task"
aiw task run <task-id> requirement-analysis
```

需求分析完成后，按 CLI 提示执行：

```bash
aiw task inputs <task-id>
```

该对话依次询问接口文档和设计图。每项回答都会立即保存；中断后重复同一命令即可继续。随后执行 CLI 给出的 `task run` 命令。只有需求中的待决策事项需要通过 `task review` 处理；计划运行成功后直接生成 `development-unit-*` 节点。

## 边界

AIW 不兼容旧节点、旧参数或旧任务格式。旧任务需要重新创建。MVP 不增加业务测试、验收、PR、发布或设计平台接入节点。

## 开发

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
```

详细操作请参阅 [用户使用手册](docs/07-发布运营/用户使用手册.md) 和 [CLI 命令参考](docs/03-方案设计/03-接入与接口/CLI命令参考.md)。
