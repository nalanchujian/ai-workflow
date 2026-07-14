# 需求解析包

文件名固定为 `01-requirement-analysis.md`，存放于：

`/Users/j/codes/ai-workflow/tasks/<task-id>/`

文件开头必须包含：

```yaml
---
artifact: requirement-analysis
task_id: <task-id>
node: requirement-intake
status: completed | blocked
target_module: <模块路径>
inputs:
  - requirement-screenshot
  - design-screenshot
depends_on: []
---
```

```yaml
artifact: requirement-analysis
version: 1
target_module: <模块路径>
sources:
  requirement_screenshot: <本轮第 1 张图片>
  design_screenshot: <本轮第 2 张图片>
  limitations: []
scope:
  included: []
  excluded: []
  dependencies: []
confirmed_rules: []
ui_interactions: []
api_and_data_contracts: []
permissions_and_flags: []
implementation_impact: []
open_questions: []
```

补充一段简短 Markdown，说明每个数组中最关键的内容、截图覆盖范围和资料限制。不要把猜测写入 `confirmed_rules`。
