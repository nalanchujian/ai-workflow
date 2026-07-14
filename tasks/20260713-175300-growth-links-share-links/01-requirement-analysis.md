---
artifact: requirement-analysis
task_id: 20260713-175300-growth-links-share-links
node: requirement-intake
status: completed
target_module: /src/pages/growth/links
inputs:
  - requirement-screenshot
  - design-screenshot
depends_on: []
---

# Links Share Links 需求解析包

## 结论

- 目标：核对 Free trial links 与 Tracking links 的 Share links 新版功能。
- 已确认范围：新版入口、列表、创建编辑、配额、复制、预览、删除、Creator 与 Link 级联。
- 需要确认：Creator 删除与异常状态、已停用 Link 标记、有效期规则、配额计算范围。

## 截图与资料范围

- 需求文档截图：本任务第 1 张图片。
- 设计稿截图：本任务第 2 张图片。
- 当前代码：`src/pages/growth/links`。
- 截图未覆盖：接口字段和状态枚举、有效期交互、异常状态视觉、配额是否跨类型共享。

## 需求事实表

| 分类 | 需求或设计要求 | 当前实现 | 结论 |
| --- | --- | --- | --- |
| 页面与入口 | 顶部 Share links Tab，关闭旧行内分享入口 | `newShareLinkV1` 命中时展示新版 Tab；未命中时保留旧入口用于灰度 | 灰度期符合 |
| 表单校验 | 名称、Creator、Link、指标必填；指标默认全选 | 字段不完整时 Create 或 Done 按钮禁用；创建时默认选中全部接口指标 | 已实现 |
| Creator | 支持搜索、添加分组、不可重复选择、数量受限 | 支持搜索和去重；数量读取配额接口 | 已实现，固定上限待确认 |
| Link | 支持搜索、分页、排除停用、单 Creator 数量受限 | 查询参数为 `showDeactivatedLinks: false`，每页 20 条，达到上限后保留删除能力 | 已实现 |
| 指标 | 按 links 类型读取，默认展示全部 | 通过 metrics 接口读取；Tracking 使用 `tlCustomMetrics`，Free trial 使用 `ftlCustomMetrics` | 已实现 |
| 状态 | 创建后 Processing，处理完成后 Active | `dataReady=false/true` 映射为 Processing/Active；创建后 15 秒补刷 | 已实现 |
| 列表 | 名称、验证码、Creator、状态、指标、更新时间、创建时间、操作 | 当前列与设计截图一致 | 已实现 |
| 操作 | Processing 不能编辑；支持预览、复制、删除 | 编辑按钮禁用；预览、复制和删除保留 | 已实现 |
| 配额 | 展示 `(X/50)`，超限禁止创建 | 配额接口驱动表头与创建按钮禁用 | 已实现 |
| Creator 异常 | 删除 Creator 不展示；其他异常展示状态点 | 当前按 `modelBindStatus` 渲染状态点，未见删除 Creator 前端过滤 | 待确认接口责任 |
| Link 停用后 | 详情保留数据，并展示 deactivated 标记 | 创建下拉排除停用 Link；Share links 列表没有停用标记字段 | 需补齐或确认后端处理 |
| 有效期 | 解绑后过期、过期默认隐藏、支持过期更新 | 当前没有有效期字段、筛选或更新操作 | 与当前实现不一致 |

## 设计截图与当前页面差异

| 优先级 | 区域 | 差异 | 建议处理 |
| --- | --- | --- | --- |
| P1 | Creator 异常状态 | 当前会渲染接口返回的全部 `linkInfo`，没有删除状态的显式过滤 | 确认 `modelBindStatus` 删除枚举及后端是否已经过滤 |
| P1 | 已停用 Link | 当前列表没有 deactivated 标记 | 列表接口需提供状态字段，或确认不属于前端展示范围 |
| P2 | 有效期 | 需求包含过期隐藏和过期更新，设计截图和当前页面均未呈现 | 确认该规则是否已废弃 |
| P2 | 分页 | 设计截图静态展示每页 10 条，当前默认每页 50 条 | 以最新产品口径确认 |
| P2 | 编辑后刷新 | 编辑后只立即刷新；创建后才会 15 秒补刷 | 若编辑也异步处理，补充刷新策略 |

## 初步影响范围

