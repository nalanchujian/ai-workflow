# AI Workflow

AIW 是 Git 原生的 AI 研发工作流 CLI。它将资料快照、AI 产物和节点状态保存到 `.aiw/`，便于提交、审计和重试。

## MVP 工作流

```text
requirement-analysis → task review → api-analysis → design-slicing → solution → plan → development-unit-*
```

所有节点固定存在。需求分析完成后始终进入人工审核；接口分析和设计图切割会在各自执行时询问资料，未提供资料时该节点直接通过。

- `requirement-analysis`：交互输入 Lark `docx` 或 `wiki` 地址，以及可选章节名称。
- `api-analysis`：交互输入零个或多个当前 YApi 文章地址。
- `design-slicing`：交互输入零张或一张本地 PNG/JPEG。
- `solution` 只使用需求事实、审核结论和接口分析；不读取设计切割结果。
- `plan` 可引用已提供的接口与设计资产；成功后自动生成开发单元，无需人工批准。

## 使用

```bash
aiw init
aiw doctor
aiw task init --project .
git add .aiw && git commit -m "chore(aiw): initialize task"
aiw task run <task-id> requirement-analysis
aiw task review <task-id>
aiw task run <task-id> api-analysis
aiw task run <task-id> design-slicing
aiw task run <task-id> solution
aiw task run <task-id> plan
aiw task run <task-id> development-unit-<name>
```

每次执行后 CLI 会给出下一条命令。节点产物或输入改变后，先提交 `.aiw` 的任务事实，再继续下游节点。

## 边界

AIW 不兼容旧节点、旧参数或旧任务格式。MVP 仅支持 Lark 需求地址、YApi 接口文章和本地设计图片。

## 开发

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
```

详细操作参见 [用户使用手册](docs/07-发布运营/用户使用手册.md) 和 [CLI 命令参考](docs/03-方案设计/03-接入与接口/CLI命令参考.md)。
