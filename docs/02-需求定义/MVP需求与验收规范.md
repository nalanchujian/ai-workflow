# MVP 需求规范

## 工作流

`requirement-analysis → task inputs → 可选 api-analysis → 可选 design-slicing → solution → plan → development-unit-*`。

需求分析有待决策事项时先执行 `task review`；每项可选择本期方案或延期。没有待决策事项时自动完成。技术方案和开发计划都不需要人工批准。

## 输入与资料

| 项目 | 约束 |
| --- | --- |
| 需求 | 一个 HTTP(S) 文档 URL |
| 接口 | 零个或多个 HTTP(S) 文档 URL |
| 设计 | 零张或一张本地 PNG/JPEG |

`task init` 只登记需求 URL。需求分析完成后，`task inputs` 依次收集接口和设计资料；回答立即持久化，未提供的资料不创建占位节点。

## 节点职责

- `requirement-analysis`：读取需求快照，产出事实登记和决策登记。
- `api-analysis`：读取全部接口快照，产出可引用的接口契约和缺失信息。
- `design-slicing`：切割一张设计图并建立图片索引，不做设计规则分析。
- `solution`：读取需求事实、决策与可选接口分析，不读取设计资产。
- `plan`：引用真实接口和图片 ID，校验后自动生成开发单元。
- `development-unit-*`：只执行当前单元的代码修改，并接收自身绑定的接口快照和图片。

## 完成条件

节点产物必须通过 AIW 的结构和来源校验。计划成功时，单元名称唯一、依赖无循环、接口和图片引用有效；根开发单元依赖 `plan`，其余单元只依赖声明的前置单元。