| 范围 | 主要位置 | 风险 |
| --- | --- | --- |
| 新旧入口与灰度 | `layouts/link-variant-page/entry/LinkVariantPage.tsx` | 影响旧分享入口与新版 Tab 的切换 |
| 列表与行操作 | `components/share-links-tab/components/ShareLinksList.tsx`、`components/share-links-tab/components/share-links-list/` | 固定列、分页、状态按钮和复制反馈 |
| 创建编辑弹窗 | `ShareLinkFormModal.tsx`、`share-link-form/`、`hooks/useShareLinkModal*.ts` | 分组回填、数量限制、Creator 异常校验 |
| 接口和字段映射 | `apis/share-link/`、`utils/shareLinkMappers.ts`、`utils/shareLinkErrors.ts` | API 字段、状态码、配额和异常语义 |
| Creator 状态 | `ShareLinksCreatorCell.tsx`、`shared/utils/creatorUserData.ts` | 状态枚举和删除过滤责任 |

## 待确认项

| 问题 | 为什么需要确认 | 阻塞内容 |
| --- | --- | --- |
| 50 条配额是否按类型分别计算 | 当前接口按 Tracking/Free trial 分路由，需求截图未明确 | 配额展示和创建拦截 |
| 删除 Creator 的状态枚举 | 当前只消费 `modelBindStatus`，未识别删除状态 | 列表隐藏规则 |
| 停用 Link 状态字段 | 当前列表接口类型没有该字段 | deactivated 标记 |
| 有效期与过期更新是否保留 | 需求文字与当前设计/实现不一致 | 是否新增字段、操作和筛选 |
| 编辑后是否需要补刷 | 需求只描述最终状态，没有规定前端刷新方式 | Processing 到 Active 的体验 |

## 验收清单摘要

- [ ] 命中新灰度且有分享权限时，仅展示新版 Share links Tab。
- [ ] 名称、Creator、Link、指标完整后才能创建或保存。
- [ ] Creator 与 Link 下拉支持搜索、分页、去重和数量限制。
- [ ] 创建后先显示 Processing，再更新为 Active。
- [ ] Processing 行编辑禁用，预览、复制、删除可用。
- [ ] 达到配额后，列表态和空态的创建按钮均禁用并展示提示。
- [ ] 单/多 Creator 的头像、名称、昵称、链接数和状态点符合设计。
- [ ] 删除、复制、预览与失败提示符合预期。

## 需求解析包

```yaml
artifact: requirement-analysis
version: 1
target_module: /src/pages/growth/links
sources:
  requirement_screenshot: 本任务第1张图片
  design_screenshot: 本任务第2张图片
  limitations:
    - 未提供接口与状态枚举截图
    - 未提供有效期与异常态设计截图
scope:
  included:
    - Tracking links 与 Free trial links 的 Share links Tab
    - Share links 列表、创建、编辑、删除、复制、预览
  excluded:
    - 分享落地页具体实现
  dependencies:
    - share-link v2 接口
    - Creator 状态字段 modelBindStatus
    - 配额接口
confirmed_rules:
  - 新版入口受 newShareLinkV1 灰度和 ShareLink 权限控制
  - 名称、Creator、Link、Displayed metrics 为必填
  - Link 下拉排除 deactivated link，支持搜索与分页加载
  - 创建后状态由 Processing 变为 Active
  - Processing 禁止编辑，保留预览、复制和删除
  - 列表展示配额、验证码、Creator、状态、指标和日期字段
ui_interactions:
  - 编辑弹窗确认按钮为 Done
  - 复制 Link 与验证码具有短暂冷却态
  - 多 Creator 通过 Tooltip 展示详情
api_and_data_contracts:
  - dataReady 映射为 Processing 或 Active
  - modelBindStatus 映射 Creator 状态点
  - 配额接口提供总配额、已使用数量、Creator 上限和单 Creator Link 上限
permissions_and_flags:
  - ShareLink 权限控制 Tab 与内部操作
  - newShareLinkV1 控制新旧分享入口切换
implementation_impact:
  - 需确认并可能补充 Creator 删除过滤与 Link 停用标记
  - 需确认有效期规则是否继续实现
  - 需确认编辑后的异步状态刷新策略
open_questions:
  - 配额是否按两类 links 分别计算
  - Creator 删除状态的接口枚举
  - 有效期和过期更新是否仍在本期范围
```

## 节点交接

- 下一节点：需求澄清。
- 读取文件：当前 `01-requirement-analysis.md` 与同目录 `task.yaml`。
- 输出文件：`02-requirement-clarification.md`。
- 当前任务状态：`needs_clarification`。
- 进入变更评估前，需要确认配额范围、Creator 删除状态、停用 Link 标记和有效期规则。
