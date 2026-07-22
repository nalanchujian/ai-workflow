---
task_id: 20260722-102703-links
node: implementation-design
status: completed
attempt: 1
artifact_schema_version: 1
---

# 1. 结果

> **状态：** 完成
> **结论：** 方案在 Links 域内以 Custom metrics 状态、详情会话、Performance facade、Fan 查询和统一指标格式化五条边界实施，不改全局路由、权限码或公共组件语义
> **规模：** 8 个工作包，9 条行为契约，3 条验证命令，4 组验收场景，1 个真实 API 上线条件

# 2. 产出

**工作包与文件**

| 工作包 | 目标 | 文件或目录 | 动作 | 上游引用 | 完成标志 |
| --- | --- | --- | --- | --- | --- |
| WP-01 | 持久化 Custom metrics 并传递选择上下文 | `components/link-list-custom-metrics/{types.ts,utils.ts,index.ts}`；新增 `hooks/useLinkListCustomMetricsState.ts`；`layouts/link-variant-page/entry/LinkVariantPage.tsx` | 新增 hook；修改装配与类型 | RF-002 / AC-002、AC-003 / IA-001 | 两类存储隔离；入口启用；列表、详情快照和导出读取同一顺序 |
| WP-02 | 让主列表导出提交完整异步任务条件 | `components/link-list-export/{types.ts,entry,components,hooks,utils}`；`apis/list/export.ts` | 修改 payload、loading 与反馈 | RF-003 / AC-004 / IA-002 | All/Selected creator 与 data 组合正确；Selected data 携带当前指标顺序；无下载动作 |
| WP-03 | 建立 Details 两 tab 与会话级共享状态 | 新增 `components/link-user-list/entry/LinkDetails.tsx`；修改 `index.ts`、`types.ts`、样式、`TrackingInfo.tsx`、`LinksInfo.tsx`、两类页面入口类型 | 新增详情装配；替换直接 Fan 挂载 | RF-004、RF-005 / AC-005、AC-007 / IA-003、IA-009 | 默认进入 Performance；Fan 为第二 tab；gross/net 跨 tab 同步且退出详情即丢弃 |
| WP-04 | 完成 Performance 摘要、趋势、日期和导出 UI | 修改 `LinkUserPerformanceOverview.tsx`、`constants.ts`、`types.ts`、样式；新增 `LinkUserPerformanceTrend.tsx`、`LinkDetailsExportModal.tsx`、`hooks/useLinkUserPerformanceController.ts` | 复用现有视图骨架并补齐控制器/图表 | RF-005 至 RF-007 / AC-006、AC-008 至 AC-010 / IA-004、IA-005、IA-007 | UTC+0、日期预设、日/周、卡片、趋势、空态及导出弹窗可观察 |
| WP-05 | 隔离 Performance 模拟接口和未来真实接口 | 新增 `apis/performance/{index.ts,mock.ts}`；修改 `apis/index.ts`、`API.md` | 新增本域 facade、DTO 与 mock | RF-006、RF-007、RF-012 / AC-008 至 AC-010 / IA-012 | 组件只依赖 facade；mock 覆盖两类型、日周、空值、成功和失败；真实 API 可在 facade 层替换 |
| WP-06 | 增强 Fan 搜索、跨页排序、profile copy 与导出 | `components/link-user-list/{types.ts,entry,components,hooks,utils,styles}`；`apis/user-list/index.ts` | 修改查询状态、列配置、行映射和导出 | RF-008、RF-009 / AC-011 至 AC-013 / IA-006、IA-007 | 七列双向服务端排序；翻页保持排序；复制真实 profile link；导出只提交任务 |
| WP-07 | 统一缺失值、Promo cost 与派生指标展示 | 新增 `shared/utils/metricDisplay.ts`；修改 `shared/index.ts`、`linkTableColumns.tsx`、两类 `config.tsx`、Dashboard constants/types/data/item、Fan 汇总及 Performance formatter | 新增纯规则；替换各处归零逻辑 | RF-010、RF-011 / AC-014、AC-015 / IA-008 | 页面能区分缺失、真实 0、分母 0、部分缺失和全部缺失；导出责任仍在后端 |
| WP-08 | 固定权限、发布与回归边界 | `LinkListRowActions.tsx`、`LinkUserListToolbar.tsx`、Performance 导出入口仅回归；`API.md` 记录 mock/real 切换 | 回归并补文档；不改权限定义 | RF-001、RF-012 / AC-001、AC-016 / IA-010 至 IA-012 | 原路由与 View details/Export 权限矩阵通过；未新增权限码、路由或依赖；无删除文件 |

**行为契约**

