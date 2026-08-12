# Lark 来源连接器规范（v1）

## 目标

将团队已部署、可由 `aiw` 在本机直接调用的 Lark MCP Server 纳入 MVP，使 `aiw` 能在不依赖浏览器登录态的前提下读取 Lark 在线需求文档，并将其固化为可审阅、可版本化的 Git 共享来源快照。

本规范只覆盖“读取并固化 Lark 需求来源”。Lark MCP Server 负责鉴权和内容获取；`aiw` 不重复实现 Lark OpenAPI 客户端，也不管理 Lark 应用凭据。

来源快照目录和 Context Manifest 以《上下文包规范》为准，来源 revision 导致的状态变化以《任务模型规范》为准，安全限制以《安全规范》为准，用户命令与 MVP 验收分别以《CLI命令参考》和《MVP需求与验收规范》为准。

## 边界与责任

| 组件 | 职责 | 不负责 |
|---|---|---|
| Lark MCP Server | 基于既有企业授权读取指定文档，返回结构化文档内容和必要元数据 | 创建任务、保存 Git 快照、判断下游失效 |
| Lark 来源连接器 | 识别 Lark URL、调用 MCP 工具、校验并标准化响应 | 保存令牌、透传 MCP 原始响应、解释需求 |
| 来源接入服务 | 将标准化内容写为 Markdown 快照，生成哈希和来源 revision | 直接登录 Lark 或调用浏览器 |
| 任务编排器 | 将来源 revision 变更传播到依赖它的下游节点 | 轮询或监听 Lark 文档变更 |
| 任务发起人 | 提供 URL，并确认快照可在当前业务仓库内共享 | 代替企业管理员授予 Lark 权限 |

Lark 授权、应用凭据和 MCP 配置只能保留在本机受控环境中；不得写入业务仓库 `.aiw/`、Context Manifest、标准输出或运行结果。

## 使用方式

```bash
aiw task init refund-123 --project . --source https://<tenant>.larksuite.com/docx/<token>
aiw task source refresh refund-123 requirements
```

`task init` 根据 URL 识别来源类型：本地文件、公开 HTTP(S) 地址或 Lark 文档。Lark 文档交给已配置的 Lark Connector；其余现有来源仍沿用原来的接入规则。

`task source refresh` 是显式动作，不在 MVP 中轮询或订阅 Lark 文档变化。它重新读取指定来源、创建新的快照 revision；若正文哈希不变，只返回“未变化”且不修改任务状态。哈希变化时，保留旧快照、创建新 revision，并由任务状态机使依赖旧 revision 的下游节点失效。

## 接口契约

连接器面对来源接入层提供与 MCP 实现无关的接口：

```ts
interface SourceConnector {
  supports(input: string): boolean;
  fetch(input: string): Promise<ConnectorSource>;
}

interface ConnectorSource {
  canonicalUrl: string;
  externalId: string;
  title?: string;
  markdown: string;
  fetchedAt: string;
  extractor: 'lark-mcp/v1';
}
```

具体 MCP 工具名、传参格式和返回字段由本机 Connector 配置适配；MVP 不把这些实现细节写入任务事实。Connector 必须拒绝空正文、无法识别的文档类型、缺失文档标识或非 Markdown 文本结果，并返回不含凭据的诊断。

来源元数据新增 `kind`、`externalId` 与 `revision`，例如：

```json
{
  "sourceId": "requirements",
  "kind": "lark-document",
  "origin": "https://<tenant>.larksuite.com/docx/<token>",
  "externalId": "<token>",
  "revision": 1,
  "fetchedAt": "2026-08-12T12:00:00Z",
  "contentSha256": "<hex>",
  "extractor": "lark-mcp/v1"
}
```

快照路径为 `sources/<source-id>/r<revision>/snapshot.md`。任何已被审批产物引用的快照都不可覆盖。

## 数据流与失败处理

```text
Lark URL
  → Lark Source Connector
  → 已配置的 Lark MCP Server
  → 标准化 Markdown + 元数据
  → Source Intake 写入快照和哈希
  → Git 共享任务事实
  → clarify 阶段按上下文规则读取
```

- MCP 未配置、不可用或无权限：命令失败，不创建或覆盖快照，也不改变任务状态。
- Lark 返回的内容超出来源大小上限：命令失败，不截断、不写入部分内容。
- 刷新内容未变：不创建 revision、不触发失效。
- 刷新内容变化：先完整写入新 revision，再原子更新任务来源引用并记录失效事件；写入失败时旧 revision 继续有效。
- 来源内容可能含敏感数据：任务发起人必须确认其可随业务仓库读者范围共享；否则先提供脱敏版本，或不将它作为可审批任务依据。

## 验收

1. 为 Lark URL 调用可注入的 MCP 客户端替身，并生成 `lark-mcp/v1` 元数据与 Markdown 快照。
2. MCP 无权限、超时、返回无效结构或正文超限时，不产生不完整任务事实，也不泄露凭据。
3. 刷新后正文哈希未变化时，不创建 revision、不改变节点状态。
4. 刷新后正文哈希变化时，保留旧快照，创建新 revision，并使已开始的下游节点失效。
5. Context Manifest 记录来源快照路径、revision 和 SHA-256；不记录 MCP 配置、令牌或原始响应。
