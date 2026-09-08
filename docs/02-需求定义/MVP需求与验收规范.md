# MVP 需求规范

## 工作流

`requirement-analysis → task review → api-analysis → design-slicing → solution → plan → development-unit-*`。

需求分析结束后始终执行 `task review`。审核对待决策事项逐项选择本期方案或延期；没有待决策事项时仍完成审核并推进接口分析。技术方案、开发计划和开发单元不需要人工批准。

## 输入与资料

| 项目 | 约束 | 采集位置 |
| --- | --- | --- |
| 需求 | 一个 Lark docx/wiki URL，可选章节名称 | `requirement-analysis` 对话 |
| 接口 | 零个或多个当前 YApi 文章 URL | `api-analysis` 对话 |
| 设计 | 零张或一张本地 PNG/JPEG | `design-slicing` 对话 |

`task init` 只创建任务。所有主干节点固定存在；接口或设计资料留空时，对应节点记录为已跳过并直接推进。

## 节点职责

- `requirement-analysis`：读取需求快照，产出事实登记和决策登记。
- `api-analysis`：读取全部接口快照，产出可引用的接口契约和缺失信息。
- `design-slicing`：切割一张设计图并建立图片索引，不做设计规则分析。
- `solution`：读取需求事实、审核结论与可选接口分析，不读取设计资产。
- `plan`：引用真实接口和图片 ID，校验后自动生成开发单元。
- `development-unit-*`：只执行当前单元的代码修改，并接收自身绑定的接口快照和图片。

## 完成条件

节点产物必须通过 AIW 的结构和来源校验。计划成功时，单元名称唯一、依赖无循环、接口和图片引用有效；根开发单元依赖 `plan`，其余单元只依赖声明的前置单元。
