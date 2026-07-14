---
artifact: acceptance-checklist
task_id: 20260713-175300-growth-links-share-links
node: acceptance-design
skill: 04-acceptance-design
status: completed
target_module: /src/pages/growth/links
inputs:
  - 01-requirement-analysis.md
  - 02-requirement-clarification.md
  - 03-change-assessment.json
depends_on:
  - requirement-intake
  - requirement-clarification
  - change-assessment
---

# Links Share Links 验收清单

## 范围摘要

- 需求解析包：`01-requirement-analysis.md`
- 已确认规则：`02-requirement-clarification.md` 中 D1 至 D7。
- 目标模块：`/src/pages/growth/links`。
- 本期包含：Tracking links 与 Free trial links 的新版 Share links Tab、列表、创建、编辑、删除、复制、预览、配额、Creator 状态展示和 Link 选择。
- 排除范围：分享落地页本身、验证码校验、落地页数据移除/空状态、后端异步任务、Creator 解绑/删除和 Link 停用后的服务端数据处理。
- 后端/联调依赖：Share link v2 列表、保存、编辑、删除、指标、配额接口；`dataReady`、`modelBindStatus`、`linkInfo.enable` 字段契约。

## 验收前置数据

- 准备同时拥有 Tracking links 和 Free trial links 的机构账号，并分别具备 ShareLink 权限和无 ShareLink 权限账号。
- 准备 `newShareLinkV1` 开启与关闭的灰度账号或可切换环境。
- 准备至少一个 Active Share link、一个 `dataReady=false` 的 Processing Share link、单 Creator 和多 Creator Share link。
- 准备可搜索的 Creator、超过一页的有效 Link、至少一个已停用 Link、一个掉线 Creator，以及重复的 Share link 名称。
- 准备可返回已使用数、Share link 总配额、单 Share link Creator 配额和单 Creator Link 配额的配额接口数据。
- 准备日期为空和日期非空的列表数据，用于验证日期占位和时区格式化。

## 验收用例

### 入口、权限与灰度

| 优先级 | 用例名称 | 前置条件 | 操作步骤 | 预期结果 | 责任边界 |
| --- | --- | --- | --- | --- | --- |
| P0 | 新版 Share links 入口 | 具备 ShareLink 权限，`newShareLinkV1` 开启 | 分别进入 Tracking links 和 Free trial links | 两个页面均展示 Share links Tab；旧行内 Share 入口不展示 | 前端控制权限和灰度组合 |
| P0 | 灰度关闭时保留旧流程 | 具备 ShareLink 权限，`newShareLinkV1` 关闭 | 分别进入两个 links 页面 | 不展示新版 Share links Tab；旧分享入口可用 | 前端控制灰度；旧流程功能另行回归 |
| P0 | 无分享权限 | 不具备 ShareLink 权限 | 分别进入两个 links 页面 | 不展示新版 Tab，也不展示旧分享入口 | 前端权限展示控制 |
| P1 | 类型数据隔离 | 两类 links 均有 Share link 数据 | 在 Tracking 与 Free trial 页面间切换 Share links Tab | 各自只读取并展示对应类型的列表、指标和配额 | 前端按类型传参；后端返回对应数据 |

### 列表、搜索与分页

| 优先级 | 用例名称 | 前置条件 | 操作步骤 | 预期结果 | 责任边界 |
| --- | --- | --- | --- | --- | --- |
| P0 | 列表字段完整性 | 列表存在单 Creator 和多 Creator 数据 | 打开 Share links Tab | 表格依次展示 Share link、Access code、Creator、Status、Displayed metrics、Last updated、Date created、Actions；首列展示已使用数/总配额 | 前端字段映射与列表渲染 |
| P0 | 默认分页和首屏高亮 | 列表总数超过 50 条 | 首次进入 Share links Tab | 请求和页面默认每页 50 条；当前页为第 1 页且分页高亮正确 | 前端分页参数与受控状态 |
| P1 | 翻页和每页数量 | 列表超过一页 | 切换页码、切换每页数量后返回第 1 页 | 表格数据、总数和当前页同步更新；不会出现页面与表格各自维护分页状态 | 前端状态管理；后端返回总数和分页数据 |
| P1 | 按名称搜索和清空 | 至少有两个不同名称的 Share link | 输入完整或部分名称后搜索，再点击清空 | 列表按名称过滤；清空后重新请求并恢复未过滤结果 | 前端搜索触发与清空重置 |
| P1 | 空列表状态 | 当前类型没有 Share link 且未达到配额 | 打开 Share links Tab | 展示设计稿空状态和 Create share link 入口 | 前端空状态渲染 |
| P1 | 日期与空值展示 | 准备日期有值和为空的行 | 查看 Last updated、Date created | 有值日期按页面报告时区格式化；两个字段均为空时显示 `-`，不得用当前日期兜底 | 前端格式化；后端提供原始时间 |
| P2 | 极端内容布局 | 准备超长名称、长验证码、多 Creator、长指标列表 | 打开列表并横向查看固定列 | 内容截断或换行符合表格规范；Actions 固定列可见；不出现遮挡、白块或异常横向滚动 | 前端视觉和表格布局 |

