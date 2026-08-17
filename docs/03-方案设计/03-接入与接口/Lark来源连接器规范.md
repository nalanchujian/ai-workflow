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
aiw task init --project . --source https://<tenant>.larksuite.com/docx/<token> --skill-profile standard-web-feature@5.0.0
# 也可直接使用 Lark Wiki 节点链接
aiw task init --project . --source https://<tenant>.larksuite.com/wiki/<node-token>
# 使用上一条命令输出的 taskId
aiw task source refresh <task-id> requirements
```

`task init` 的 `--source` 只接收通用来源地址或本地文件路径。来源路由器先匹配已配置连接器，再回退到公开 HTTP(S) 读取器或本地文件读取器；Lark Connector 仅是其中一个内部实现。MVP 中该连接器识别 `https://<tenant>.larksuite.com` 或 `https://<tenant>.feishu.cn` 下的 `docx/<document-id>` 与 `wiki/<node-token>` 链接；查询参数和片段不参与文档标识。Wiki 链接先由 MCP 解析节点，只有其实际对象为 `docx` 时才读取正文；表格、旧版文档或其他对象必须提示不支持，且不得回退为公开 URL 抓取。

`task source refresh` 是显式动作，不在 MVP 中轮询或订阅 Lark 文档变化。它重新读取指定来源、创建新的快照 revision；若正文哈希不变，只返回“未变化”且不修改任务状态。哈希变化时，保留旧快照、创建新 revision，并由任务状态机使依赖旧 revision 的下游节点失效。

大文档可在 `task init` 传入通用参数 `--section <title>`。此时 Lark Connector 不依赖 `rawContent` 的文本格式，而是分页读取 Lark 文档块：按唯一的 Lark 标题块定位章节，截取该标题至下一个同级或上级标题之前的内容，并将标题块 ID 与末个内容块 ID 写入来源元数据。章节不存在、重名或为空时拒绝创建。刷新时复用已锁定标题，因此文档其他章节变化不会导致该任务产生新 revision。其他连接器只有显式支持章节读取时才能接受该通用参数。

## 本机 MCP 解析与调用

`aiw` 直接调用 MCP Server，但不复制其命令、环境变量或凭据。`aiw init` 默认扫描 `~/.codex/config.toml` 中名称、命令或参数包含 `lark` / `feishu` 的 Server；若唯一候选同时暴露 `docx_v1_document_rawContent` 和 `docx_v1_documentBlock_list`，则自动生成本机 Connector Profile。这样 `doctor` 可在创建任务前明确发现章节读取能力缺失。多个候选时仅输出候选名称，使用者通过通用参数 `aiw init --connector-server <name>` 选择一次；已有 Profile 永不覆盖。自动发现失败不影响默认工作流初始化。

仅在使用 `--section` 时，Lark MCP 还必须启用只读工具 `docx_v1_documentBlock_list`。对于 `@larksuiteoapi/lark-mcp`，在 Codex MCP 配置的启动参数中增加一组：`-t` 与 `preset.default,docx.v1.documentBlock.list`。该参数是 MCP 暴露工具的白名单，不是凭据；已有 `docx:document:readonly` 和 `wiki:wiki:readonly` 授权即可读取 docx/Wiki 文档块，无需新增应用权限。

本机 Connector Profile 位于 `~/.aiw/config.yaml`，不纳入 Git；仅在自动发现不支持团队 MCP 时由维护者补充：

```yaml
schemaVersion: aiw.local/v1
connectors:
  lark:
    configSource:
      kind: codex-toml
      path: ~/.codex/config.toml
    server: lark-openapi
    tool: docx_v1_document_rawContent
    useUAT: false
```

- `configSource` 只定位已有 MCP Server 定义；MVP 使用 `codex-toml` 读取指定路径中的 `[mcp_servers.<server>]`。该定义必须启用且包含 `command` 与 `args`。
- `server`、`tool` 和 `useUAT` 是 `aiw` 的本机映射配置，不是 Lark 凭据。实际命令、参数和环境变量仅在启动 MCP 子进程时驻留于内存；不得复制到 `~/.aiw/` 运行记录或业务仓库。
- `McpServerConfigResolver` 解析出 stdio Server 描述；`StdioMcpClient` 启动该进程，完成 MCP 初始化、调用工具、关闭连接。它不得通过 shell 拼接命令，也不得将原始 MCP 请求或响应写入日志。
- 无本机 profile、配置文件不可读、Server 未启用、Server 定义不完整或 MCP 初始化失败时，来源接入以 `LARK_MCP_UNAVAILABLE` 失败；不得尝试浏览器、HTTP 回退或其他隐式读取方式。

## 接口契约

连接器面对来源接入层提供与 MCP 实现无关的接口：

