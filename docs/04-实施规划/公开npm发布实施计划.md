# 公开 npm 发布实施计划

> 实施时按测试驱动方式执行；每个任务完成后运行对应验证，再进行提交。

## 目标

维护可从 npm 公共 Registry 安装的 `aiw` CLI：包名为 `@nalanchujian/aiw`，全局命令保持为 `aiw`。发布只能由发布者在本机显式触发，AIW 的日常任务流程和 CI 不会自动发布。

## 发布边界

- npm Registry 固定为 `https://registry.npmjs.org`，公开访问级别为 `public`。
- 发布物仅包含 `dist/` 与 `README.md`（npm 仍会附带必要的 `package.json` 与许可证类文件）。
- 不发布 `src/`、`tests/`、`docs/`、`.aiw/`、`.superpowers/`、本机配置或运行数据。
- 发布前必须依次通过 lint、类型检查、全量测试、构建和包内容预检。
- 发布者手动登录 npm 并显式运行发布命令；发布脚本可以调用 `npm publish`，但不得保存令牌或在其他命令中隐式触发。

## 任务 1：声明公开包元数据与发布门禁

**文件：**

- 修改：`package.json`

**结果：**

```json
{
  "name": "@nalanchujian/aiw",
  "private": false,
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org"
  },
  "scripts": {
    "prepublishOnly": "pnpm lint && pnpm typecheck && pnpm test && pnpm build",
    "pack:check": "pnpm build && npm pack --dry-run",
    "publish:public": "node scripts/assert-release-ready.mjs && npm publish --access public --registry=https://registry.npmjs.org && node scripts/commit-published-package.mjs"
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

- README 以 `npm install -g @nalanchujian/aiw` 作为默认安装方式；本地链接仅用于开发。
- 文档说明升级和卸载命令，以及安装后运行 `aiw doctor`。
- 开发指南说明版本递增、`npm login`、`pnpm pack:check`、`npm publish --access public --registry=https://registry.npmjs.org` 的人工发布顺序。
- 明确 npm 令牌、`~/.aiw/config.yaml`、文档连接器/Codex 凭据不得写入仓库或包中。

## 当前发布流程

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm pack:check
git status --short
```

确认业务代码和文档已经提交、工作区干净后，发布者登录 npm 并执行补丁版本发布：

```bash
npm login --registry=https://registry.npmjs.org
pnpm release:patch
```

`release:patch` 先检查工作区干净，再递增 `package.json` 补丁版本并调用 `publish:public`。发布过程通过 `prepublishOnly` 再次执行 lint、类型检查、测试和构建；发布成功后自动创建仅包含 `package.json` 的 `chore: release v<version>` 提交，不创建 Git tag，也不自动 push。npm 发布失败时不会生成发布提交。

需要 minor 或 major 版本时，由发布者显式运行对应版本递增，再执行 `pnpm publish:public`。npm 上已经发布的包版本不可覆盖。