### 配额与创建入口

| 优先级 | 用例名称 | 前置条件 | 操作步骤 | 预期结果 | 责任边界 |
| --- | --- | --- | --- | --- | --- |
| P0 | 两类 links 独立 50 条配额 | Tracking 与 Free trial 使用量不同 | 分别打开两个 Share links Tab | 两侧首列各自显示对应类型的已使用数/总配额，互不串值 | 前端按类型查询；后端按类型统计 |
| P0 | 达到配额后的创建拦截 | 当前类型已达到接口返回的 Share link 上限 | 在列表态和空态尝试点击 Create share link | 创建按钮禁用并展示“Maximum number of share links is 50. To add a new link, delete an existing one”提示；不能打开创建弹窗或提交创建请求 | 前端禁用与提交前二次校验；后端最终兜底 |
| P1 | 删除后恢复创建能力 | 当前类型达到上限且存在可删除行 | 删除一条 Share link 并确认成功 | 行从列表移除，使用数更新，Create share link 恢复可用 | 前端刷新列表和配额；后端删除成功 |

### 创建与编辑表单

| 优先级 | 用例名称 | 前置条件 | 操作步骤 | 预期结果 | 责任边界 |
| --- | --- | --- | --- | --- | --- |
| P0 | 创建弹窗初始状态 | 未达到配额 | 点击 Create share link | 弹窗展示名称、Creator/Tracking links 分组、Displayed metrics；Tracking 和 Free trial 的字段标签与对应类型一致 | 前端弹窗与类型文案 |
| P0 | 必填项完整性 | 打开创建或编辑弹窗 | 分别留空名称、Creator、Link、指标；逐项补全 | 必填未完成时 Create 或 Done 按钮禁用；全部补齐后恢复可点击；不会因点击禁用按钮一次性展示所有字段错误 | 前端表单校验交互 |
| P1 | 名称长度与重复校验 | 已有同名 Share link | 输入超出与 Tracking/Free trial link 创建一致的最大长度；再输入重复名称并保存 | 超长名称阻止提交并显示长度错误；名称重复时名称字段显示“Link name already exists. Enter a different one” | 前端长度校验；重复性由后端确认 |
| P0 | Creator 搜索、添加与去重 | Creator 列表有多条数据 | 搜索并选择 Creator，新增分组后再次搜索同一 Creator | Creator 下拉支持搜索；已选择 Creator 在其他分组禁用，不能重复选取 | 前端选项过滤和去重 |
| P1 | Creator 数量限制 | 配额接口返回较小 Creator 上限或已选择到上限 | 连续新增 Creator 分组并尝试继续选择 | 达到接口限制后，未选 Creator 禁用并给出限制提示；已选 Creator 仍可移除 | 前端读取并执行配额限制 |
| P0 | Link 选项加载与过滤 | 已选择一个有效 Creator，名下有有效和停用 Link | 打开 Link 下拉、搜索、滚动加载 | 初次按分页加载，继续滚动可加载下一页；支持搜索；不展示 deactivated Link；不提供 Select all | 前端请求参数和选项渲染；后端分页数据 |
| P0 | Link 去重与单 Creator 上限 | 已选择 Link，且 Creator 名下 Link 数超过限制 | 重复选择已选 Link；连续选择至上限，再展开下拉 | 同一 Link 不可重复选择；达到接口限制后下拉仍可展开，未选项不可选，已选项仍可删除 | 前端选择约束和可移除性 |
| P1 | 编辑回填与选项标签 | 准备多 Creator、多 Link、部分指标的 Active Share link | 点击 Edit | 名称、Creator、Link、指标均按 label 正确回填，不显示 id/value；Link 下拉可展开并保留原列表顺序 | 前端 mapper、回填与下拉状态 |
| P1 | 指标加载、默认值与排序 | 指标接口返回对应类型的指标 | 分别打开 Tracking/Free trial 创建弹窗；删除并重新选择一个指标 | 初始默认选中该类型全部指标；删除和重新添加后按接口默认顺序展示；最后一个指标不能被移除为空 | 前端指标排序与至少一个指标约束；后端指标列表 |
| P1 | 停用 Link 的编辑边界 | 已创建 Share link 引用了后续停用的 Link | 打开编辑并直接提交 | 已回填 Link 信息仍可见；前端不因该 Link 后续停用而阻断提交 | 前端不主动拦截历史关联；后端处理数据有效性 |

