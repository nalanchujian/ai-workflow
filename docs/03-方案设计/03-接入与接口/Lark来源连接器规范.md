# Lark 来源连接器规范

Lark 连接器是 HTTP(S) 文档来源的可选实现。它只负责在 `requirement-analysis` 运行时读取链接并返回可固化的文本快照。

连接器直接调用 Lark OpenAPI，并始终使用当前用户身份。AIW 使用 Lark OIDC 用户授权，不在授权 URL 中显式申请文档 scope；在本机 `~/.aiw/config.yaml` 中保存 App ID、域名和本地回调地址，App Secret 只保存到 macOS Keychain。每次读取都启动新的授权，用户访问令牌不落盘，命令结束即丢弃。

支持 `https://<tenant>.larksuite.com/docx/<token>` 与 `https://<tenant>.larksuite.com/wiki/<token>`。Wiki 链接先解析为 docx，再通过文档块 API 读取全文或指定章节。用户需在首次 OAuth 登录时授予 Wiki 节点读取和 docx 文档读取权限，并对目标文档拥有访问权限；令牌失效时，AIW 明确提示重新授权。

```yaml
connectors:
  lark:
    appId: cli_xxx
    domain: https://open.larksuite.com
    callback:
      host: 127.0.0.1
      port: 38991
```

连接器不创建工作流节点、不提供旧的章节或接口 ID 初始化参数，也不改变节点的输入边界。连接器不可用时，相关节点失败并可在修复连接后重试。
