#!/usr/bin/env bash
set -euo pipefail

module_path="${1:-}"

if [[ -z "$module_path" || ! -d "$module_path" ]]; then
  echo "用法：audit_module.sh <模块目录>" >&2
  exit 1
fi

if ! command -v rg >/dev/null 2>&1; then
  echo "audit_module.sh 依赖 rg 命令" >&2
  exit 1
fi

echo "# 模块审查：$module_path"
echo
echo "## 规模"
echo
source_count=$(rg --files "$module_path" -g '*.ts' -g '*.tsx' -g '*.js' -g '*.jsx' | wc -l | tr -d ' ')
echo "- 源码文件：$source_count"
echo
echo "## 最大源码文件"
echo
rg --files "$module_path" -g '*.ts' -g '*.tsx' -g '*.js' -g '*.jsx' \
  | xargs wc -l 2>/dev/null \
  | sort -nr \
  | rg -v '[[:space:]]total$' \
  | head -n 20 \
  | sed 's/^/- /'
echo
echo "## 模块文档"
echo
for doc in README.md FLOW.md API.md PERMISSIONS.md; do
  if [[ -f "$module_path/$doc" ]]; then
    echo "- [x] $doc"
  else
    echo "- [ ] $doc"
  fi
done
echo
echo "## API 层外的直接请求或全局 Service 引用"
echo
rg -n "request\\.(get|post|put|patch|delete)|from ['\"]@/services" "$module_path" \
  -g '*.ts' -g '*.tsx' -g '*.js' -g '*.jsx' \
  | rg -v '/apis?/|/api\.(ts|tsx|js|jsx):' || true
echo
echo "## API 层的传输与全局 Service 依赖"
echo
rg -n "request\\.(get|post|put|patch|delete)|from ['\"]@/services" "$module_path" \
  -g '*.ts' -g '*.tsx' -g '*.js' -g '*.jsx' \
  | rg '/apis?/|/api\.(ts|tsx|js|jsx):' || true
echo
echo "## 状态与副作用分布"
echo
rg -n "use(State|Effect|Reducer|Request|Query)|Form\\.useForm|setTimeout|setInterval|addEventListener" "$module_path" \
  -g '*.ts' -g '*.tsx' -g '*.js' -g '*.jsx' || true
echo
echo "## 遗留与临时标记"
echo
rg -n "TODO|FIXME|HACK|mock|temporary|legacy|deprecated|compat|临时|兼容" "$module_path" \
  -g '*.ts' -g '*.tsx' -g '*.js' -g '*.jsx' -g '*.md' || true
echo
echo "## 可能影响全局的样式选择器"
echo
rg -n ":global|!important|body[[:space:]]*\\{|html[[:space:]]*\\{" "$module_path" \
  -g '*.css' -g '*.less' -g '*.scss' -g '*.sass' || true
