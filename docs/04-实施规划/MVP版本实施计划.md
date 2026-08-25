# MVP 版本实施计划

## 核心问题

本文回答：为了让简化工作流可以真实试用，代码应按什么顺序完成和验证。

## 范围

实现以下闭环：

```text
来源快照
  → 可选 Figma 设计分析
  → 事实登记 + 决策登记
  → 技术方案
  → 开发计划
  → 独立开发单元
  → 开发进度汇总
```

不实现业务代码验证、测试、验收、AC 影响图、通用 Handoff、任务产物哈希和复杂路径选择。

## 实施顺序

### 1. 领域模型

- `aiw.task/v3`
- `aiw.fact-register/v2`
- `aiw.decision-register/v2`
- `aiw.development-plan/v1`
- 开发结果 Markdown 校验

### 2. 主干编排

- 初始化固定主干。
- 澄清只生成事实和决策。
- review 写入本期结论或延期事项。
- 方案和计划使用最小直接上游上下文。
- 可选设计节点在任务运行时由 Codex 使用已登录的 Chrome 读取 Figma；AIW 不配置 Figma MCP，无设计稿任务保持原主干。

### 3. 开发单元

- 计划批准后物化开发节点。
- 直接使用 `development-unit-<英文语义名>` 作为节点名称和单元依赖。
- 拒绝未知、自依赖和循环依赖。
- 在独立 Git worktree 执行并安全发布补丁。
- 界面单元只携带自身需要的直接 Figma 节点引用。

### 4. 协议和技能

- Zod Schema 是 Agent 产物协议唯一来源。
- 技能只包含“输入、步骤、输出”。
- 标准模板使用 `development` 阶段。
- 移除技能中的 AC、测试、验收和 Handoff 规则。

### 5. CLI 与文档

- status 汇总开发进度。
- review 提供两级选择。
- 更新 README、用户手册和权威规范。
- 历史研发记录标明非权威。

### 6. 回归验证

```bash
node scripts/validate-skill-package.mjs  # 在技能仓库
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
git diff --check
```

## 完成标准

- 新任务可以从来源推进到全部开发单元完成。
- 带设计稿的新任务先生成设计目录和规则；普通任务不增加额外步骤。
- 延期事项不会进入方案与计划。
- 开发单元依赖按计划生效。
- 失败开发不污染源业务工作区。
- 状态页只表达开发完成，不表达测试或验收通过。
- 主仓库和技能仓库文档与当前代码一致。
