# Links 模块参考架构

此文件只用于辅助判断职责边界，不要求其他模块复制相同目录。

## Links 做得较好的部分

- Tracking 和 Free trial 把差异注入统一页面装配层，避免复制两套页面。
- `layouts/link-variant-page` 管理 Tab、权限、功能开关和组件装配。
- `hooks/page` 组合 Creator 上下文、列表查询、分页、列配置、Actions 和弹窗引用。
- `components/link-list-search` 管理筛选交互和 Creator 同步。
- `components/link-dashboard` 只消费公共筛选字段。
- `useLinkListFilterState` 区分完整列表筛选和跨 Tab 公共筛选。
- `components/link-editor` 管理新建/编辑状态和提交流程。
- `components/share-links-tab` 分离列表、弹窗表单、提交、状态覆写、选项加载和 mapper。
- 业务组件统一通过 `apis` 请求接口。
- `shared` 管理稳定领域类型、展示方法、日期/时区和表格工具。
- `legacy-share-link` 隔离旧流程，方便后续整体删除。
- README、FLOW、API、PERMISSIONS 让职责和业务链路可追踪。

## 建议复用的模式

1. 使用差异注入代替复制页面。
2. Page Controller 只做组合，不处理字段级细节。
3. 分离列表/查询状态与弹窗/表单状态。
4. 为跨 Tab 状态提供明确 adapter。
5. 使用模块 API 门面和 mapper 层。
6. 统一状态码和文案映射。
7. 把受功能开关控制的旧代码放入独立目录。
8. 每批改动后执行修改文件 lint 和业务行为 Review。

## 不要机械复制的部分

- 没有下线条件时，不要长期保留新旧双流程。
- 需要严格隔离时，不要公开原始共享 Form 或 Store。
- 如果全局 service 仍是实际契约负责人，不要把薄 API wrapper 当作最终状态。
- Hook 也是 Controller，不要允许它持续增加无关职责。
- 同时使用 React Query、请求 Hook 和手动请求状态时，要明确缓存和失效责任。

## 阅读目标模块的建议顺序

1. 路由和页面入口。
2. Page Controller 或装配 Hook。
3. 搜索与筛选状态。
4. 列表查询与分页。
5. 新建/编辑表单和提交逻辑。
6. API 和 mapper。
7. 权限、功能开关、文案和样式。
8. 旧流程和模块文档。