### 提交、状态与行操作

| 优先级 | 用例名称 | 前置条件 | 操作步骤 | 预期结果 | 责任边界 |
| --- | --- | --- | --- | --- | --- |
| P0 | 创建后的 Processing 和生成信息 | 所有创建字段完整 | 提交创建 | 创建成功后展示 Generating share link 弹窗，包含名称、分享链接、Access code 和复制动作；列表出现 Processing 行 | 前端提交后展示；后端返回链接、验证码和 `dataReady=false` |
| P0 | Processing 到 Active 刷新 | 创建或编辑后后端异步完成处理 | 保持在 Share links Tab 等待至少一次延迟刷新 | 列表会刷新，`dataReady=true` 的行展示 Active；不要求用户手动重进 Tab | 前端延迟刷新；后端更新 `dataReady` |
| P0 | Processing 状态操作权限 | 存在 Processing 行 | 查看 Actions | Edit 始终展示但禁用；Preview、Copy link and code details、Delete 可使用；tooltip 与设计稿一致 | 前端状态映射和按钮禁用 |
| P0 | Active 状态操作权限 | 存在 Active 行 | 查看 Actions | Edit、Preview、Copy link and code details、Delete 均可使用 | 前端状态映射 |
| P1 | 编辑提交后的状态流 | 存在 Active 行 | 编辑任意可编辑字段并保存 | 编辑提交成功后列表显示 Processing；后端准备完成后自动变为 Active | 前端刷新策略；后端异步处理 |
| P1 | 复制名称链接、验证码和全部信息 | 存在可复制数据 | 分别点击 Copy link、Copy code、Actions 的复制按钮 | Copy link 只复制链接；Copy code 只复制验证码；Actions 复制名称、URL、Access code 的多行文本；成功均提示“Copied to clipboard”，行内文案短暂显示 copied 后恢复 | 前端剪贴板、冷却态和提示文案 |
| P1 | 预览分享页面 | 存在 Share link | 点击 Preview | 通过 Electron 公共 `openExternalUrl` 打开 `shareUrl`，不在当前管理页面内跳转 | 前端调用公共外链方法；落地页由外部负责 |
| P0 | 删除二次确认 | 存在任意状态行 | 点击 Delete，分别取消与确认 | 展示确认弹窗；取消不请求删除；确认成功后行与配额同步刷新 | 前端二次确认和刷新；后端删除 |

### Creator 状态与异常反馈

