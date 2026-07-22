---
task_id: 20260722-102703-links
node: impact-analysis
status: completed
attempt: 1
artifact_schema_version: 1
---

# 1. 结果

> **状态：** 完成
> **结论：** 改动集中在 Links 域内的主列表装配、详情装配、Performance、Fan list、导出与指标展示链路；现有路由、权限码和公共组件只复用与回归，不应直接扩改
> **规模：** 12 个影响项，5 条调用链，7 个回归区域，4 类公共或外部依赖

# 2. 产出

**影响项**

| 影响 ID | 类型 | 文件或区域 | 新增结论 | 上游引用 | 证据 |
| --- | --- | --- | --- | --- | --- |
| IA-001 | 必须修改 | `layouts/link-variant-page/entry/LinkVariantPage.tsx`、Custom metrics | Custom metrics 已有弹窗和列过滤能力，但入口被常量关闭，所选列与顺序仅存于组件状态，尚无按链接类型隔离的本地记忆 | RF-002 / AC-002、AC-003 | `SHOW_CUSTOM_METRICS=false`；`visibleColumnKeys`、`orderedColumnKeys` 为页面内 state；`link-list-custom-metrics/utils.ts` 仅处理筛选与排序 |
| IA-002 | 必须修改 | 主列表导出 `components/link-list-export`、`apis/list/export.ts` | 导出控制器已支持数据范围与 creator 范围，但请求不携带可见指标及顺序；当前成功路径只关闭弹窗，需要纳入异步任务提交反馈 | RF-003 / AC-002、AC-004 | `exportUtils.ts` 只组装筛选、范围和时区；`LinkListExportAction` 未接收 Custom metrics 状态 |
| IA-003 | 必须修改 | `tracking-links/TrackingInfo.tsx`、`free-trial-links/LinksInfo.tsx`、详情样式 | 两类 Details 当前都直接渲染 `LinkUserList`，没有 Performance/Fan 两个 tab；gross/net 仅作为入参直传 Fan 列表，尚无详情会话级共享状态 | RF-004、RF-005 / AC-005、AC-007 | 两个详情入口均为 `InfoHeader` 后直接挂载 `LinkUserList` |
| IA-004 | 必须修改 | `components/link-user-list/components/LinkUserPerformanceOverview.tsx` 及 Performance 数据层 | 仓库已有未装配的 Performance 头部、筛选、摘要卡和导出入口，可复用其视图骨架；当前从 `info` 静态取值，没有查询控制器、日/周趋势、趋势图或专用导出请求 | RF-005、RF-006、RF-007 / AC-006、AC-008、AC-009、AC-010 | 组件未被其他文件引用；文件内只渲染 meta、toolbar、summary grid，且 Free trial 配置仍含 Promo cost、Profit、ROI |
| IA-005 | 必须修改 | Performance 时间与 gross/net 状态边界 | 现有组件使用用户 report timezone 格式化详情时间，日期表单没有快捷范围和请求联动；需要由详情会话统一提供 gross/net，并保持主列表只读继承边界 | RF-005 / AC-006、AC-007 | `getTimezoneOffset(userInfo.reportTimezoneId)`；表单 effect 仅同步 `showNetEarnings`，未发起数据查询 |
| IA-006 | 必须修改 | `components/link-user-list` Fan 表格、查询 hook、类型和 API | 搜索、分页、更新时间与导出基础能力已存在；七列没有 sorter，请求没有排序字段，Fan 行没有 profile link/copy 能力 | RF-008、RF-009 / AC-011、AC-012、AC-013 | `useLinkUserListQuery.ts` 仅提交 `fansName/page/size`；`buildLinkUserListColumns.tsx` 定义七列但无 sorter；row 类型无 profile URL |
| IA-007 | 必须修改 | Fan 与 Performance 导出边界 | Fan 导出已有邮件弹窗和异步请求，但 payload 只有 `promotionId/accountId`；Performance 仅有按钮回调，没有专用弹窗请求链；二者都需遵循前端只提交、只反馈的边界 | RF-007、RF-009 / AC-010、AC-013 | `apis/user-list/index.ts` 的 export 参数仅两项；Performance 组件只暴露 `onOpenExport` |
| IA-008 | 必须修改 | 主列表列、Dashboard、Performance、Fan 的指标格式化 | Dashboard 已能把空值显示为 `-`，但多个链路仍把缺失值归零，且 Fan Total 无法区分部分缺失、全部缺失和真实 0；派生指标规则需在各消费边界一致验证 | RF-010、RF-011 / AC-014、AC-015 | Performance `getMetricValue` 缺失时返回 `'0'`；Fan 金额使用 `value / 100 || 0`，Total 聚合以 `|| 0` 补值；Dashboard DataItem 单独判断空值 |
| IA-009 | 需要回归 | Tracking/Free trial 页面入口、列表与详情切换 | 两类页面都在现有路由下用本地 `showInfo/info` 切换列表与详情；新增 tab 和会话状态不能破坏返回、重新打开详情、类型隔离及 creator 上下文 | RF-001、RF-004、RF-005 / AC-001、AC-005、AC-007 | `tracking-links/index.tsx`、`free-trial-links/index.tsx` 均不创建子路由，而是在页面内切换 |
| IA-010 | 需要回归 | 权限与功能开关 | Details、主列表导出、Performance 导出和 Fan 导出必须继续复用 Tracking/Free trial 的 View details/Export 权限映射；无需新增或修改全局权限码 | RF-001、RF-003、RF-004、RF-007、RF-009 / AC-016 | `shared/constants.ts` 的 `permissionTypeMap`；`LinkListRowActions.tsx`、`LinkUserListToolbar.tsx`、Performance 组件均使用全局 `Auth/FUN_PERMISSIONS` |
| IA-011 | 不可直接修改 | 全局路由、公共权限定义、公共 SortList、全局时区工具及底层 services | 这些是当前 Links 的公共依赖或稳定入口，影响分析未发现必须改变其全局语义的证据；实现应在 Links 域内适配，只有真实契约要求时才扩大边界 | RF-001、RF-012 / AC-001、AC-006、AC-016 | `src/routes/config.tsx` 已有两类路由；Custom metrics 复用公共 `SortList`；Performance/导出引用全局时区和权限；本域 API 封装 `@/services/trackingLinksNew` |
| IA-012 | 外部依赖 / 遗留风险 | 新增 API 契约、模拟数据、模块测试 | 现有本域 API 未覆盖 Performance 查询/趋势/导出、Fan 全量排序和 profile link；开发期可按已确认边界使用模拟接口，但真实接口接入必须复测映射与请求；目标模块当前没有测试文件 | RF-003、RF-006、RF-007、RF-009、RF-012 / AC-004、AC-008 至 AC-010、AC-012 至 AC-015 | `apis/API.md` 和 `apis/` 仅覆盖现有列表、Dashboard、Fan 查询/导出；模块内未检出 `*.test.*` 或 `*.spec.*` |

