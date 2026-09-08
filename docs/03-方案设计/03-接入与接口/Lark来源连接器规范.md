# Lark 来源连接器规范

Lark 连接器是 HTTP(S) 文档来源的可选实现。它只负责在 `requirement-analysis` 运行时读取链接并返回可固化的文本快照。

连接器直接调用 Lark OpenAPI，不依赖 Codex MCP。AIW 使用本机 `~/.aiw/config.yaml` 中的 Lark 应用 ID、应用密钥和开放平台域名换取租户访问令牌；每次读取自动获取令牌，不保存用户访问令牌。

支持 `https://<tenant>.larksuite.com/docx/<token>` 与 `https://<tenant>.larksuite.com/wiki/<token>`。Wiki 链接先解析为 docx，再通过文档块 API 读取全文或指定章节。应用至少需要 Wiki 节点读取权限和 docx 文档读取权限，并须处于目标文档可访问范围。

连接器不创建工作流节点、不提供旧的章节或接口 ID 初始化参数，也不改变节点的输入边界。连接器不可用时，相关节点失败并可在修复连接后重试。
