# Lark 来源连接器规范

Lark 连接器是 HTTP(S) 文档来源的可选实现。它只负责在 `requirement-analysis` 运行时读取链接并返回可固化的文本快照。

连接器通过 Codex 已配置的 Lark MCP 调用 Lark OpenAPI，并始终使用 MCP 保存的用户身份。AIW 仅在本机 `~/.aiw/config.yaml` 中保存 MCP 映射，不保存应用密钥、用户访问令牌或刷新令牌。

支持 `https://<tenant>.larksuite.com/docx/<token>` 与 `https://<tenant>.larksuite.com/wiki/<token>`。Wiki 链接先解析为 docx，再通过文档块 API 读取全文或指定章节。用户需在首次 OAuth 登录时授予 Wiki 节点读取和 docx 文档读取权限，并对目标文档拥有访问权限；令牌失效时，AIW 明确提示重新授权。

```yaml
connectors:
  lark:
    mcp:
      configPath: ~/.codex/config.toml
      server: lark-openapi
      tool: docx_v1_document_rawContent
      useUAT: true
```

连接器不创建工作流节点、不提供旧的章节或接口 ID 初始化参数，也不改变节点的输入边界。连接器不可用时，相关节点失败并可在修复连接后重试。
