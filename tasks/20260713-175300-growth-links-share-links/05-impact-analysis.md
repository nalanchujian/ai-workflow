---
artifact: impact-analysis
task_id: 20260713-175300-growth-links-share-links
node: impact-analysis
skill: 05-impact-analysis
status: completed
target_module: /src/pages/growth/links
inputs:
  - 01-requirement-analysis.md
  - 02-requirement-clarification.md
  - 03-change-assessment.json
  - 04-acceptance-checklist.md
depends_on:
  - requirement-intake
  - requirement-clarification
  - change-assessment
  - acceptance-design
---

# Links Share Links 影响分析

## 结论

- 本需求影响 Tracking links 和 Free trial links 共用的页面装配层，不是单一 Tab 的局部改动。
- 新版 Share links 已具备独立的列表态、弹窗态和 v2 API 层；实施应在现有边界内补齐，不应回退到页面层直接编排请求。
- 灰度关闭时仍需保持旧行内分享流程可用，因此新版改动不能影响 `legacy-share-link` 目录及其旧接口调用。
- 发现 3 个需要在实施方案中明确处理的风险：编辑后的异步状态补刷、提交前配额二次校验、列表日期的报告时区格式化。

## 关键文件与职责

| 范围 | 关键文件 | 当前职责 | 影响等级 |
| --- | --- | --- | --- |
| 页面装配与灰度 | `layouts/link-variant-page/entry/LinkVariantPage.tsx` | 组合 Links list、Dashboard、Share links；基于 `newShareLinkV1` 和 `ShareLink` 权限切换新旧入口 | P0 |
| Tab 生命周期 | `layouts/navigation-tabs/entry/NavigationTabs.tsx` | 仅挂载当前激活 Tab；切换到 Share links 时会重新建立其请求和本地状态 | P1 |
| 新版入口 | `components/share-links-tab/entry/TrackingShareLinksTab.tsx` | 装配指标、列表和弹窗 controller，并区分空态/列表态 | P0 |
| 列表状态 | `components/share-links-tab/hooks/useShareLinksList.ts` | 列表、搜索、分页、配额请求和并发结果保护 | P0 |
| 列表行操作 | `components/share-links-tab/hooks/useShareLinksListController.tsx` | 删除确认、复制、预览和配额刷新 | P0 |
| 表单状态 | `components/share-links-tab/hooks/useShareLinkModalFormState.ts` | 弹窗开关、名称、Creator/Link 分组、指标与字段错误状态 | P0 |
| 表单编排 | `components/share-links-tab/hooks/useShareLinkModalController.tsx` | Creator 选项、Link 下拉、编辑回填、数量限制和弹窗动作编排 | P0 |
| 提交状态 | `components/share-links-tab/hooks/useShareLinkModalSubmission.ts` | 创建/编辑、错误映射、生成信息弹窗、刷新策略 | P0 |
| Link 选项 | `components/share-links-tab/hooks/useShareLinkTrackingLinkOptions.ts` | 按 Creator 搜索、20 条分页、并发去重、滚动加载和已选项回填 | P1 |
| 指标状态 | `components/share-links-tab/hooks/useShareLinkMetrics.ts` | 每次进入当前类型时拉取最新指标，并提供列表/表单共用映射 | P1 |
| API 层 | `apis/share-link/index.ts`、`apis/share-link/types.ts` | 按 Tracking/Trial 分流 v2 的 metrics、limit、page、save、update、delete 接口 | P0 |
| 数据映射 | `components/share-links-tab/utils/shareLinkMappers.ts` | 列表字段、状态、Creator、指标、日期时间和复制内容映射 | P0 |
| 错误映射 | `components/share-links-tab/utils/shareLinkErrors.ts` | 重名、记录不存在、Creator 掉线等错误的统一落点 | P0 |
| 视图与表格 | `components/share-links-tab/components/ShareLinksList.tsx`、`components/share-links-tab/components/share-links-list/*` | 表格列、固定 Actions、Creator Tooltip、复制冷却和分页 UI | P1 |
| 表单视图 | `components/share-links-tab/components/ShareLinkFormModal.tsx`、`components/share-links-tab/components/share-link-form/ShareLinkGroupCard.tsx` | 必填禁用态、Creator 去重、Link 上限后仅允许删除、下拉触发加载 | P1 |
| 日期工具 | `shared/utils/dateTime.ts` | Links 域日期格式化 | P1 |
| 旧流程回退 | `legacy-share-link/*` | 灰度关闭时的行内旧分享弹窗及旧接口 | P0，不可与新版混改 |
| 权限与文档 | `PERMISSIONS.md`、`FLOW.md`、`API.md` | 权限、流程、接口说明 | P2 |

## 必须处理的差异

| 问题 | 代码现状 | 需求影响 | 实施边界 |
| --- | --- | --- | --- |
| 编辑后的状态补刷 | `useShareLinkModalSubmission` 仅在创建成功后调用 15 秒补刷；编辑成功后只有一次立即刷新 | 编辑后的数据可能长期停留在 Processing，和已确认的 Processing -> Active 可见状态流不一致 | 复用 `useShareLinkPostCreateRefresh`，让创建和编辑均安排一次延迟补刷；卸载或重复提交时清理旧 timer |
| 配额提交前二次校验 | 当前只基于初次/列表刷新得到的 `hasReachedShareLinkLimit` 拦截；提交前不会重新查询 limit | 多人并发创建或页面停留后，前端仍可能发出超限请求 | 在创建提交前重新拉取当前类型配额；达到上限则保留在弹窗并提示，不发 save 请求；后端仍为最终兜底 |
| 列表日期时区 | `formatLinkDisplayDateTime` 直接使用本地 `dayjs(value)`，未接入页面报告时区 | Last updated、Date created 与页面 Header 时区可能不一致 | 从统一用户报告时区来源读取 offset，并在 Share links 列表日期渲染中使用；空值仍显示 `-` |