| 契约 ID | 类型 | 输入或触发 | 处理规则 | 输出与异常 | 上游引用 |
| --- | --- | --- | --- | --- | --- |
| CT-001 | 状态 | 页面类型、默认 metric options、用户 Apply | 使用版本化 key `infloww.links.custom-metrics.v1.<type>`；读取时去重、过滤失效 key 并按默认顺序补入新 key；仅 Apply 写入；不含 creator 或登录态 | JSON 损坏或存储不可用时回退全部默认项；Tracking/Free trial 独立；切换 creator、刷新和重新登录不清除 | RF-002 / AC-002、AC-003 / IA-001 |
| CT-002 | 数据 / API | 主列表导出范围、筛选表单、visible/order keys | All data 不发送自定义列限制；Selected data 按当前可见顺序发送 `metricKeys`；creator、日期、source、tag、gross/net 与现有筛选一起提交 | 请求期间禁止重复提交；成功关闭弹窗并提示任务已提交；失败保留弹窗并提示错误；绝不生成 Blob、文件或下载链接 | RF-003 / AC-004 / IA-002 |
| CT-003 | 状态 / 权限 | 点击已有 Details；行记录含 gross/net 与指标快照 | `LinkDetails` 默认 `performance`；gross/net 初值为行上下文值，无值为 `false`；状态只由详情持有并传给两 tab 与导出；返回后销毁 | 无 View details 权限仍由原按钮入口拦截；切换 tab 不丢状态；不调用主列表 form setter | RF-004、RF-005 / AC-005、AC-007、AC-016 / IA-003、IA-009、IA-010 |
| CT-004 | 时间 / API | Performance 打开或日期、粒度、gross/net 改变 | 头部时间用 `dayjs.utc` 显示 UTC+0；默认 Last 7 days，提供 Yesterday、Last 7、Last 30 与过去 30 天内自定义；Day 默认，Week 仅在选择 14–30 天时可用；start/end 以 UTC+0 边界提交 | 最新请求生效，旧响应丢弃；前端按返回点原样绘制，不补点、不裁剪、不推断上线时间；失败显示空态与错误 | RF-005、RF-006 / AC-006、AC-007、AC-009 / IA-004、IA-005 |
| CT-005 | 数据 | Performance facade 返回摘要与趋势；详情携带 selected metric keys | 摘要卡按两类现有数据绑定配置渲染并移除所有 promo-cost 相关项；趋势使用“选中项 ∩ 类型白名单”：Tracking 为 Clicks/Subs/Fans who spent/Earnings，Free trial 为 Claims/Fans who spent/Earnings | 非交集项不进 legend/series；空序列显示空态；金额、百分比和数字统一走 metric display 规则 | RF-006 / AC-008、AC-009 / IA-004、IA-008 |
| CT-006 | API / 权限 | Performance Export；当前详情、日期、粒度、gross/net、指标集合 | 复用原 `<type>Export` 权限；facade 提交两 sheet 所需条件，前端不拼文件名、邮件标题/正文或重试任务 | loading 防重；成功关闭并提示；失败保留弹窗；无浏览器下载；邮件与后台重试由后端负责 | RF-007、RF-012 / AC-010、AC-016 / IA-007、IA-010、IA-012 |
| CT-007 | API / 状态 | Fan 搜索、分页或七列表头排序 | 查询 DTO 增加语义化 `sortField` 和 `sortOrder`；初始二者为空使用后端默认；排序/搜索回第一页，分页保留搜索与排序；详情上下文变化全部重置；沿用 requestId 防竞态 | facade/服务端先全量排序再分页；非 0 或异常提示失败；旧上下文响应不得覆盖当前行 | RF-008、RF-009 / AC-011、AC-012 / IA-006 |
| CT-008 | 数据 / API | Fan row、profile link、gross/net 与导出 | row 增加 `profileLink`；复制只使用接口字段，不由 fanId 猜 URL；Fan/Total/Subs/Posts/Messages/Streams/Tips 均声明 server sorter；Fan 导出携带详情上下文和 gross/net | 缺少 profileLink 时禁用复制且不写剪贴板；复制成功有反馈；导出成功/失败同 CT-006，附件字段由后端保证 | RF-005、RF-009 / AC-007、AC-012、AC-013 / IA-006、IA-007 |
| CT-009 | 数据 | 列表、Dashboard、Performance、Fan 原始指标 | `isMetricMissing` 区分空值与真实 0；Promo cost 为缺失或 0 时显示 `-`；派生指标分母缺失/0 或结果不可计算时显示 `-`；聚合时部分缺失按 0、全部缺失为 `-`；不在 formatter 猜后端值 | 普通真实 0 正常格式化；invalid/NaN 显示 `-`；Dashboard 不再以 `?? '0.00'` 掩盖缺失；相同 fixture 在各区域结果一致 | RF-010、RF-011 / AC-014、AC-015 / IA-008 |

**验证与回滚**

- 验证命令：`yarn tsc --noEmit`；`yarn eslint src/pages/growth/links --max-warnings=0`；`yarn build:test`。三条均退出码 0 才进入完整验收；仓库当前无自动化测试 runner，本次不引入新测试框架。
- 验证场景：按 `AC-001` 至 `AC-004` 验证两类主列表、持久化和四种导出组合；按 `AC-005` 至 `AC-010` 验证详情、时间、指标、日周趋势和 Performance 导出；按 `AC-011` 至 `AC-013` 用至少两页 mock 数据验证搜索、七列排序、竞态、复制和 Fan 导出；按 `AC-014` 至 `AC-016` 验证缺失值矩阵与权限矩阵。
- 测试数据：mock 同时提供 Tracking/Free trial、白名单内外指标、日/周及不同起止时间、空序列、导出成功/失败、Fan 两页与七列乱序、有效/缺失 profile link，以及缺失、0、正数、部分缺失、全部缺失和分母 0。
- 灰度：不新增运行时业务开关；mock facade 只允许开发/测试环境。生产发布条件是 API Owner 提供真实 Performance、Fan 排序/profile 与异步导出契约，并按 `AC-004`、`AC-008` 至 `AC-015` 复测参数和映射。
- 回滚：功能或权限回归时整体回退本次 Links 改动；版本化 localStorage key 与旧页面无耦合，可保留或单独删除；真实 API 联调失败时只回退 facade 适配层，非生产环境可继续使用 mock，生产环境回退到上一稳定版本。

# 3. 待确认

无

# 4. 下一步

- 当前动作：由编排器展示授权开发的 Gate
- 完成条件：Owner 确认工作包、行为契约、验证与回滚方案，并授权下一节点修改业务代码
