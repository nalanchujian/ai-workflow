---
artifact: requirement-clarification
task_id: 20260713-175300-growth-links-share-links
node: requirement-clarification
status: completed
target_module: /src/pages/growth/links
inputs:
  - 01-requirement-analysis.md
depends_on:
  - requirement-analysis
---

# Links Share Links 需求澄清

## 已确认范围

- 本期覆盖 Tracking links 和 Free trial links 下的新版 Share links Tab。
- 覆盖列表、创建、编辑、删除、复制和预览入口。
- 创建和编辑均要求名称、Creator、Link、Displayed metrics 完整后才能提交。
- Link 下拉支持搜索与分页加载，不展示 deactivated link；单个 Creator 的可选数量受配额限制。
- 创建后由 `Processing` 变为 `Active`；Processing 行不能编辑，但可预览、复制和删除。
- 列表需要展示名称、验证码、Creator、状态、指标、最近更新时间、创建日期和操作。

## 本期排除范围

- 分享落地页页面本身的实现。
- 落地页验证码校验、数据移除和空状态的内部实现。
- 后端异步任务、Creator 解绑、Link 停用、软删除和数据保留的服务端处理。

## 前端与外部依赖边界

| 场景 | 前端责任 | 外部依赖 |
| --- | --- | --- |
| Creator 状态 | 按接口字段显示状态点、字段错误和隐藏规则 | `modelBindStatus` 枚举与删除数据策略 |
| 停用 Link | 下拉过滤、列表标记和回填展示 | 列表接口提供 Link 状态字段 |
| Processing 到 Active | 根据 `dataReady` 渲染并按约定刷新 | 后端异步处理完成后更新字段 |
| 配额 | 显示使用量、禁用创建、提交前二次拦截 | 配额接口返回统一的使用量和限制 |
| 预览 | 打开分享链接 | 落地页自行校验 access code |

## 待确认结论

| 编号 | AI 推荐结论 | 依据 | 影响 |
| --- | --- | --- | --- |
| D1 | Tracking 与 Free trial 各自限制 50 条 | 两个类型已有独立配额接口，且本任务以各自 Tab 为边界 | 配额接口、表头 `(X/50)` 和创建拦截 |
| D2 | 已删除 Creator 由后端过滤，不返回给列表 | 需求要求删除 Creator 不展示；前端不应猜测删除枚举 | 列表是否由前端过滤 Creator |
| D3 | 使用 `linkInfo.enable` 识别停用 Link | 当前接口示例已有该布尔字段 | Share links 列表和编辑回填 |
| D4 | 本期不实现有效期和过期更新 | 当前接口、列表设计和最新实现均未包含该能力 | 是否新增列表字段、筛选、操作与接口 |
| D5 | 编辑后与创建一致进行一次延迟补刷 | 后端异步处理完成后才会由 Processing 变为 Active | Processing 到 Active 的可见时机 |
| D6 | 默认每页 50 条 | 当前 Share links 列表已按 50 条实现；设计截图仅用于视觉示意 | 分页视觉与首屏数据量 |
| D7 | 保留 `newShareLinkV1` 灰度，旧入口仅在灰度关闭时可用 | 便于新版出现问题时回退 | 主列表行内 Share 按钮与旧弹窗代码 |

## 当前澄清结论

- 已基于需求截图、现有接口和当前代码生成 D1 至 D7 的推荐结论。
- 需求负责人已确认推荐结论，无需逐项修改。
- 本节点已完成，进入“变更评估”。

## 确认记录

- 确认结果：`approved`。
- 确认方式：需求负责人回复“确认继续”。
- 确认范围：D1 至 D7 的 AI 推荐结论。

## 交接状态

- 当前节点：需求澄清。
- 状态：`completed`。
- 下一节点：变更评估。
- 解锁条件：已满足，使用 `$03-change-assessment` 生成变更评估。
