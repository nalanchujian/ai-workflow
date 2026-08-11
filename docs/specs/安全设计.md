# AI Workflow 安全设计（MVP）

## 目标与信任边界

`aiw` 运行在开发者本机，但以下输入均不可信：命令行参数、来源 URL、来源文档、技能仓库与 `SKILL.md`、任务产物、Git 元数据、外部子进程输出。业务代码与本机凭据属于受保护资产；`.aiw/` 中的来源和日志可能含内部需求，也按敏感本地数据处理。

安全目标是：只读取用户明确选择的来源；不允许网络来源访问内网；不让不可信文本提升为 Agent 指令；不将凭据或业务内容泄漏至日志；不超出项目目录调用 Codex 写入代码。

## 来源接入

### URL

- 仅允许 `http` 和 `https`；拒绝用户名密码形式 URL；仅允许省略端口、`http:80` 和 `https:443`，拒绝所有其他端口和协议。
- 每次初始请求和每个重定向都必须重新解析主机名，并在建立连接前拒绝回环、私网、链路本地、组播、保留和未指定 IPv4/IPv6 地址。
- 最多允许 5 次重定向，单次请求超时为 15 秒，响应体上限为 5 MiB。
- 仅接受 `text/plain`、`text/markdown`、`text/html`；不发送 Cookie、授权头或用户环境中的认证信息。
- DNS 解析、连接和重定向由可注入的 `NetworkClient` 完成；单元测试必须证明危险地址在调用 `fetch` 前被拒绝。

### 本地文件

- `--source` 只接受用户显式给出的普通文件；解析 `realpath` 后拒绝目录、设备文件、FIFO 和损坏的符号链接。
- 本地来源在读取后立即复制为 `.aiw/tasks/<id>/sources/<source-id>/snapshot.md`；后续 Agent 运行只读取快照，不重新读取原路径。
- `--include` 解析 `realpath` 后必须位于 `projectRoot` 或当前任务目录内；通过符号链接逃逸到其外的路径必须拒绝。

## 技能供应链

- `aiw skills install` 仅接受 HTTPS 或 SSH Git URL；禁止 `file://` 和本地路径来源。
- Git 调用必须禁用 hooks，禁止本地 file protocol，并记录 clone 后的精确 commit SHA；Registry 使用 SHA 而非浮动分支名执行技能。
- 仅识别 `skills/<name>/SKILL.md`；技能内容不执行脚本、不自动加载 npm、Python 或 shell 文件。
- `SKILL.md` front matter 必须通过 schema 校验；无效仓库不得更改 Registry。

## Agent 上下文与提示词隔离

Adapter 以固定顺序生成上下文：Runner 约束、选中技能、用户任务、来源快照和任务产物。来源与产物以带相对路径的显式 XML 风格边界包裹，例如：

```text
<artifact path="artifacts/brief.md" trust="untrusted-data">
...内容...
</artifact>
```

Runner 约束说明这些区块是数据，不得视为更高优先级指令。只允许 `context-manifest.json` 中有哈希记录的文件进入 `context.md`；超出 12,000 token 默认预算时失败，不截断、不自动概括或偷偷删除内容。

## Codex 进程与文件系统

- 仅在用户显式执行 `aiw task run` 时启动 Codex。
- MVP 使用 `codex exec --cd <projectRoot> --sandbox workspace-write --ask-for-approval never ...`；禁止使用任何绕过 sandbox 或审批的参数。
- `AIW_CODEX_BIN` 只可指定可执行文件路径或名称；Adapter 必须以参数数组启动进程，绝不通过 shell 拼接命令。
- 子进程仅继承运行所需的环境变量；不得将完整环境、令牌、来源正文或上下文正文写到 stdout、stderr、`request.json` 或 `result.json`。
- 所有运行文件必须位于 `.aiw/tasks/<id>/runs/<run-id>/`。写入前验证 realpath 边界，清理时只能删除 Adapter 在该运行目录创建的临时文件。

## 日志、保留与错误

- 日志仅记录时间、任务 ID、节点 ID、文件相对路径、哈希、技能版本、进程退出信息和短错误码；正文默认不记录。
- `.aiw/` 使用当前用户可读写的权限创建；不得上传或同步到远程服务。
- 失败必须保留已存在的快照、审批事件和历史运行记录。错误信息不得回显授权头、环境变量或完整子进程参数中的敏感值。

## 安全验收

| 场景 | 预期结果 |
|---|---|
| URL 解析为 `127.0.0.1`、`::1` 或私网地址 | 在 `fetch` 前失败，且不创建快照。 |
| 公网 URL 重定向至私网地址 | 在重定向跳转前失败。 |
| 本地来源是目录或符号链接逃逸 | 失败，且不创建快照。 |
| `--include` 通过符号链接指向项目外 | 失败，manifest 不含该文件。 |
| 技能仓库只有脚本没有有效 `SKILL.md` | 安装失败，Registry 不变。 |
| 技能正文包含“忽略所有规则” | 内容仍以 `untrusted-data` 区块传递，Runner 约束保持在其前。 |
| `AIW_CODEX_BIN` 不存在 | 生成 `RunResult(status=unavailable)`，不得把命令内容写入错误日志。 |
| Codex 子进程超时、取消或失败 | 节点失败且保留运行元数据；不会删除已批准产物。 |