## 需要回归的行为

| 分类 | 回归重点 |
| --- | --- |
| 灰度与权限 | `newShareLinkV1` 开启时只显示新版 Tab；关闭时只保留旧行内分享入口；无 `ShareLink` 权限时两者均不可见 |
| 类型隔离 | Tracking 和 Free trial 使用各自的 page、metrics、limit、save、update、delete URL；列表、指标、配额不能串类型 |
| Tab 切换 | Share links 每次激活后重新拉取列表、配额、指标；切换不应影响 Links list/Dashboard 的共享筛选和当前 Creator |
| 列表 | 默认每页 50、搜索清空、翻页、固定 Actions、空态、长文本、多 Creator Tooltip、日期空值与日期时区 |
| 表单 | 名称/Creator/Link/指标未完成时按钮禁用；Creator 去重；Link 搜索、分页、停用过滤、编辑 label 回填、上限后仍可展开并删除已选项 |
| 状态与操作 | `dataReady=false` 为 Processing，编辑禁用但预览/复制/删除可用；`dataReady=true` 为 Active，全部操作可用 |
| 异常 | 重名字段错误、Creator 掉线字段错误与状态点、记录不存在提示、创建/编辑/删除普通失败不做乐观更新 |

## 公共依赖与外部契约

| 依赖 | 用途 | 风险或约束 |
| --- | --- | --- |
| `appFunctionPower` / `getLinkListSharePermission` | ShareLink 权限控制 | 新 Tab、列表操作和旧入口必须保持同一权限口径 |
| `useQueryAccountFeatureInfo` | `newShareLinkV1` 灰度 | 功能开关未返回前不能误展示旧/新入口；关闭灰度必须可回退 |
| `queryLinks` | Creator 下的 Link 选择 | 必须继续传 `showDeactivatedLinks: false`、`size: 20`、当前 accountId 和搜索词 |
| Share link v2 list | 列表、编辑回填、状态和 Creator 信息 | 依赖 `shareId`、`shareUrl`、`linkInfo`、`tlCustomMetrics`/`ftlCustomMetrics`、`dataReady`、`createdAt`、`dataLastUpdateTime` |
| Share link v2 limit | Agency 配额和表单上限 | 依赖 `shareLinkNumLimit`、`linkNum`、`shareLinkCreatorLimit`、`shareLinkCreatorLinksLimit`；字段缺失时目前使用前端默认值 |
| `modelBindStatus` | Creator 状态点 | 列表必须以接口 `linkInfo.modelBindStatus` 为准；删除 Creator 由后端过滤 |
| Electron `openExternalUrl` | 预览分享链接 | 不改为当前窗口跳转或 `window.open` |
| `HBModal`、`HBRcSelect`、`HBUserSelect`、`HBTable`、`HBPagination` | 弹窗、选择器、表格和分页 | 保持组件默认行为；样式只能在 Share links 局部范围调整 |

## 不可直接修改的边界

- 不修改分享落地页、验证码校验和落地页数据移除逻辑。
- 不由前端猜测已删除 Creator 的状态枚举或自行过滤，后端不返回即不展示。
- 不阻断编辑态中已经关联、后续被停用的历史 Link；新选项仍需过滤停用 Link。
- 不移除 `legacy-share-link` 或旧接口：灰度关闭时它仍是可用回退路径。
- 不将 Share links 的筛选状态并入 Links list/Dashboard 的共享表单；Share links 的名称搜索、分页和配额必须独立。

## 遗留风险与实施前验证

| 优先级 | 风险 | 处理建议 |
| --- | --- | --- |
| P1 | API 层 page 函数的默认 `size` 仍是 1000，而当前列表 hook 显式传 50 | 保持调用方显式传 50；补充接口层测试或将默认值改为 50 前先确认无其他调用方依赖 1000 |
| P1 | 配额接口失败时会退回本地 50 / 100 / 无限 Creator 数 | 联调确认接口稳定返回；若缺字段，需确认默认值是否符合产品规则，避免放宽 Creator 限制 |
| P1 | Tab 切换会卸载 Share links，重新请求 metrics、list、limit | 这是“每次切换刷新”的已确认行为；需验证请求次数不因子组件重复挂载而放大 |
| P2 | `FLOW.md` 仍引用已拆除的 `useShareLinksController.tsx`，并描述已移除的 Link 选项缓存 | 在功能改动完成后同步更新流程文档，避免排查路径失真 |
| P2 | `TrackingShareLinksTabProps` 的 `currentAccountId` 与 `currentRows` 当前未被新版入口使用 | 本期不动；后续清理前需确认没有计划中的列表联动用途 |

## 建议实施边界

1. 先修改 Share links 的提交与刷新策略，不触碰主 Links list/Dashboard 的筛选控制器。
2. 日期时区只通过 Links 域共享格式化能力接入，避免在表格列中单独拼 offset。
3. 配额校验统一通过 `useShareLinksList` 暴露的最新配额能力，避免在弹窗内重复拼 limit 接口。
4. 完成功能后同步更新 `FLOW.md`；权限、API 契约若没有变化则不重写。

## 节点交接

- 当前节点：影响分析。
- 状态：`completed`。
- 下一节点：实施设计。
- 下一节点输入：需求解析、澄清结论、变更评估、验收清单和本影响分析。
- 下一节点产物：`06-implementation-plan.md`。