**调用链**

1. `src/routes/config.tsx` → Tracking/Free trial 页面入口 → 页面内 `showInfo/info` → Details 头部与 tab 装配 → Performance / Fan list。
2. `LinkVariantPage` → Custom metrics 可见项与顺序 → Link list 列 → 主列表导出控制器 → `apis/list/export.ts` → `trackingLinksNew` service。
3. Details 会话 gross/net 与日期 → Performance 控制器 → 摘要/日周趋势/导出请求 → 模拟接口，后续切换真实 API → 卡片、图表与提交反馈。
4. Fan toolbar / table sort / pagination → `useLinkUserListQuery` → `apis/user-list` → service 全量排序后分页 → Fan 行、汇总、profile copy 与导出。
5. API 原始指标 → Links 列配置 / Dashboard item / Performance metric / Fan 汇总 → 缺失值和派生指标格式化 → 页面展示与回归断言。

**回归范围**

| 区域 | 必测行为 | 上游引用 | 纳入证据 |
| --- | --- | --- | --- |
| 原入口与详情导航 | 两类原路由、列表/详情切换、返回、重开与 creator 上下文不变 | RF-001、RF-004 / AC-001、AC-005 | 页面依赖本地视图切换而非详情子路由 |
| Custom metrics 与主列表 | 显隐、拖序、本地记忆、类型隔离、切换 creator，以及列表与 Selected data 一致 | RF-002、RF-003 / AC-002 至 AC-004 | 列配置与导出目前分属两条未连接的状态链 |
| Details 共享状态 | tab 顺序、gross/net 初值、跨 tab 和导出口径同步、重开不回写主列表 | RF-004、RF-005 / AC-005、AC-007 | 当前只向 Fan list 单向传入 `showNetEarnings` |
| Performance | UTC+0、过去 30 天、卡片绑定、趋势交集、日/周、后端时间范围、异步导出反馈 | RF-005 至 RF-007 / AC-006、AC-008 至 AC-010 | 现有组件只有静态摘要骨架，无请求和趋势链 |
| Fan list | 搜索、分页、更新时间、七列双向跨页排序、profile copy、导出、请求竞态 | RF-008、RF-009 / AC-011 至 AC-013 | 查询 hook 已有请求序号与上下文重置，但排序参数尚未进入该链路 |
| 指标边界 | Promo cost 缺失/0/正数，以及派生指标分母 0、部分缺失、全部缺失和真实 0 | RF-010、RF-011 / AC-014、AC-015 | 各区域 formatter 现有空值策略不一致 |
| 权限与外部契约 | 两类页面的 View details/Export 权限矩阵；模拟与真实 API 的参数、映射和错误反馈 | RF-001、RF-003、RF-007、RF-009、RF-012 / AC-016 | 多个入口各自执行权限控制，新增接口尚无现成契约或模块测试 |

# 3. 待确认

无

# 4. 下一步

- 当前动作：由编排器展示本节点 Gate
- 完成条件：Owner 确认改动边界、公共依赖和回归范围
