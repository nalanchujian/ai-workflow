# AI Workflow

`aiw` 是一个 Git 原生的 AI 研发工作流 CLI。它把需求来源、人工确认和开发过程保存到业务仓库，并调用 Codex 完成代码开发。

## MVP 目标

当前 MVP 只解决一件事：让团队可以从真实需求资料出发，经过必要的人工确认，将复杂需求拆成多个可执行开发单元，并看到整体开发进度。

```text
来源快照
  → 事实登记 + 决策登记
  → 技术方案
  → 开发计划
  → 可选设计图片切割与开发单元绑定
  → 独立开发单元
  → 开发进度汇总
```

各阶段职责：

- `intake`：读取本地文件、公开 URL 或已配置连接器支持的在线文档，固化来源快照。
- `design-analysis`（可选）：读取用户提前导出的本地设计图片，在计划完成后切割成页面、弹窗或状态图片并绑定开发单元。
- `clarify`：只生成事实登记和决策登记；不生成验收项或跨节点 ID。
- `review`：逐项选择“本期继续”或“延期处理”；本期继续时选择 AI 提供的方案，延期事项退出当前任务。
- `solution`：根据当前事实和本期决策生成技术方案。
- `plan`：把方案拆成结构化开发单元和依赖关系。
- `development-unit-*`：每个单元在独立 Git worktree 中修改代码并生成开发结果。
- `status`：汇总主干状态和开发单元进度。

当前 MVP 不负责业务代码的验证、测试、验收、PR、发布或线上运维。AIW 自身仍通过自动化测试保证 CLI 实现质量。

## 与 Codex、Superpowers、Trellis 的关系

- Codex CLI 是执行器，负责分析仓库和修改代码。
- Superpowers 是方法来源。团队技能包内置 AIW 实际引用的方法，最终用户无需单独安装。
- AIW 负责来源快照、事实/决策分离、人工关卡、开发单元编排、最小上下文和运行留痕。
- Trellis 是产品能力对标对象，不是当前运行时依赖。

## 快速开始

```bash
npm install -g @nalanchujian/aiw@latest
cd <业务仓库>
aiw init
aiw doctor

aiw task init --project . --source "<需求文档地址或本地文件>"
git add .aiw && git commit -m "chore(aiw): initialize task"

# 执行 CLI 输出的下一条精准命令
aiw task run <task-id> clarify
```

需要将 YApi 接口协议一并纳入任务时，只需输入接口文档链接最后的 ID。支持逗号分隔或重复传入，AIW 会自动识别并固化为“识别 API 文档”节点的输入，后续需求澄清会读取这些快照：

```bash
aiw task init --project . --source requirements.md \
  --api-doc-id 17879,17884 \
  --api-doc-id 17904
```

当前该快捷输入匹配 `https://yapi.hbdev.club/project/149/interface/api/<id>`。

需求关联设计稿时，先从设计工具导出 PNG/JPEG，然后在创建任务时重复增加 `--design-image <图片路径>`。需求澄清、方案和计划完成后，CLI 会提示执行 `design-analysis`；该节点切割图片并按开发单元绑定。AIW 不访问或解析设计平台。

每一步都会直接显示下一条 `review`、`approve` 或具体节点的 `run` 命令。任务事实位于业务仓库 `.aiw/`，运行日志和临时 worktree 位于本机 `~/.aiw/runtime/`。

升级 npm 包后再次运行 `aiw init`。它会把官方技能来源同步到该 npm 版本指定的 Git 标签，并以当前安装覆盖同一来源的旧技能、方法和模板记录。当前 MVP 不兼容依赖旧技能 revision 的任务，升级后请创建新任务。

## 本地开发

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

不发布 npm 包也可以验证本地源码：

```bash
cd /Users/j/ai-workflow
pnpm build
pnpm pack
npm uninstall -g @nalanchujian/aiw
npm install -g /Users/j/ai-workflow/nalanchujian-aiw-0.0.2.tgz
hash -r
aiw -V
```

## 文档入口

- [立项申请](docs/01-立项与规划/立项申请.md)：是否值得启动 MVP 试点。
- [发展规划](docs/01-立项与规划/发展规划.md)：MVP 之后何时扩展能力。
- [MVP需求与验收规范](docs/02-需求定义/MVP需求与验收规范.md)：AIW 产品本身必须实现什么。
- [产品设计](docs/03-方案设计/01-总体设计/产品设计.md)：用户如何使用这套工作流。
- [架构设计](docs/03-方案设计/01-总体设计/架构设计.md)：系统如何分层实现。
- [研发工作流阶段规范](docs/03-方案设计/02-核心规范/研发工作流阶段规范.md)：每个阶段的输入、输出和推进规则。
- [任务模型规范](docs/03-方案设计/02-核心规范/任务模型规范.md)：任务状态和开发单元依赖。
- [上下文包规范](docs/03-方案设计/02-核心规范/上下文包规范.md)：每次 Codex 调用读取什么。
- [技能包规范](docs/03-方案设计/02-核心规范/技能包规范.md)：团队技能和模板如何声明。
- [CLI命令参考](docs/03-方案设计/03-接入与接口/CLI命令参考.md)：当前命令及使用场景。
- [用户使用手册](docs/07-发布运营/用户使用手册.md)：新用户从零开始的操作步骤。

`docs/00-研发记录/` 保存历史设计与实施过程，不作为当前产品行为的权威来源。

## 仓库职责

```text
ai-workflow/         # CLI、任务编排、运行时、文档和测试
ai-workflow-skills/  # 工作流模板、阶段技能和内置方法来源
业务仓库/.aiw/       # 具体任务事实
```
