# 公开 npm 发布实施计划

> 实施时按测试驱动方式执行；每个任务完成后运行对应验证，再进行提交。

## 目标

将 `aiw` 打包为可从 npm 公共 Registry 安装的 CLI：包名为 `@nalanchujian/ai-workflow`，全局命令保持为 `aiw`。本计划只准备和验证发布物，不执行不可逆的 `npm publish`。

## 发布边界

- npm Registry 固定为 `https://registry.npmjs.org`，公开访问级别为 `public`。
- 发布物仅包含 `dist/` 与 `README.md`（npm 仍会附带必要的 `package.json` 与许可证类文件）。
- 不发布 `src/`、`tests/`、`docs/`、`.aiw/`、`.superpowers/`、本机配置或运行数据。
- 发布前必须依次通过 lint、类型检查、全量测试、构建和包内容预检。
- 发布者手动登录 npm 并运行发布命令；自动化脚本不得保存令牌或主动发布。

## 任务 1：声明公开包元数据与发布门禁

**文件：**

- 修改：`package.json`

**结果：**

```json
{
  "name": "@nalanchujian/ai-workflow",
  "private": false,
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org"
  },
  "scripts": {
    "prepublishOnly": "pnpm lint && pnpm typecheck && pnpm test && pnpm build",
    "pack:check": "pnpm build && npm pack --dry-run",
    "publish:public": "npm publish --access public --registry=https://registry.npmjs.org"
  }
}
```

1. 修改包名和发布配置；保留 `bin.aiw`、Node/pnpm 引擎范围及 `files` 白名单。
2. 执行 `pnpm pack:check`，确认 tarball 只包含构建产物、README 和 npm 必需文件。

## 任务 2：补充使用者安装与发布者操作说明

**文件：**

- 修改：`README.md`
- 修改：`docs/05-开发实现/开发指南.md`

**结果：**

- README 以 `npm install -g @nalanchujian/ai-workflow` 作为默认安装方式；本地链接仅用于开发。
- 文档说明升级和卸载命令，以及安装后运行 `aiw doctor`。
- 开发指南说明版本递增、`npm login`、`pnpm pack:check`、`npm publish --access public --registry=https://registry.npmjs.org` 的人工发布顺序。
- 明确 npm 令牌、`~/.aiw/config.yaml`、Lark/Codex 凭据不得写入仓库或包中。

## 验证与提交

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm pack:check
git add package.json README.md docs/04-实施规划/公开npm发布实施计划.md docs/05-开发实现/开发指南.md tests/package-distribution.test.ts
git commit -m "chore: prepare public npm distribution"
```

发布者完成 npm 账号登录后，另行执行：

```bash
npm login --registry=https://registry.npmjs.org
npm publish --access public --registry=https://registry.npmjs.org
```
