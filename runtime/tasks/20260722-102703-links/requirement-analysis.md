---
task_id: 20260722-102703-links
node: requirement-intake
status: completed
attempt: 1
artifact_schema_version: 1
---

# 1. 结果

> **状态：** 已完成
> **结论：** Links 改造范围已整理，8 个业务或契约边界均已由 Owner 确认
> **规模：** 12 个需求主题，8 个确认项

# 2. 产出

**范围**

| 类型 | 内容 | 依据 |
| --- | --- | --- |
| 包含 | Tracking/Free trial 主列表、Custom metrics、导出、Details、Performance overview、Fan list、缺失指标规则 | 3 张需求图、4 张设计图 |
| 排除 | 不新增业务路由或权限码；前端不实现后端数据生产、导出任务和邮件服务 | 当前路由、权限和前后端边界 |
| 约束 | 复用 View details/Export 权限；未知接口、上线时间和邮件正文不得自行补全 | `PERMISSIONS.md`、`API.md` 与资料缺口 |

**需求事实**

| 事实 ID | 模块 | 目标行为 | 当前差异 | 来源 | 状态 |
| --- | --- | --- | --- | --- | --- |
| RF-001 | 页面范围 | Tracking 与 Free trial 继续使用现有入口，两类页面共同改造 | 路由已存在 | 全部需求图；`src/routes/config.tsx` | 已确认 |
| RF-002 | Custom metrics | 两类主列表可调整指标显示和顺序，本地记忆结果并影响 Selected data 导出 | 入口被 `SHOW_CUSTOM_METRICS=false` 隐藏，状态未持久化、未传给导出 | `xq/image (1).png`；`LinkVariantPage.tsx` | 需确认 |
| RF-003 | 主列表导出 | 支持 All/Selected creator 与 All/Selected data；Selected data 和页面字段一致；文件名按统一规则生成 | 当前 payload 不含指标集合与顺序，文件名由后端决定 | `xq/image (1).png`；现有导出代码 | 需确认 |
| RF-004 | Details | 第一个 tab 为 Performance overview，第二个为 Fan list，并继续受 View details 权限控制 | 当前 Details 直接展示 Fan list，没有 tabs | `xq/image (2).png`、`xq/image.png`；`sjg/image (3).png`、`sjg/image (4).png` | 已确认 |
| RF-005 | Performance 筛选 | 展示 creator/创建/更新时间；UTC+0；过去 30 天快捷日期；gross/net 控制当前详情数据 | 当前未装配组件使用 report timezone，日期和 gross/net 状态边界不完整 | `xq/image (2).png`；`sjg/image (3).png`、`sjg/image (6).png` | 需确认 |
| RF-006 | Performance 指标 | 两类链接分别展示摘要卡和日/周趋势，排除 promo cost 相关指标，只使用上线后数据 | 资料中的指标集合不一致；当前没有趋势查询和图表 | `xq/image (2).png`；`sjg/image (3).png` | 需确认 |
| RF-007 | Performance 导出 | 异步邮件导出两张 sheet，并使用统一文件名和邮件模板 | 当前没有专用导出接口，也没有可核验的完整邮件模板 | `xq/image (2).png`；`sjg/image (5).png` | 需确认 |
| RF-008 | Fan list | 作为第二个 tab，保留搜索、更新时间、分页和导出 | 基础能力已存在 | `xq/image.png`；`sjg/image (4).png` | 已确认 |
| RF-009 | Fan 增强 | 七列支持跨页排序；Fan 提供 Copy profile link；导出增加 profile link 并统一文件名 | 当前无 sorter、排序参数和 profile URL 字段 | `xq/image.png`；`sjg/image (4).png`；当前 Fan list 代码 | 需确认 |
| RF-010 | Promo cost | Links 列表、导出和 Dashboard 中未配置或为 0 时显示 `-` | 当前 formatter 常把缺失值转为 0 | `xq/image.png`；当前 formatter | 已确认 |
| RF-011 | 派生指标 | 分子/分母缺失或分母为 0 时显示 `-`；部分缺失按 0 汇总，全部缺失显示 `-` | 当前实现不能区分真实 0、部分缺失和全部缺失 | `xq/image.png`；当前表格和 Dashboard | 已确认 |
| RF-012 | 外部契约 | 新能力必须使用真实 API、数据、上线时间和邮件契约，不使用前端模拟或猜测字段 | 现有 `API.md` 未覆盖新增能力 | 全部资料；`API.md`、`apis/` | 需确认 |

# 3. 待确认

| 问题 ID | 决策 ID | 来源事实 | 需要确认 | 采用规则 | 状态 |
| --- | --- | --- | --- | --- | --- |
| RQ-001 | CL-001 | RF-002 | Custom metrics 保存范围 | 浏览器本地保存；刷新、重进和切换 creator 保留；Tracking/Free trial 分开；不同设备不同步；退出登录不清除 | 已人工确认 |
| RQ-002 | CL-002 | RF-006 | Performance 指标集合 | 指标卡片以当前数据绑定的指标为准；趋势图以设计稿定义的 4 个指标为候选白名单，仅展示“当前已选择指标”与“设计稿 4 个指标”的交集 | 已人工确认 |
| RQ-003 | CL-003 | RF-003、RF-007、RF-009 | 三类导出文件名 | 三类导出统一由后端异步生成并通过邮件发送；前端只提交导出条件并展示任务提交结果或错误，不在浏览器生成文件或触发直接文件下载；文件名与邮件附件名由后端导出契约负责 | 已人工确认 |
| RQ-004 | CL-004 | RF-009 | Fan 排序范围和责任 | Fan、Total、Subs、Posts、Messages、Streams、Tips 均可升降序；初始沿用后端默认；服务端对全部结果排序后分页 | 已人工确认 |
| RQ-005 | CL-005 | RF-005 | Details gross/net 状态 | 继承主列表当前值，无值时默认关闭；统一影响 Performance、Fan list 和导出；仅当前详情会话生效，不回写主列表 | 已人工确认 |
| RQ-006 | CL-006 | RF-012 | 新接口契约与开发准入 | 开发阶段暂时使用模拟接口；后续真实接口提供后，再更新并接入真实接口 | 已人工确认 |
| RQ-007 | CL-007 | RF-007、RF-012 | 邮件模板和失败处理 | 前端弹窗按照设计稿实现；邮件标题、正文、失败和重试规则由后端负责，前端不处理 | 已人工确认 |
| RQ-008 | CL-008 | RF-006、RF-012 | 上线时间和趋势边界 | 前端不处理时间范围逻辑，后端返回什么时间范围的数据，前端就展示对应时间范围 | 已人工确认 |

# 4. 下一步

- 当前动作：Owner 确认整份需求定义
- 完成条件：需求受理 Gate 获得批准