| 优先级 | 用例名称 | 前置条件 | 操作步骤 | 预期结果 | 责任边界 |
| --- | --- | --- | --- | --- | --- |
| P1 | Creator 状态点 | 列表返回不同 `modelBindStatus` 的非删除 Creator | 查看单 Creator 单元格和多 Creator Tooltip | 头像右下角展示与 Creator 下拉一致的状态点；多 Creator Tooltip 展示头像、名称、昵称和关联 Link 数 | 前端按 `modelBindStatus` 映射；后端提供状态字段 |
| P1 | 已删除 Creator 的列表边界 | 后端已过滤删除 Creator | 查询 Share links 列表 | 前端仅展示接口返回的 Creator，不自行猜测删除枚举；若行已不再返回则不展示 | 后端过滤删除数据；前端按响应渲染 |
| P0 | 保存时 Creator 掉线 | 创建或编辑表单中包含会被后端判定掉线的 Creator | 提交保存 | 保存失败；仅对应 Creator 字段显示错误“Creator’s OnlyFans account is not connected to Infloww. Link account to create sharelink”，并将该 Creator 状态更新为掉线 | 前端错误定位和状态更新；后端返回掉线 Creator 标识 |
| P1 | 通用失败反馈 | 模拟创建、编辑或删除接口失败 | 分别执行创建、编辑、删除 | 非字段级失败按后端返回 message 展示；列表和弹窗不产生错误的乐观更新 | 前端错误呈现与状态回滚；后端 message 内容 |

### 视觉与回归

| 优先级 | 用例名称 | 前置条件 | 操作步骤 | 预期结果 | 责任边界 |
| --- | --- | --- | --- | --- | --- |
| P1 | 列表页视觉 | 使用设计分辨率与常用桌面分辨率 | 对比 Share links 空态、列表态、配额禁用态 | 标题、Tab、Alert、搜索、创建按钮、表格、分页的颜色、间距、对齐与设计稿一致；页面不出现额外纵向滚动 | 前端视觉实现 |
| P1 | 弹窗视觉 | 打开创建、编辑、生成信息、删除确认弹窗 | 对比设计稿 | 创建/编辑弹窗宽度和内容边距一致；编辑确认按钮为 Done；生成信息卡片与复制图标对齐；删除弹窗操作层次清晰 | 前端视觉实现 |
| P2 | 公共组件回归 | 执行上述所有交互 | 检查 Select、Tooltip、Modal、Table、Pagination 的默认、hover、focus、disabled 状态 | 不通过全局样式覆盖破坏组件默认行为；其他 links Tab 的样式和交互不回退 | 前端样式隔离与公共组件使用 |

## 联调检查点

| 检查项 | 需要确认的接口行为 | 验证方式 |
| --- | --- | --- |
| 列表分页 | Page 接口接收并正确处理 `page=1`、`size=50`、名称搜索和类型 | 查看请求参数与翻页响应 |
| 配额 | Tracking 和 Free trial 返回独立使用量、总配额、Creator 上限、Creator Link 上限 | 对比两个类型的 limit 响应与页面展示 |
| 状态 | `dataReady=false` 与 `true` 分别稳定返回 Processing 与 Active | 创建/编辑后轮询列表响应 |
| Creator 状态 | `modelBindStatus` 枚举和掉线 Creator 标识稳定返回 | 对比 Creator 下拉、列表单元格和保存失败响应 |
| Link 状态 | `linkInfo.enable` 能识别停用 Link；删除 Creator 已由后端过滤 | 使用停用/删除测试数据验证响应 |
| 错误 | 重名、配额、Creator 掉线等错误可识别并能定位字段 | 保存接口返回成功码、message 和关联 Creator 标识 |

## 待确认项

| 问题 | 影响范围 | 需要谁确认 |
| --- | --- | --- |
| Page 接口未显式传入 `size=50` 时的缺省值是否仍为 1000 | 默认分页与接口负载 | 前端开发与接口负责人 |
| `modelBindStatus` 的完整枚举和掉线状态值 | Creator 状态点和字段错误状态 | 接口负责人 |
| 列表接口中停用 Link 的展示字段是否完整 | 已关联停用 Link 的列表标记 | 接口负责人和产品 |

## 提测门槛

- [ ] P0 入口、权限、灰度、列表、配额、创建、编辑、删除和状态流通过。
- [ ] Tracking 与 Free trial 两类数据、指标和配额均完成隔离验证。
- [ ] 必填、重复名称、Creator 掉线、通用失败和删除确认可验证。
- [ ] 搜索、分页、清空、Link 懒加载、数量限制和回填可验证。
- [ ] 设计稿关键视觉：空态、列表态、创建/编辑/生成/删除弹窗已核对。
- [ ] 落地页和服务端数据处理的排除范围已向测试明确说明。

## 节点交接

- 当前节点：验收设计。
- 状态：`completed`。
- 下一节点：影响分析。
- 下一节点输入：本清单、需求解析、需求澄清和变更评估。