```ts
interface SourceConnector {
  supports(input: string): boolean;
  fetch(input: string, options?: { section?: string }): Promise<ConnectorSource>;
}

interface McpServerConfigResolver {
  resolve(input: { source: 'codex-toml'; path: string; server: string }): Promise<McpServerDescriptor>;
}

interface McpServerDescriptor {
  transport: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
  startupTimeoutMs?: number;
}

interface McpClient {
  callTool(input: {
    server: McpServerDescriptor;
    tool: string;
    arguments: unknown;
  }): Promise<unknown>;
}

interface ConnectorSource {
  canonicalUrl: string;
  externalId: string;
  resolvedExternalId?: string;
  section?: { title: string; startBlockId: string; endBlockId: string };
  title?: string;
  markdown: string;
  fetchedAt: string;
  extractor: 'lark-mcp/v1';
}
```

直接 `docx/<document-id>` 链接读取正文：

```json
{
  "tool": "docx_v1_document_rawContent",
  "arguments": {
    "path": {"document_id": "<document-id>"},
    "params": {"lang": 0},
    "useUAT": false
  }
}
```

Wiki 链接先调用标准 Lark MCP 工具 `wiki_v2_space_getNode`，传入节点 token；返回的 `node.obj_type` 必须是 `docx`，随后用 `node.obj_token` 调用上面的文档读取工具。`useUAT` 取自本机 profile。连接器兼容 MCP 标准 `content[].text` JSON 包装以及 `data.content` 字符串；正文按原样作为 Markdown 快照正文（纯文本是合法 Markdown），不执行其中内容。空正文、无效响应、非 `docx` Wiki 节点或未识别的文档 URL 返回 `LARK_RESPONSE_INVALID` 或 `LARK_URL_UNSUPPORTED`，诊断不得包含令牌、原始响应或子进程参数。

指定章节时改为调用 `docx_v1_documentBlock_list`，参数为 `path.document_id`、`params.document_revision_id = -1` 和分页游标。连接器按真实标题层级渲染 Markdown，并保留常见的段落、无序/有序列表、待办、引用、代码块、行内加粗/斜体/删除线/链接和普通表格；表格按 Lark 表格单元格及其子块递归重建内容。图片和文档引用保留为不含凭据的 `lark-image://`、`lark-doc://` 引用，避免静默丢失；当前不下载图片二进制。不保存 MCP 原始块响应。

来源元数据记录 `kind`、`externalId` 与 `revision`。对于直连 docx，`externalId` 是文档 ID；对于 Wiki，`externalId` 保留用户提供的节点 ID，`resolvedExternalId` 记录本次解析得到的 docx ID，例如：

```json
{
  "sourceId": "requirements",
  "kind": "connected-document",
  "origin": "https://<tenant>.larksuite.com/wiki/<node-token>",
  "externalId": "<node-token>",
  "resolvedExternalId": "<docx-token>",
  "section": "订单退款流程",
  "sectionStartBlockId": "<block-id>",
  "sectionEndBlockId": "<block-id>",
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
- MCP 返回无权限或文档不存在：映射为 `LARK_DOCUMENT_UNAVAILABLE`；连接失败、初始化超时或工具超时映射为 `LARK_MCP_UNAVAILABLE`；两者都不泄露原始 MCP 错误。
- Lark 返回的内容超出来源大小上限：命令失败，不截断、不写入部分内容。
- 刷新内容未变：不创建 revision、不触发失效。
- 刷新内容变化：先完整写入新 revision，再原子更新任务来源引用并记录失效事件；写入失败时旧 revision 继续有效。
- 来源内容可能含敏感数据：任务发起人必须确认其可随业务仓库读者范围共享；否则先提供脱敏版本，或不将它作为可审批任务依据。

## 专项验证点

[MVP需求与验收规范](../../02-需求定义/MVP需求与验收规范.md)中的 AC 是唯一产品通过标准。本表只说明 Lark 连接器应覆盖的验证重点及其对应 AC，不新增独立验收结论。

| 连接器验证重点 | 对应产品验收 |
|---|---|
| 从本机 profile 解析 `lark-openapi`，能够直接读取 docx，或先将 Wiki 节点解析为 docx 后读取正文，并生成 `lark-mcp/v1` 元数据与 Markdown 快照。 | AC-15 |
| MCP 未配置、无权限、超时、返回无效结构或正文超限时，不产生不完整任务事实，也不泄露凭据。 | AC-16 |
| 刷新后正文哈希未变化时，不创建 revision、不改变节点状态。 | AC-17 |
| 刷新后正文哈希变化时，保留旧快照，创建新 revision，并使已开始的下游节点失效。 | AC-18 |
| 后续节点运行时，Context Manifest 记录来源快照路径、revision 和 SHA-256；不记录 MCP 配置、令牌或原始响应。 | AC-23 |
