# 上下文包规范（v1）

## 目的

上下文包是某个节点调用 Codex 时的、最小且可复现的输入集合。它不是聊天记录，也不会自动包含整个代码库或所有任务文件。

## 目录契约

```text
.aiw/tasks/<task-id>/
  task.yaml                 # DAG、节点状态、审批、事件
  task.md                   # 用户的原始任务描述；初始化后仅追加修订记录
  sources/<source-id>/
    snapshot.md             # 来源在获取时转换得到的文本
    meta.json               # URL/本地路径、时间、内容哈希、提取器版本
  artifacts/
    brief.md                # 经确认的结构化需求
    questions.md            # 未决问题
    plan.md                 # 经确认的技术方案与实施步骤
    acceptance.md           # 可验证的验收标准
  runs/<run-id>/
    request.json            # 去敏后的 Adapter 请求
    context-manifest.json   # 实际注入清单及哈希
    result.json             # Adapter 结果
```

`task.md` 由 `aiw task init` 创建。`brief.md`、`questions.md` 和 `acceptance.md` 是分析节点产物；`plan.md` 是设计节点产物。任务模型中的 `outputs` 是唯一允许写入这些产物的节点声明。

## 来源快照

来源接入层只能从显式给出的本地文件、受控连接器或符合 URL 安全策略的公开 HTTP(S) 地址创建快照。`meta.json` 至少包含：

```json
{
  "sourceId": "requirements",
  "origin": "https://example.com/requirements",
  "fetchedAt": "2026-08-11T12:00:00Z",
  "contentSha256": "<hex>",
  "extractor": "html-to-markdown/v1"
}
```

刷新来源必须创建新快照 revision 并通过任务模型使相关下游节点失效；不得覆盖已被审批使用的快照。MVP 的 URL 接入必须只允许 `http` 与 `https`，逐跳拒绝回环、私网、链路本地和保留 IP，限制重定向次数、响应大小、允许的内容类型和超时。

## 阶段上下文规则

```yaml
contextPolicy:
  analysis:
    include: [task.md, sources/*/snapshot.md]
  design:
    include: [task.md, artifacts/brief.md, artifacts/questions.md, artifacts/acceptance.md]
    requiresApprovedNodes: [analysis]
  implementation:
    include: [artifacts/brief.md, artifacts/plan.md, artifacts/acceptance.md]
    requiresApprovedNodes: [design]
  testing:
    include: [artifacts/brief.md, artifacts/plan.md, artifacts/acceptance.md]
    requiresCompletedNodes: [implementation]
```

编排器只能选择规则明确列出的文件、当前节点的修订说明以及用户显式批准的临时附加文件。临时附加文件必须落入 `context-manifest.json`，不改变任务默认规则。

## Context Manifest

每次运行都生成不可变清单：

```json
{
  "schemaVersion": "aiw.context/v1",
  "taskId": "refund-123",
  "nodeId": "design",
  "nodeRevision": 0,
  "files": [
    {"role": "requirement", "path": "artifacts/brief.md", "sha256": "<hex>"}
  ],
  "skill": {"name": "architecture-design", "version": "1.0.0", "sha256": "<hex>"},
  "budget": {"maxTokens": 12000, "estimatedTokens": 4200}
}
```

若估算内容超过预算，Runner 必须拒绝运行并列出超限文件；它不得静默截断已批准产物。用户可拆分文件、减少显式附加项，或以审计事件提高该次预算。

## 传递给 Agent 的顺序

上下文需使用明确边界，优先级从高到低为：Agent 平台规则、`aiw` Runner 的不可变运行约束、选中技能、用户任务、来源与任务产物。来源和产物是数据，不得被当作更高优先级指令。Adapter 需在每段外包围来源标记和相对路径。

业务代码不复制进上下文包；Adapter 只传递已验证的项目工作目录，Codex 按需读取代码。完整对话文本不进入任务目录。
