#!/usr/bin/env ruby

# The only supported writer for task.yaml. Node skills write their own artifacts,
# then workflow-orchestrator records the verified result through this command.

require 'json'
require 'optparse'
require 'fileutils'
require 'digest'
require 'pathname'
require 'time'
require 'yaml'

REPO_ROOT = File.expand_path('..', __dir__)
REFERENCES_ROOT = File.join(REPO_ROOT, 'skills/workflow-orchestrator/references')

def load_json(path)
  JSON.parse(File.read(path))
end

MANIFEST = load_json(File.join(REFERENCES_ROOT, 'contract-manifest.json'))
CONTRACTS = MANIFEST.fetch('contracts').transform_values do |relative_path|
  load_json(File.join(REFERENCES_ROOT, relative_path))
end.freeze
NODES = CONTRACTS.fetch('nodes').fetch('nodes').freeze
PATHS = CONTRACTS.fetch('paths').fetch('paths').freeze
TASK_SCHEMA = CONTRACTS.fetch('taskState').freeze
GATE_CONTRACT = CONTRACTS.fetch('gates').freeze
GATES = GATE_CONTRACT.fetch('gates').freeze
ARTIFACT_SCHEMA = CONTRACTS.fetch('artifacts').freeze
DELIVERY_SCHEMA = CONTRACTS.fetch('deliveryEvidence').freeze
NODE_SCHEMAS = NODES.transform_values do |definition|
  schema_path = definition['schema']
  schema_path ? load_json(File.join(REPO_ROOT, schema_path)) : nil
end.freeze
SCHEMAS_BY_ID = (CONTRACTS.values + NODE_SCHEMAS.values.compact).each_with_object({}) do |schema, schemas|
  schemas[schema['$id']] = schema if schema.is_a?(Hash) && schema['$id']
end.freeze
TASK_STATUSES = TASK_SCHEMA.dig('properties', 'status', 'enum').freeze
TERMINAL_STATUSES = TASK_SCHEMA.fetch('x-terminalStatuses').freeze
ORCHESTRATOR_ACTOR = 'workflow-orchestrator'
GATE_ACTOR = 'workflow-owner'
GATE_DECISION_COMMANDS = %w[approve-gate reject-gate].freeze
DELIVERY_FIELDS = DELIVERY_SCHEMA.fetch('properties').keys.freeze
DELIVERY_STAGES = %w[development-implementation quality-verification change-review].freeze
DELIVERY_WRITER = 'development-implementation'
PRE_PATH_NODES = %w[requirement-intake requirement-routing].freeze
REMOVED_NODES = %w[requirement-clarification solution-review].freeze
TRANSACTION_FILE = '.workflow-transaction.json'
DISCARD_DIR = '.workflow-discard'
ARTIFACT_SCHEMA_VERSION = 1
MARKDOWN_V2_SECTIONS = %w[结果 交付 未决项 交接].freeze
MARKDOWN_V2_NODE_SECTIONS = {
  'requirement-intake' => %w[范围 需求事实 待澄清项 确认决策 分流线索],
  'acceptance-design' => %w[验收范围 验收用例 测试数据],
  'impact-analysis' => %w[影响概览 改动候选 调用链 回归范围],
  'implementation-design' => %w[方案边界 工作包 文件变更 行为契约 验证与回滚],
  'development-implementation' => %w[实际变更 计划偏差 自测结果 交付证据],
  'quality-verification' => %w[验收结果 工程检查 缺陷详情 交付证据],
  'change-review' => %w[审查范围 发现项 一致性检查 交付证据]
}.freeze
MARKDOWN_V3_SECTIONS = ['1. 结果', '2. 产出', '3. 待确认', '4. 下一步'].freeze
MARKDOWN_V3_NODE_LABELS = {
  'requirement-intake' => %w[范围 需求事实],
  'acceptance-design' => %w[验收范围 验收用例 测试数据],
  'impact-analysis' => %w[影响概览 改动候选 调用链 回归范围],
  'implementation-design' => %w[方案边界 工作包与文件 行为契约 验证与回滚],
  'development-implementation' => %w[实际变更 计划偏差 自测结果 交付证据],
  'quality-verification' => %w[验收与工程检查 缺陷详情 交付证据],
  'change-review' => %w[审查范围 发现项 一致性与交付证据]
}.freeze
CURRENT_MARKDOWN_NODE_LABELS = {
  'requirement-intake' => %w[范围 需求事实],
  'acceptance-design' => %w[验收范围 验收用例 测试数据],
  'impact-analysis' => %w[影响项 调用链 回归范围],
  'implementation-design' => %w[工作包与文件 行为契约 验证与回滚],
  'development-implementation' => %w[实际变更 计划偏差 自测结果 交付证据],
  'quality-verification' => %w[验收与工程检查 缺陷详情 交付证据],
  'change-review' => %w[审查范围 发现项 一致性与交付证据]
}.freeze
COMMON_PENDING_HEADERS = %w[ID 类型 事项与影响 Owner 责任节点 完成条件].freeze
NEXT_STEP_FIELDS = %w[当前动作 完成条件].freeze
MAX_MARKDOWN_TABLES = 3
MAX_MARKDOWN_TABLE_COLUMNS = 6

def fail_with(message)
  warn "ERROR: #{message}"
  exit 1
end

def schema_type_match?(value, type)
  case type
  when 'object' then value.is_a?(Hash)
  when 'array' then value.is_a?(Array)
  when 'string' then value.is_a?(String)
  when 'integer' then value.is_a?(Integer)
  when 'number' then value.is_a?(Numeric)
  when 'boolean' then value == true || value == false
  when 'null' then value.nil?
  else false
  end
end

def resolve_schema_ref(ref, root_schema)
  if ref.start_with?('#/')
    keys = ref.delete_prefix('#/').split('/').map { |key| key.gsub('~1', '/').gsub('~0', '~') }
    target = keys.reduce(root_schema) { |value, key| value.is_a?(Hash) ? value[key] : nil }
    return [target, root_schema]
  end

  target = SCHEMAS_BY_ID[File.basename(ref)]
  [target, target]
end

def schema_errors(value, schema, location, root_schema = schema)
  return ["#{location} uses an invalid schema"] unless schema.is_a?(Hash)

  errors = []
  if schema['$ref']
    target, target_root = resolve_schema_ref(schema['$ref'], root_schema)
    if target
      errors.concat(schema_errors(value, target, location, target_root))
    else
      errors << "#{location} references unknown schema #{schema['$ref']}"
    end
  end

  Array(schema['allOf']).each do |branch|
    errors.concat(schema_errors(value, branch, location, root_schema))
  end

  if schema['if']
    condition_matches = schema_errors(value, schema['if'], location, root_schema).empty?
    branch = condition_matches ? schema['then'] : schema['else']
    errors.concat(schema_errors(value, branch, location, root_schema)) if branch
  end

  if schema['anyOf']
    matches = schema['anyOf'].any? { |branch| schema_errors(value, branch, location, root_schema).empty? }
    errors << "#{location} does not match any allowed schema" unless matches
  end

  if schema.key?('type')
    types = Array(schema['type'])
    unless types.any? { |type| schema_type_match?(value, type) }
      errors << "#{location} must be #{types.join(' or ')}"
      return errors
    end
  end

  errors << "#{location} must equal #{schema['const'].inspect}" if schema.key?('const') && value != schema['const']
  errors << "#{location} has an unsupported value" if schema['enum'] && !schema['enum'].include?(value)

  if value.is_a?(String)
    errors << "#{location} is too short" if schema['minLength'] && value.length < schema['minLength']
    errors << "#{location} has an invalid format" if schema['pattern'] && !Regexp.new(schema['pattern']).match?(value)
  elsif value.is_a?(Numeric)
    errors << "#{location} is below the minimum" if schema['minimum'] && value < schema['minimum']
  elsif value.is_a?(Array)
    errors << "#{location} has too few items" if schema['minItems'] && value.length < schema['minItems']
    errors << "#{location} has too many items" if schema['maxItems'] && value.length > schema['maxItems']
    if schema['items']
      value.each_with_index do |item, index|
        errors.concat(schema_errors(item, schema['items'], "#{location}[#{index}]", root_schema))
      end
    end
  elsif value.is_a?(Hash)
    required = Array(schema['required'])
    missing = required - value.keys
    errors << "#{location} is missing #{missing.join(', ')}" unless missing.empty?

    properties = schema['properties'] || {}
    properties.each do |key, property_schema|
      next unless value.key?(key)

      errors.concat(schema_errors(value[key], property_schema, "#{location}.#{key}", root_schema))
    end

    if schema['propertyNames']
      value.each_key do |key|
        errors.concat(schema_errors(key, schema['propertyNames'], "#{location} key #{key}", root_schema))
      end
    end

    unknown = value.keys - properties.keys
    if schema['additionalProperties'] == false && !unknown.empty?
      errors << "#{location} contains unknown fields: #{unknown.join(', ')}"
    elsif schema['additionalProperties'].is_a?(Hash)
      unknown.each do |key|
        errors.concat(schema_errors(value[key], schema['additionalProperties'], "#{location}.#{key}", root_schema))
      end
    end
  end

  errors
end

def validate_schema!(value, schema, location)
  errors = schema_errors(value, schema, location)
  fail_with("Schema validation failed: #{errors.first}") unless errors.empty?
end

def parse_json(value, option)
  JSON.parse(value)
rescue JSON::ParserError => error
  fail_with("#{option} must be valid JSON: #{error.message}")
end

def canonical_node!(node)
  fail_with("Unknown node: #{node}") unless NODES.key?(node)
end

def now
  Time.now.iso8601
end

def gate_confirmation(state, action)
  gate = state['gate']
  return nil unless gate && gate['status'] == 'pending'

  label = action == :approve ? '确认节点' : '拒绝节点'
  "#{label}：#{state['task_id']}/#{gate['node']}@#{state['revision']}"
end

def state_response(state)
  response = {
    task_id: state['task_id'],
    revision: state['revision'],
    status: state['status'],
  }
  if state.dig('gate', 'status') == 'pending'
    response[:approve_confirmation] = gate_confirmation(state, :approve)
    response[:reject_confirmation] = gate_confirmation(state, :reject)
  end
  response
end

def artifact_record(state, node)
  state.fetch('artifacts', {})[node]
end

def artifact_recorded?(state, node)
  !artifact_record(state, node).nil?
end

def approved_gate_for_current_artifact?(state, node)
  record = artifact_record(state, node)
  record && record['approved'] == true
end

def artifact_digest(path)
  Digest::SHA256.file(path).hexdigest
end

def build_artifact_record(path, artifact)
  {
    'attempt' => artifact.fetch('attempt'),
    'sha256' => artifact_digest(path),
  }
end

def next_node(node)
  return nil if node.nil?

  canonical_node!(node)
  node
end

def gate_approved_next(state, node, gate)
  if state['path']
    sequence = PATHS.fetch(state['path'])
    index = sequence.index(node)
    if index
      candidate = sequence[index + 1]
      return candidate
    end
  end

  candidate = gate['approvedNext']
  fail_with("Gate for #{node} has no path-derived next node or approvedNext") unless candidate
  canonical_node!(candidate)
  candidate
end

def gate_required_on_path?(node, path)
  gate = GATES[node]
  return false unless gate

  return true if gate['beforePathSelection'] && PATHS.fetch(path).include?(node)

  Array(gate['paths']).include?(path)
end

def terminal_gate?(state, node)
  state['path'] && PATHS.fetch(state['path']).last == node
end

def validate_gate_reference!(gate)
  canonical_node!(gate['node'])
  fail_with("Task gate is not defined for #{gate['node']}") unless GATES[gate['node']]
  fail_with("Task gate status #{gate['status']} is invalid") unless %w[pending approved].include?(gate['status'])
end

def validate_task_state!(state)
  validate_schema!(state, TASK_SCHEMA, 'task.yaml')
  fail_with("Task path is not registered: #{state['path']}") if state['path'] && !PATHS.key?(state['path'])
  canonical_node!(state['current_node']) if state['current_node']

  canonical_node!(state['next_node']) if state['next_node']

  state['artifacts'].each_key { |node| canonical_node!(node) }
  state['attempts'].each_key { |node| canonical_node!(node) }
  state['artifacts'].each do |node, record|
    unless state['attempts'][node] == record['attempt']
      fail_with("Attempt counter for #{node} must match its current artifact")
    end
  end

  if state['gate']
    validate_gate_reference!(state['gate'])
  end
  state['blocked_by'].each do |blocker|
    canonical_node!(blocker['retry_node'])
  end

  if state['gate']
    expected_status = state['gate']['status'] == 'pending' ? 'awaiting_confirmation' : 'active'
    fail_with("Task with #{state['gate']['status']} gate must be #{expected_status}") unless state['status'] == expected_status
    fail_with('Current gate must belong to current_node') unless state['current_node'] == state['gate']['node']
    fail_with('Current gate artifact is not registered') unless artifact_recorded?(state, state['gate']['node'])
    if state['next_node'].nil? && !terminal_gate?(state, state['gate']['node'])
      fail_with('Non-terminal gate requires a next node')
    end
  end

  state['blocked_by'].each do |blocker|
    retry_scope = invalidated_nodes_for(state, blocker['retry_node'])
    unless retry_scope.include?(state['current_node'])
      fail_with("Blocker retry node #{blocker['retry_node']} does not invalidate its source #{state['current_node']}")
    end
  end

  if state['path'].nil? && state['status'] != 'cancelled'
    [state['current_node'], state['next_node']].compact.each do |node|
      fail_with("Pre-path task cannot reference #{node}") unless PRE_PATH_NODES.include?(node)
    end
  end

  if state['path']
    sequence = PATHS.fetch(state['path'])
    if state['current_node'] && !sequence.include?(state['current_node'])
      fail_with("Current node #{state['current_node']} is not part of #{state['path']}")
    end
    next_name = state['next_node']
    if %w[active awaiting_confirmation].include?(state['status']) && next_name && !sequence.include?(next_name)
      fail_with("Next node #{next_name} is not part of #{state['path']}")
    end
  end

  if state['status'] == 'active'
    if state['gate'].nil? && state['next_node'].nil?
      fail_with('Executing task must have current_node') unless state['current_node']
      fail_with('Executing node already has a recorded artifact') if artifact_recorded?(state, state['current_node'])
    elsif state['gate'].nil? && state['current_node'] && !artifact_recorded?(state, state['current_node'])
      fail_with('Ready task current_node must have a recorded artifact')
    end
  elsif state['status'] == 'awaiting_confirmation'
    fail_with('Awaiting-confirmation task must have a pending gate') unless state.dig('gate', 'status') == 'pending'
  elsif state['status'] == 'blocked'
    fail_with('Blocked task must identify the source node') unless state['current_node']
    fail_with('Blocked task source artifact is not recorded') unless artifact_recorded?(state, state['current_node'])
  end

  if state['status'] == 'completed'
    terminal = PATHS.fetch(state['path']).last
    fail_with("Completed task current_node must be #{terminal}") unless state['current_node'] == terminal
    fail_with("Completed task is missing #{terminal} artifact") unless artifact_recorded?(state, terminal)
    fail_with("Completed task is missing approval for #{terminal}") unless approved_gate_for_current_artifact?(state, terminal)
  end
end

def validate_requirement_routing!(artifact, expected_status)
  if expected_status == 'completed'
    path = artifact['path']
    fail_with('A completed requirement routing result must use a registered path') unless PATHS.key?(path)
  else
    fail_with('A blocked requirement routing result must not select a path') unless artifact['path'].nil?
  end
end

def markdown_h1_body!(content, heading, path)
  match = content.match(/^#\s+#{Regexp.escape(heading)}\s*$\n(?<body>.*?)(?=^#\s+|\z)/m)
  fail_with("Missing #{heading} section: #{path}") unless match
  fail_with("Empty #{heading} section: #{path}") if match[:body].strip.empty?
  match[:body]
end

def validate_markdown_artifact_structure!(path, node, artifact)
  return unless path.end_with?('.md')
  layout = artifact_layout!(artifact)
  return unless layout

  content = File.read(path)
  if layout == :legacy_v2
    actual_h1 = content.scan(/^#\s+(.+?)\s*$/).flatten
    unless actual_h1 == MARKDOWN_V2_SECTIONS
      fail_with("Markdown template v2 sections for #{node} must be: #{MARKDOWN_V2_SECTIONS.join(' -> ')}")
    end

    MARKDOWN_V2_SECTIONS.each { |heading| markdown_h1_body!(content, heading, path) }

    expected_h2 = MARKDOWN_V2_NODE_SECTIONS.fetch(node)
    actual_h2 = content.scan(/^##\s+(.+?)\s*$/).flatten
    unless actual_h2 == expected_h2
      fail_with("Markdown template v2 delivery sections for #{node} must be: #{expected_h2.join(' -> ')}")
    end

    unresolved = markdown_h1_body!(content, '未决项', path).strip
    if artifact['status'] == 'blocked' && unresolved.match?(/\A无[。.]?\z/)
      fail_with("Blocked Markdown artifact must describe at least one unresolved item: #{path}")
    end
    return
  end

  actual_h1 = content.scan(/^#\s+(.+?)\s*$/).flatten
  unless actual_h1 == MARKDOWN_V3_SECTIONS
    fail_with("Four-section Markdown headings for #{node} must be: #{MARKDOWN_V3_SECTIONS.join(' -> ')}")
  end

  MARKDOWN_V3_SECTIONS.each { |heading| markdown_h1_body!(content, heading, path) }
  fail_with("Four-section Markdown must not use level-2 headings: #{path}") unless content.scan(/^##\s+/).empty?

  output = markdown_h1_body!(content, '2. 产出', path)
  expected_labels = layout == :current ? CURRENT_MARKDOWN_NODE_LABELS.fetch(node) : MARKDOWN_V3_NODE_LABELS.fetch(node)
  actual_labels = output.scan(/^\*\*(.+?)\*\*\s*$/).flatten
  allowed_extra = node == 'implementation-design' ? ['最小验收条件'] : []
  unless actual_labels.take(expected_labels.length) == expected_labels && (actual_labels - expected_labels - allowed_extra).empty?
    fail_with("Markdown output labels for #{node} must start with: #{expected_labels.join(' -> ')}")
  end

  pending = markdown_h1_body!(content, '3. 待确认', path).strip
  pending_is_empty = pending.match?(/\A无[。.]?\z/)
  if %w[awaiting_confirmation blocked].include?(artifact['status']) && pending_is_empty
    fail_with("#{artifact['status']} Markdown artifact must describe at least one unresolved item: #{path}")
  end

  return unless layout == :current

  tables = markdown_tables(content)
  fail_with("Markdown artifact may contain at most #{MAX_MARKDOWN_TABLES} tables: #{path}") if tables.length > MAX_MARKDOWN_TABLES
  tables.each do |table|
    next if table[:headers].length <= MAX_MARKDOWN_TABLE_COLUMNS

    fail_with("Markdown table may contain at most #{MAX_MARKDOWN_TABLE_COLUMNS} columns: #{path}")
  end

  unless node == 'requirement-intake' || pending_is_empty
    rows = markdown_table_rows_contiguous!(pending, COMMON_PENDING_HEADERS, 'Unresolved items table', exact: true)
    fail_with("Unresolved items table must contain at least one item: #{path}") if rows.empty?
  end

  next_step = markdown_h1_body!(content, '4. 下一步', path)
  actual_fields = next_step.scan(/^-\s+([^：:]+)[：:]/).flatten.map(&:strip)
  unless actual_fields == NEXT_STEP_FIELDS
    fail_with("Next step fields must be: #{NEXT_STEP_FIELDS.join(' -> ')}")
  end
end

def artifact_layout!(artifact)
  if artifact.key?('artifact_schema_version') && artifact.key?('template_version')
    fail_with('Artifact must not combine artifact_schema_version with legacy template_version')
  end
  return :current if artifact['artifact_schema_version'] == ARTIFACT_SCHEMA_VERSION
  return :legacy_v2 if artifact['template_version'] == 2
  return :legacy_v3 if artifact['template_version'] == 3

  nil
end

def markdown_artifact_layout(path)
  match = File.read(path).match(/\A---\n(.*?)\n---/m)
  return nil unless match

  artifact_layout!(YAML.safe_load(match[1], permitted_classes: [], aliases: false))
end

def markdown_tables(content)
  groups = []
  current = []
  content.each_line do |line|
    stripped = line.strip
    if stripped.start_with?('|') && stripped.end_with?('|')
      current << stripped
    elsif !current.empty?
      groups << current
      current = []
    end
  end
  groups << current unless current.empty?

  groups.each_with_object([]) do |lines, tables|
    next if lines.length < 2

    headers = lines.first.delete_prefix('|').delete_suffix('|').split('|').map(&:strip)
    separator = lines[1].delete_prefix('|').delete_suffix('|').split('|').map(&:strip)
    next unless separator.length == headers.length && separator.all? { |cell| cell.match?(/\A:?-{3,}:?\z/) }

    tables << { headers: headers, lines: lines }
  end
end

def markdown_table_rows_contiguous!(section, required_headers, label, exact: false)
  lines = section.lines
  header_index = lines.index do |line|
    stripped = line.strip
    next false unless stripped.start_with?('|') && stripped.end_with?('|')

    cells = stripped.delete_prefix('|').delete_suffix('|').split('|').map(&:strip)
    required_headers.all? { |header| cells.include?(header) }
  end
  fail_with("#{label} must contain columns: #{required_headers.join(', ')}") unless header_index

  table_lines = lines.drop(header_index).take_while do |line|
    stripped = line.strip
    stripped.start_with?('|') && stripped.end_with?('|')
  end
  headers = table_lines.first.strip.delete_prefix('|').delete_suffix('|').split('|').map(&:strip)
  if exact && headers != required_headers
    fail_with("#{label} columns must exactly equal: #{required_headers.join(', ')}")
  end
  table_lines.drop(1).each_with_object([]) do |line, rows|
    cells = line.strip.delete_prefix('|').delete_suffix('|').split('|').map(&:strip)
    next if cells.all? { |cell| cell.match?(/\A:?-{3,}:?\z/) }
    next if cells.all?(&:empty?)

    rows << headers.zip(cells).to_h
  end
end

def markdown_section!(path, headings)
  content = File.read(path)
  heading_pattern = headings.map { |heading| Regexp.escape(heading) }.join('|')
  match = content.match(/^(?:##|###)\s+(?:#{heading_pattern})\s*$\n(?<body>.*?)(?=^(?:##|###)\s+|\z)/m)
  fail_with("Missing #{headings.join(' or ')} section: #{path}") unless match
  match[:body]
end

def markdown_table_rows!(section, required_headers, label)
  table_lines = section.lines.each_with_object([]) do |line, rows|
    stripped = line.strip
    next unless stripped.start_with?('|') && stripped.end_with?('|')

    rows << stripped.delete_prefix('|').delete_suffix('|').split('|').map(&:strip)
  end
  header_index = table_lines.index { |cells| required_headers.all? { |header| cells.include?(header) } }
  fail_with("#{label} must contain columns: #{required_headers.join(', ')}") unless header_index

  headers = table_lines.fetch(header_index)
  table_lines.drop(header_index + 1).each_with_object([]) do |cells, rows|
    next if cells.all? { |cell| cell.match?(/\A:?-{3,}:?\z/) }
    next if cells.all?(&:empty?)

    rows << headers.zip(cells).to_h
  end
end

def requirement_question_ids!(task_dir)
  path = File.join(task_dir, NODES.fetch('requirement-intake').fetch('output'))
  content = File.read(path)
  if %i[current legacy_v3].include?(markdown_artifact_layout(path))
    section = markdown_h1_body!(content, '3. 待确认', path)
    return [] if section.match?(/^\s*无[。.]?\s*$/)

    rows = markdown_table_rows_contiguous!(section, ['问题 ID', '决策 ID'], 'Requirement intake confirmation table')
    values = rows.map { |row| row.fetch('问题 ID', '').strip }
    malformed = values.reject { |value| value.match?(/\ARQ-\d{3}\z/) }
    fail_with("Requirement intake contains invalid question IDs: #{malformed.join(', ')}") unless malformed.empty?
    duplicates = values.group_by(&:itself).select { |_id, occurrences| occurrences.length > 1 }.keys
    fail_with("Requirement intake contains duplicate questions: #{duplicates.join(', ')}") unless duplicates.empty?
    return values
  end

  legacy_heading = !content.match?(/^(?:##|###)\s+待澄清项\s*$/) && content.match?(/^(?:##|###)\s+待确认项\s*$/)
  section = markdown_section!(path, ['待澄清项', '待确认项'])
  return [] if section.match?(/^\s*无[。.]?\s*$/)

  rows = markdown_table_rows!(section, ['问题 ID'], 'Requirement intake clarification table')
  values = rows.map { |row| row.fetch('问题 ID', '').strip }
  explicit_ids = values.select { |value| value.match?(/\ARQ-\d{3}\z/) }
  unless explicit_ids.empty?
    malformed = values - explicit_ids
    fail_with("Requirement intake contains invalid question IDs: #{malformed.join(', ')}") unless malformed.empty?
    duplicates = explicit_ids.group_by(&:itself).select { |_id, values| values.length > 1 }.keys
    fail_with("Requirement intake contains duplicate questions: #{duplicates.join(', ')}") unless duplicates.empty?
    return explicit_ids
  end

  # Approved legacy artifacts may have unnumbered rows. Preserve their documented row mapping.
  fail_with('Requirement intake clarification items must use RQ identifiers') unless legacy_heading
  rows.each_index.map { |index| format('RQ-L%03d', index + 1) }
end

def validate_requirement_intake!(task_dir, expected_status)
  return unless expected_status == 'completed'

  expected_questions = requirement_question_ids!(task_dir)
  path = File.join(task_dir, NODES.fetch('requirement-intake').fetch('output'))
  if %i[current legacy_v3].include?(markdown_artifact_layout(path))
    return if expected_questions.empty?

    section = markdown_h1_body!(File.read(path), '3. 待确认', path)
    rows = markdown_table_rows_contiguous!(section, ['问题 ID', '决策 ID', '采用规则', '状态'], 'Requirement intake confirmation table')
    decision_ids = rows.map { |row| row.fetch('决策 ID', '').strip }
    malformed = decision_ids.reject { |value| value.match?(/\ACL-\d{3}\z/) }
    fail_with("Requirement intake contains invalid decision IDs: #{malformed.join(', ')}") unless malformed.empty?
    duplicates = decision_ids.group_by(&:itself).select { |_id, occurrences| occurrences.length > 1 }.keys
    fail_with("Requirement intake contains duplicate decisions: #{duplicates.join(', ')}") unless duplicates.empty?

    rows.each do |row|
      rule = row.fetch('采用规则', '').strip
      fail_with("Decision #{row.fetch('决策 ID')} must provide an adopted rule") if rule.empty? || %w[- 待定 待确认].include?(rule)
      fail_with("Decision #{row.fetch('决策 ID')} must be individually confirmed by the owner") unless row.fetch('状态', '').strip == '已人工确认'
    end
    return
  end

  section = markdown_section!(path, ['确认决策'])
  if expected_questions.empty?
    fail_with('Requirement intake must state no decisions when it has no clarification items') unless section.match?(/^\s*无[。.]?\s*$/)
    return
  end

  required_headers = ['决策 ID', '来源问题 ID', '采用规则', '状态']
  rows = markdown_table_rows!(section, required_headers, 'Requirement intake decision table')
  decisions = rows.select { |row| row.fetch('决策 ID', '').match?(/\ACL-\d{3}\z/) }
  fail_with('Requirement intake must contain at least one CL decision') if decisions.empty?

  decision_ids = decisions.map { |row| row.fetch('决策 ID') }
  duplicates = decision_ids.group_by(&:itself).select { |_id, values| values.length > 1 }.keys
  fail_with("Requirement intake contains duplicate decisions: #{duplicates.join(', ')}") unless duplicates.empty?

  mapped_questions = decisions.flat_map do |row|
    rule = row.fetch('采用规则', '').strip
    fail_with("Decision #{row.fetch('决策 ID')} must provide an adopted rule") if rule.empty? || %w[- 待定 待确认].include?(rule)

    status = row.fetch('状态', '').strip
    fail_with("Decision #{row.fetch('决策 ID')} must be individually confirmed by the owner") unless status == '已人工确认'

    source_ids = row.fetch('来源问题 ID', '').scan(/RQ-(?:L)?\d{3}/)
    fail_with("Decision #{row.fetch('决策 ID')} must reference at least one RQ item") if source_ids.empty?
    source_ids
  end

  unknown = mapped_questions.uniq - expected_questions
  fail_with("Requirement intake references unknown questions: #{unknown.join(', ')}") unless unknown.empty?
  missing = expected_questions - mapped_questions.uniq
  fail_with("Requirement intake does not answer: #{missing.join(', ')}") unless missing.empty?
end

def load_yaml(path)
  YAML.safe_load(File.read(path), permitted_classes: [], aliases: false)
rescue Psych::Exception => error
  fail_with("Invalid YAML #{path}: #{error.message}")
end

def write_yaml_atomically(path, value)
  temp = "#{path}.#{Process.pid}.tmp"
  File.write(temp, YAML.dump(value))
  File.rename(temp, path)
ensure
  FileUtils.rm_f(temp) if defined?(temp)
end

def write_json_atomically(path, value)
  temp = "#{path}.#{Process.pid}.tmp"
  File.write(temp, JSON.pretty_generate(value))
  File.rename(temp, path)
ensure
  FileUtils.rm_f(temp) if defined?(temp)
end

def task_relative_path!(task_dir, path)
  root = File.expand_path(task_dir)
  expanded = File.expand_path(path)
  prefix = "#{root}#{File::SEPARATOR}"
  fail_with("Transaction path is outside task directory: #{path}") unless expanded.start_with?(prefix)
  expanded.delete_prefix(prefix)
end

def transaction_absolute_path!(task_dir, relative_path)
  fail_with('Transaction path must be relative') if Pathname.new(relative_path).absolute?
  expanded = File.expand_path(relative_path, task_dir)
  root_prefix = "#{File.expand_path(task_dir)}#{File::SEPARATOR}"
  fail_with("Transaction path escapes task directory: #{relative_path}") unless expanded.start_with?(root_prefix)
  expanded
end


def recover_interrupted_transaction!(task_dir)
  journal_path = File.join(task_dir, TRANSACTION_FILE)
  return 'none' unless File.file?(journal_path)

  journal = JSON.parse(File.read(journal_path))
  unless %w[artifact-discard artifact-archive].include?(journal['type'])
    fail_with('Unsupported workflow transaction journal')
  end
  moves = journal['moves']
  fail_with('Workflow transaction journal has invalid moves') unless moves.is_a?(Array)
  from_revision = journal['from_revision']
  to_revision = journal['to_revision']
  unless from_revision.is_a?(Integer) && to_revision == from_revision + 1
    fail_with('Workflow transaction journal has invalid revisions')
  end
  move_pairs = moves.map do |move|
    fail_with('Workflow transaction journal has an invalid move') unless move.is_a?(Hash) && move['source'].is_a?(String) && move['destination'].is_a?(String)
    fail_with('Workflow transaction source and destination must differ') if move['source'] == move['destination']
    [move['source'], move['destination']]
  end
  sources = move_pairs.map(&:first)
  destinations = move_pairs.map(&:last)
  unless sources.uniq.length == sources.length && destinations.uniq.length == destinations.length
    fail_with('Workflow transaction journal contains duplicate move paths')
  end
  state_path = File.join(task_dir, 'task.yaml')
  fail_with('Cannot recover transaction without task.yaml') unless File.file?(state_path)
  state = load_yaml(state_path)
  revision = state['revision']

  if revision == journal['from_revision']
    moves.reverse_each do |move|
      source = transaction_absolute_path!(task_dir, move.fetch('source'))
      destination = transaction_absolute_path!(task_dir, move.fetch('destination'))
      if File.exist?(destination) && !File.exist?(source)
        FileUtils.mkdir_p(File.dirname(source))
        File.rename(destination, source)
      elsif File.exist?(source) && !File.exist?(destination)
        next
      else
        fail_with("Cannot roll back interrupted move: #{move['source']} -> #{move['destination']}")
      end
    end
    FileUtils.rm_rf(File.join(task_dir, DISCARD_DIR)) if journal['type'] == 'artifact-discard'
    FileUtils.rm_f(journal_path)
    return 'rolled_back'
  end

  if revision == journal['to_revision']
    moves.each do |move|
      source = transaction_absolute_path!(task_dir, move.fetch('source'))
      destination = transaction_absolute_path!(task_dir, move.fetch('destination'))
      fail_with("Committed discard unexpectedly restored #{move['source']}") if File.exist?(source)
      FileUtils.rm_f(destination)
    end
    FileUtils.rm_rf(File.join(task_dir, DISCARD_DIR))
    FileUtils.rm_f(journal_path)
    return 'committed'
  end

  fail_with("Transaction revision mismatch: task=#{revision}, journal=#{journal['from_revision']}..#{journal['to_revision']}")
rescue JSON::ParserError, KeyError => error
  fail_with("Invalid workflow transaction journal: #{error.message}")
end

def with_task_lock(task_dir, actor)
  lock_path = File.join(task_dir, '.workflow.lock')
  lock = File.open(lock_path, File::RDWR | File::CREAT, 0o644)
  fail_with("Task state lock is already held: #{lock_path}") unless lock.flock(File::LOCK_EX | File::LOCK_NB)
  lock.rewind
  lock.truncate(0)
  lock.write(JSON.generate({ 'actor' => actor, 'pid' => Process.pid, 'acquired_at' => now }))
  lock.flush
  recovery = recover_interrupted_transaction!(task_dir)
  yield recovery
rescue Errno::EISDIR
  fail_with("Task state lock path is not a file: #{lock_path}")
ensure
  lock&.flock(File::LOCK_UN)
  lock&.close
end

def normalize_task_state!(task_dir, state)
  changed = !state.delete('schema_version').nil?
  if state['next_node'].is_a?(Hash)
    state['next_node'] = state['next_node']['name']
    changed = true
  end

  REMOVED_NODES.each do |node|
    if state['current_node'] == node || state['next_node'] == node || state.dig('gate', 'node') == node
      fail_with("Task still points to removed node #{node}; invalidate from requirement-intake before upgrading")
    end
    if Array(state['blocked_by']).any? { |blocker| blocker['retry_node'] == node }
      fail_with("Task blocker still points to removed node #{node}; invalidate from requirement-intake before upgrading")
    end

    changed = true unless state.fetch('artifacts', {}).delete(node).nil?
    changed = true unless state.fetch('attempts', {}).delete(node).nil?
  end

  legacy_artifacts = state.fetch('artifacts', {}).any? do |key, value|
    !NODES.key?(key) || !value.is_a?(Hash) || value.key?('file')
  end

  if legacy_artifacts
    migrated_artifacts = {}
    state.fetch('artifacts', {}).each do |key, value|
      node = NODES.keys.find do |candidate|
        output = NODES.fetch(candidate).fetch('output')
        legacy_key = File.basename(output, File.extname(output)).tr('-', '_')
        key == candidate || key == legacy_key
      end
      fail_with("Cannot migrate unknown artifact index entry: #{key}") unless node
      expected_file = NODES.fetch(node).fetch('output')
      file = value.is_a?(Hash) ? value['file'] || expected_file : value
      fail_with("Cannot migrate artifact index entry #{key}=#{file}") unless file == expected_file
      path = File.join(task_dir, file)
      artifact = parse_artifact_file!(path, state, node)
      migrated_artifacts[node] = build_artifact_record(path, artifact)
    end
    state['artifacts'] = migrated_artifacts
    changed = true
  end

  unless state['attempts'].is_a?(Hash)
    state['attempts'] = {}
    changed = true
  end
  state.fetch('artifacts', {}).each do |node, record|
    next if state['attempts'].key?(node)

    state['attempts'][node] = record['attempt']
    changed = true
  end

  state['delivery'] ||= {}
  (state['delivery'].keys - DELIVERY_FIELDS).each do |field|
    state['delivery'].delete(field)
    changed = true
  end
  DELIVERY_FIELDS.each do |field|
    next if state['delivery'].key?(field)

    state['delivery'][field] = nil
    changed = true
  end

  legacy_gates = Array(state['confirmation_history']) + [state['gate']].compact
  legacy_gates.each do |gate|
    next unless gate['status'] == 'approved' && !gate['invalidated_at']

    record = artifact_record(state, gate['node'])
    next unless record
    next if gate['artifact_attempt'] && gate['artifact_attempt'] != record['attempt']
    next if gate['artifact_sha256'] && gate['artifact_sha256'] != record['sha256']

    record['approved'] = true
  end

  legacy_gate_fields = %w[
    name artifact requested_at artifact_attempt artifact_sha256 decided_at decision_note
    invalidated_at invalidated_by invalidation_reason
  ]
  if state['gate'] && !(state['gate'].keys & legacy_gate_fields).empty?
    state['gate'] = state['gate'].slice('node', 'status', 'owner')
  end
  state['blocked_by'] = Array(state['blocked_by']).map do |blocker|
    legacy_blocker_fields = %w[node detected_at resolved_at resolved_by resolution]
    if (blocker.keys & legacy_blocker_fields).empty?
      blocker
    else
      blocker.slice('code', 'reason', 'owner', 'retry_node')
    end
  end
  if state['cancellation']&.key?('cancelled_at')
    state['cancellation'] = state['cancellation'].slice('cancelled_by', 'reason')
  end
  %w[
    updated_at
    artifact_history
    blocker_history
    confirmation_history
    invalidation_history
    delivery_bindings
  ].each do |field|
    changed = true unless state.delete(field).nil?
  end

  if state['status'] == 'active' && state['gate'].nil? && state['current_node'] == state['next_node']
    state['next_node'] = nil
    changed = true
  end
  if state['status'] == 'active' && state.dig('gate', 'status') == 'pending'
    state['status'] = 'awaiting_confirmation'
    changed = true
  end

  changed
end

def load_task_state!(task_dir)
  state_path = File.join(task_dir, 'task.yaml')
  fail_with("Missing task state: #{state_path}") unless File.file?(state_path)
  state = load_yaml(state_path)
  fail_with('task.yaml must contain a mapping') unless state.is_a?(Hash)
  normalize_task_state!(task_dir, state)
  validate_task_state!(state)
  state
end

def task_state!(task_dir, expected_revision, verify_artifacts: true)
  state = load_task_state!(task_dir)
  fail_with('expected revision is required') if expected_revision.nil?
  fail_with("Revision conflict: expected #{expected_revision}, found #{state['revision']}") unless state['revision'] == expected_revision
  fail_with("Task is terminal and immutable: #{state['status']}") if TERMINAL_STATUSES.include?(state['status'])
  validate_recorded_artifacts!(task_dir, state) if verify_artifacts
  state
end

def parse_artifact_file!(path, state, node)
  fail_with("Missing artifact: #{path}") unless File.file?(path)

  artifact = if path.end_with?('.json')
    JSON.parse(File.read(path))
  else
    frontmatter = File.read(path).match(/\A---\n(.*?)\n---/m)
    fail_with("Missing artifact frontmatter: #{path}") unless frontmatter
    YAML.safe_load(frontmatter[1], permitted_classes: [], aliases: false)
  end

  fail_with("Invalid artifact mapping: #{path}") unless artifact.is_a?(Hash)
  if artifact.key?('artifact_schema_version') && artifact.key?('template_version')
    fail_with("Artifact must not combine artifact_schema_version with legacy template_version: #{path}")
  end
  validate_schema!(artifact, NODE_SCHEMAS[node] || ARTIFACT_SCHEMA, File.basename(path))
  validate_markdown_artifact_structure!(path, node, artifact)
  fail_with("Artifact task_id does not match task state: #{path}") unless artifact['task_id'] == state['task_id']
  fail_with("Artifact node does not match: #{path}") unless artifact['node'] == node
  artifact
rescue JSON::ParserError, Psych::Exception => error
  fail_with("Invalid artifact #{path}: #{error.message}")
end

def validate_artifact_attempt!(task_dir, state, node, artifact, reject_recorded: true)
  if reject_recorded && state.fetch('artifacts', {}).key?(node)
    fail_with("Node #{node} already has a recorded result; use invalidate-from before rerunning it")
  end

  current_record = artifact_record(state, node)
  last_attempt = state.fetch('attempts', {}).fetch(node, 0)
  expected_attempt = if reject_recorded || current_record.nil?
    last_attempt + 1
  else
    current_record['attempt']
  end
  fail_with("Artifact attempt for #{node} must be #{expected_attempt}") unless artifact['attempt'] == expected_attempt
end

def validate_recorded_artifact!(task_dir, state, node, expected_status = nil)
  record = artifact_record(state, node)
  fail_with("Node #{node} has no recorded artifact") unless record
  path = File.join(task_dir, NODES.fetch(node).fetch('output'))
  artifact = parse_artifact_file!(path, state, node)
  fail_with("Recorded artifact attempt changed for #{node}") unless artifact['attempt'] == record['attempt']
  fail_with("Recorded artifact content changed for #{node}") unless artifact_digest(path) == record['sha256']
  if expected_status && artifact['status'] != expected_status
    fail_with("Recorded artifact status for #{node} must be #{expected_status}")
  end
  validate_requirement_routing!(artifact, artifact['status']) if node == 'requirement-routing'
  validate_requirement_intake!(task_dir, artifact['status']) if node == 'requirement-intake'
  validate_artifact_attempt!(task_dir, state, node, artifact, reject_recorded: false)
  [path, artifact]
end

def validate_recorded_artifacts!(task_dir, state)
  artifacts = {}
  NODES.each_key do |node|
    if artifact_recorded?(state, node)
      _path, artifact = validate_recorded_artifact!(task_dir, state, node)
      artifacts[node] = artifact
    end
  end
  validate_path_progress!(state, artifacts)
end

def validate_path_progress!(state, artifacts)
  return unless state['path']

  sequence = PATHS.fetch(state['path'])
  current = state['current_node']
  next_name = state['next_node']
  if current
    position = sequence.index(current)
    fail_with("Current node #{current} is not part of #{state['path']}") unless position
    completed_prefix = sequence.take(position)
    downstream = sequence.drop(position + 1)
  elsif next_name
    position = sequence.index(next_name)
    fail_with("Next node #{next_name} is not part of #{state['path']}") unless position
    completed_prefix = sequence.take(position)
    downstream = sequence.drop(position)
  elsif state['status'] == 'cancelled'
    position = sequence.index { |node| !artifacts.key?(node) } || sequence.length
    completed_prefix = sequence.take(position)
    downstream = sequence.drop(position)
  else
    fail_with("Task on #{state['path']} has no current or next node")
  end

  completed_prefix.each do |node|
    artifact = artifacts[node]
    fail_with("Path #{state['path']} is missing completed upstream artifact #{node}") unless artifact && artifact['status'] == 'completed'
  end

  downstream.each do |node|
    fail_with("Path #{state['path']} has an unreachable downstream artifact #{node}") if artifacts.key?(node)
  end

  if current && artifacts[current] && %w[active awaiting_confirmation completed].include?(state['status']) && artifacts[current]['status'] != 'completed'
    fail_with("Current artifact #{current} must be completed while task is #{state['status']}")
  end

  artifacts.each_key do |node|
    next if sequence.include?(node) || PRE_PATH_NODES.include?(node)

    fail_with("Artifact #{node} is outside the selected path #{state['path']}")
  end
end

def validate_artifact!(task_dir, state, node, expected_status, validate_attempt: false)
  path = File.join(task_dir, NODES.fetch(node).fetch('output'))
  artifact = parse_artifact_file!(path, state, node)
  fail_with("Artifact status must be #{expected_status}: #{path}") unless artifact['status'] == expected_status
  validate_requirement_routing!(artifact, expected_status) if node == 'requirement-routing'
  validate_requirement_intake!(task_dir, expected_status) if node == 'requirement-intake'
  validate_artifact_attempt!(task_dir, state, node, artifact) if validate_attempt
  [path, artifact]
end

def validate_path_prerequisites!(task_dir, state, path)
  sequence = PATHS.fetch(path)
  routing_index = sequence.index('requirement-routing')
  fail_with("Registered path #{path} does not contain requirement routing") unless routing_index

  sequence.take(routing_index).each do |node|
    fail_with("Path #{path} requires a recorded #{node} result") unless artifact_record(state, node)
    validate_recorded_artifact!(task_dir, state, node, 'completed')

  end
end

def validate_delivery_stage!(state, node)
  return unless DELIVERY_STAGES.include?(node)

  missing = DELIVERY_FIELDS.select do |field|
    value = state.dig('delivery', field)
    value.nil? || value == ''
  end
  fail_with("Delivery evidence for #{node} is missing: #{missing.join(', ')}") unless missing.empty?
end

def clear_delivery_from!(state, node)
  state['delivery'] = DELIVERY_FIELDS.to_h { |field| [field, nil] } if node == 'development-implementation'
end

def invalidated_nodes_for(state, from_node)
  if state['path']
    sequence = PATHS.fetch(state['path'])
    index = sequence.index(from_node)
    return sequence.drop(index) if index

    approved_next = GATES.dig(from_node, 'approvedNext')
    approved_index = sequence.index(approved_next)
    return ([from_node] + sequence.drop(approved_index)).uniq if approved_index

    fail_with("Node #{from_node} cannot be invalidated on #{state['path']}")
  end

  included = PATHS.values.each_with_object([]) do |sequence, nodes|
    index = sequence.index(from_node)
    nodes.concat(sequence.drop(index)) if index
  end
  invalidated = NODES.keys.select { |node| included.include?(node) }
  fail_with("Node #{from_node} is not part of any workflow path") if invalidated.empty?
  invalidated
end

def artifact_discard_plan!(task_dir, state, node)
  source = File.join(task_dir, NODES.fetch(node).fetch('output'))
  recorded = artifact_recorded?(state, node)
  in_progress = state['current_node'] == node && File.file?(source)
  return nil unless recorded || in_progress

  _path, artifact = if recorded
    validate_recorded_artifact!(task_dir, state, node)
  else
    parsed = parse_artifact_file!(source, state, node)
    validate_artifact_attempt!(task_dir, state, node, parsed)
    [source, parsed]
  end
  destination = File.join(task_dir, DISCARD_DIR, File.basename(source))
  fail_with("Artifact discard already exists: #{destination}") if File.exist?(destination)
  {
    'node' => node,
    'source' => source,
    'destination' => destination,
    'attempt' => artifact['attempt'],
  }
end

def clear_current_gate!(state)
  state['gate'] = nil
end

def clear_current_blockers!(state)
  state['blocked_by'] = []
end

def persist!(task_dir, state)
  state['revision'] += 1
  validate_task_state!(state)
  write_yaml_atomically(File.join(task_dir, 'task.yaml'), state)
  puts JSON.generate(state_response(state))
end

def persist_with_discards!(task_dir, state, discard_plans)
  return persist!(task_dir, state) if discard_plans.empty?

  from_revision = state['revision']
  state['revision'] += 1
  validate_task_state!(state)
  FileUtils.mkdir_p(File.join(task_dir, DISCARD_DIR))

  journal_path = File.join(task_dir, TRANSACTION_FILE)
  fail_with("Workflow transaction already exists: #{journal_path}") if File.exist?(journal_path)
  journal = {
    'type' => 'artifact-discard',
    'from_revision' => from_revision,
    'to_revision' => state['revision'],
    'moves' => discard_plans.map do |plan|
      {
        'source' => task_relative_path!(task_dir, plan['source']),
        'destination' => task_relative_path!(task_dir, plan['destination']),
      }
    end,
  }
  write_json_atomically(journal_path, journal)

  moved = []
  committed = false
  begin
    discard_plans.each do |plan|
      source = plan['source']
      destination = plan['destination']
      File.rename(source, destination)
      moved << [source, destination]
    end
    write_yaml_atomically(File.join(task_dir, 'task.yaml'), state)
    committed = true
    discard_plans.each { |plan| FileUtils.rm_f(plan['destination']) }
    FileUtils.rm_rf(File.join(task_dir, DISCARD_DIR))
    FileUtils.rm_f(journal_path)
  rescue StandardError
    unless committed
      moved.reverse_each do |source, destination|
        File.rename(destination, source) if File.exist?(destination) && !File.exist?(source)
      end
      FileUtils.rm_rf(File.join(task_dir, DISCARD_DIR))
      FileUtils.rm_f(journal_path)
    end
    raise
  end

  puts JSON.generate({ task_id: state['task_id'], revision: state['revision'], status: state['status'] })
end

options = { actor: nil, expected_revision: nil }
parser = OptionParser.new do |opts|
  opts.banner = 'Usage: task-state.rb <init|audit|start-node|record-result|request-gate|approve-gate|reject-gate|set-delivery|invalidate-from|cancel> [options]'
  opts.on('--task-dir DIR') { |value| options[:task_dir] = File.expand_path(value) }
  opts.on('--actor NAME') { |value| options[:actor] = value }
  opts.on('--expected-revision N', Integer) { |value| options[:expected_revision] = value }
  opts.on('--task-id ID') { |value| options[:task_id] = value }
  opts.on('--target-module PATH') { |value| options[:target_module] = value }
  opts.on('--node NODE') { |value| options[:node] = value }
  opts.on('--next-node NODE') { |value| options[:next_node] = value }
  opts.on('--result RESULT') { |value| options[:result] = value }
  opts.on('--task-status STATUS') { |value| options[:task_status] = value }
  opts.on('--gate-owner OWNER') { |value| options[:gate_owner] = value }
  opts.on('--confirmation TEXT') { |value| options[:confirmation] = value }
  opts.on('--decision-note NOTE') { |value| options[:decision_note] = value }
  opts.on('--blocker JSON') { |value| options[:blocker] = parse_json(value, '--blocker') }
  opts.on('--delivery JSON') { |value| options[:delivery] = parse_json(value, '--delivery') }
  opts.on('--reason TEXT') { |value| options[:reason] = value }
  opts.on('--cancelled-by OWNER') { |value| options[:cancelled_by] = value }
  opts.on('-h', '--help') { options[:help] = true }
end

parser.parse!(ARGV)
command = ARGV.shift
if options[:help] || command == 'help'
  puts parser
  exit 0
end
fail_with('A command is required') if command.nil?
fail_with("Unexpected arguments: #{ARGV.join(' ')}") unless ARGV.empty?
fail_with('--task-dir is required') unless options[:task_dir]

expected_actor = GATE_DECISION_COMMANDS.include?(command) ? GATE_ACTOR : ORCHESTRATOR_ACTOR
unless options[:actor] == expected_actor
  fail_with("--actor #{expected_actor} is required for #{command}")
end

common_options = %i[actor task_dir]
command_options = {
  'init' => %i[task_id target_module],
  'audit' => [],
  'start-node' => %i[expected_revision node],
  'record-result' => %i[expected_revision node next_node result task_status gate_owner blocker],
  'request-gate' => %i[expected_revision gate_owner],
  'approve-gate' => %i[expected_revision gate_owner confirmation decision_note],
  'reject-gate' => %i[expected_revision gate_owner confirmation decision_note],
  'set-delivery' => %i[expected_revision delivery],
  'invalidate-from' => %i[expected_revision node reason],
  'cancel' => %i[expected_revision cancelled_by reason],
}.freeze
allowed_options = command_options[command]
fail_with("Unknown command: #{command}") unless allowed_options
provided_options = options.select { |key, value| !value.nil? && key != :help }.keys
unexpected_options = provided_options - common_options - allowed_options
unless unexpected_options.empty?
  fail_with("Options not allowed for #{command}: #{unexpected_options.map { |key| "--#{key.to_s.tr('_', '-')}" }.join(', ')}")
end

case command
when 'init'
  fail_with('--task-id is required') unless options[:task_id]
  fail_with('--target-module is required') unless options[:target_module]
  FileUtils.mkdir_p(options[:task_dir])
  with_task_lock(options[:task_dir], options[:actor]) do
    fail_with('Task directory already has task.yaml') if File.exist?(File.join(options[:task_dir], 'task.yaml'))
    state = {
      'revision' => 0,
      'task_id' => options[:task_id],
      'target_module' => options[:target_module],
      'path' => nil,
      'current_node' => nil,
      'status' => 'active',
      'artifacts' => {},
      'attempts' => {},
      'gate' => nil,
      'cancellation' => nil,
      'next_node' => next_node('requirement-intake'),
      'blocked_by' => [],
      'delivery' => DELIVERY_FIELDS.to_h { |field| [field, nil] },
    }
    validate_task_state!(state)
    write_yaml_atomically(File.join(options[:task_dir], 'task.yaml'), state)
    puts JSON.generate({ task_id: state['task_id'], revision: 0, status: state['status'] })
  end
when 'audit'
  with_task_lock(options[:task_dir], options[:actor]) do
    state = load_task_state!(options[:task_dir])
    validate_recorded_artifacts!(options[:task_dir], state)
    puts JSON.generate(state_response(state).merge(
      path: state['path'],
      current_node: state['current_node'],
      next_node: state['next_node'],
    ))
  end
when 'start-node'
  canonical_node!(options[:node])
  with_task_lock(options[:task_dir], options[:actor]) do
    state = task_state!(options[:task_dir], options[:expected_revision])
    fail_with('Only active tasks can start a node') unless state['status'] == 'active'
    fail_with('Blocked tasks must be resumed with invalidate-from') if state['status'] == 'blocked'
    expected = state['next_node']
    fail_with("Node #{options[:node]} is not next; expected #{expected || 'none'}") unless expected == options[:node]
    if state['path']
      fail_with("Node #{options[:node]} is not part of #{state['path']}") unless PATHS.fetch(state['path']).include?(options[:node])
    else
      fail_with("Node #{options[:node]} cannot start before path selection") unless PRE_PATH_NODES.include?(options[:node])
    end
    if state.dig('gate', 'status') == 'approved'
      state['gate'] = nil
    elsif state['gate']
      fail_with('A pending or rejected gate prevents starting the next node')
    end
    state['status'] = 'active'
    state['current_node'] = options[:node]
    state['next_node'] = nil
    persist!(options[:task_dir], state)
  end
when 'record-result'
  canonical_node!(options[:node])
  result = options[:result]
  fail_with('--result must be completed or blocked') unless %w[completed blocked].include?(result)
  if result == 'blocked'
    fail_with('Blocked result cannot include --next-node, --gate-owner, or --task-status') if options[:next_node] || options[:gate_owner] || options[:task_status]
  else
    fail_with('Completed result cannot include --blocker') if options[:blocker]
    fail_with('--gate-owner cannot be combined with --next-node or --task-status') if options[:gate_owner] && (options[:next_node] || options[:task_status])
    fail_with('--task-status cannot be combined with --next-node') if options[:task_status] && options[:next_node]
  end
  with_task_lock(options[:task_dir], options[:actor]) do
    state = task_state!(options[:task_dir], options[:expected_revision])
    fail_with('Only active tasks can record a node result') unless state['status'] == 'active'
    fail_with("Current node is #{state['current_node']}, not #{options[:node]}") unless state['current_node'] == options[:node]
    fail_with('Current node is not in the executing phase') unless state['next_node'].nil? && state['gate'].nil?
    artifact_path, artifact = validate_artifact!(options[:task_dir], state, options[:node], result, validate_attempt: true)
    state['artifacts'] ||= {}
    state['artifacts'][options[:node]] = build_artifact_record(artifact_path, artifact)
    state['attempts'][options[:node]] = artifact['attempt']

    if result == 'completed' && options[:node] == 'requirement-routing'
      path = artifact['path']
      fail_with('Requirement routing artifact has an invalid path') unless PATHS.key?(path)
      validate_path_prerequisites!(options[:task_dir], state, path)
      state['path'] = path
    end

    case result
    when 'completed'
      validate_delivery_stage!(state, options[:node])
      gate = GATES[options[:node]]
      if gate
        gate_required = state['path'].nil? ? gate['beforePathSelection'] == true : gate_required_on_path?(options[:node], state['path'])
        fail_with("Node #{options[:node]} requires gate owner on the current path") if gate_required && !options[:gate_owner]
        fail_with("Gate for #{options[:node]} is not allowed on the current path") if options[:gate_owner] && !gate_required
      elsif options[:gate_owner]
        fail_with("Node #{options[:node]} does not define a task gate")
      end
      fail_with('--task-status is no longer accepted; terminal nodes complete after gate approval') if options[:task_status]

      if options[:gate_owner]
        state['status'] = 'awaiting_confirmation'
        state['gate'] = {
          'node' => options[:node], 'status' => 'pending',
          'owner' => options[:gate_owner],
        }
        state['next_node'] = next_node(gate_approved_next(state, options[:node], gate))
      else
        canonical_node!(options[:next_node])
        if state['path']
          sequence = PATHS.fetch(state['path'])
          current_index = sequence.index(options[:node])
          fail_with("Node #{options[:node]} is not part of #{state['path']}") unless current_index
          expected_next = sequence[current_index + 1]
          fail_with("Next node must be #{expected_next || 'none'} for #{state['path']}") unless options[:next_node] == expected_next
        elsif options[:node] == 'requirement-intake'
          fail_with('Requirement intake must continue to requirement routing') unless options[:next_node] == 'requirement-routing'
        else
          fail_with('Task path must be established before continuing')
        end
        state['status'] = 'active'
        state['next_node'] = next_node(options[:next_node])
      end
    when 'blocked'
      fail_with('--blocker must be an object') unless options[:blocker].is_a?(Hash)
      required = %w[code reason owner retry_node]
      fail_with("Blocker is missing #{(required - options[:blocker].keys).join(', ')}") unless (required - options[:blocker].keys).empty?
      unknown = options[:blocker].keys - required
      fail_with("Blocker contains unknown fields: #{unknown.join(', ')}") unless unknown.empty?
      canonical_node!(options[:blocker]['retry_node'])
      retry_scope = invalidated_nodes_for(state, options[:blocker]['retry_node'])
      unless retry_scope.include?(options[:node])
        fail_with("Retry node #{options[:blocker]['retry_node']} does not invalidate blocker source #{options[:node]}")
      end
      state['status'] = 'blocked'
      state['blocked_by'] ||= []
      state['blocked_by'] << options[:blocker]
      state['next_node'] = next_node(options[:blocker]['retry_node'])
    end
    persist!(options[:task_dir], state)
  end
when 'request-gate'
  fail_with('--gate-owner is required') unless options[:gate_owner]
  with_task_lock(options[:task_dir], options[:actor]) do
    state = task_state!(options[:task_dir], options[:expected_revision])
    fail_with('Only active tasks can request a gate') unless state['status'] == 'active'
    fail_with('A task gate already exists') if state['gate']
    node = state['current_node']
    fail_with('Current node is missing') unless node
    fail_with("Current node #{node} has no recorded artifact") unless artifact_recorded?(state, node)
    fail_with("Current artifact #{node} is already approved") if approved_gate_for_current_artifact?(state, node)
    gate = GATES[node]
    fail_with("Node #{node} does not define a task gate") unless gate
    gate_required = state['path'].nil? ? gate['beforePathSelection'] == true : gate_required_on_path?(node, state['path'])
    fail_with("Gate for #{node} is not allowed on the current path") unless gate_required
    expected_next = gate_approved_next(state, node, gate)
    if state['next_node'] != expected_next
      fail_with("Existing next node must be #{expected_next || 'none'} before requesting gate")
    end
    validate_recorded_artifact!(options[:task_dir], state, node, 'completed')
    state['gate'] = {
      'node' => node, 'status' => 'pending',
      'owner' => options[:gate_owner],
    }
    state['status'] = 'awaiting_confirmation'
    persist!(options[:task_dir], state)
  end
when 'approve-gate', 'reject-gate'
  if command == 'reject-gate' && (!options[:decision_note] || options[:decision_note].empty?)
    fail_with('--decision-note is required when rejecting a gate')
  end
  with_task_lock(options[:task_dir], options[:actor]) do
    state = task_state!(options[:task_dir], options[:expected_revision])
    fail_with('Only awaiting-confirmation tasks can decide a gate') unless state['status'] == 'awaiting_confirmation'
    gate = state['gate']
    fail_with('No pending gate exists') unless gate && gate['status'] == 'pending'
    fail_with('--gate-owner must match the pending gate owner') unless options[:gate_owner] == gate['owner']
    action = command == 'approve-gate' ? :approve : :reject
    expected_confirmation = gate_confirmation(state, action)
    unless options[:confirmation] == expected_confirmation
      fail_with("--confirmation must exactly equal #{expected_confirmation.inspect}")
    end
    validate_recorded_artifact!(options[:task_dir], state, gate['node'], 'completed')
    if command == 'approve-gate'
      artifact_record(state, gate['node'])['approved'] = true
      if terminal_gate?(state, gate['node'])
        missing_evidence = DELIVERY_FIELDS.select do |field|
          value = state.dig('delivery', field)
          value.nil? || value == ''
        end
        fail_with("Delivery evidence is missing: #{missing_evidence.join(', ')}") unless missing_evidence.empty?
        state['gate'] = nil
        state['status'] = 'completed'
        state['next_node'] = nil
      else
        gate['status'] = 'approved'
        state['status'] = 'active'
      end
    else
      state['gate'] = nil
      rejected_next = GATES.fetch(gate['node']).fetch('rejectedNext')
      state['status'] = 'blocked'
      state['next_node'] = next_node(rejected_next)
      state['blocked_by'] ||= []
      state['blocked_by'] << {
        'code' => 'gate_rejected', 'reason' => options[:decision_note],
        'owner' => gate['owner'], 'retry_node' => rejected_next,
      }
    end
    persist!(options[:task_dir], state)
  end
when 'set-delivery'
  fail_with('--delivery must be an object') unless options[:delivery].is_a?(Hash)
  fail_with('--delivery must contain at least one field') if options[:delivery].empty?
  unknown = options[:delivery].keys - DELIVERY_FIELDS
  fail_with("Unknown delivery fields: #{unknown.join(', ')}") unless unknown.empty?
  options[:delivery].each do |field, value|
    fail_with("Delivery value for #{field} must be a non-empty string") unless value.is_a?(String) && !value.empty?
  end
  with_task_lock(options[:task_dir], options[:actor]) do
    state = task_state!(options[:task_dir], options[:expected_revision])
    fail_with('Only an active executing node can write delivery evidence') unless state['status'] == 'active' && state['next_node'].nil? && state['gate'].nil?
    stage = state['current_node']
    fail_with("Current node #{stage || 'none'} cannot write delivery evidence") unless stage == DELIVERY_WRITER
    _artifact_path, artifact = validate_artifact!(options[:task_dir], state, stage, 'completed')
    validate_artifact_attempt!(options[:task_dir], state, stage, artifact)

    state['delivery'].merge!(options[:delivery])
    persist!(options[:task_dir], state)
  end
when 'invalidate-from'
  canonical_node!(options[:node])
  fail_with('--reason is required') unless options[:reason] && !options[:reason].empty?
  with_task_lock(options[:task_dir], options[:actor]) do
    state = task_state!(options[:task_dir], options[:expected_revision])
    invalidated_nodes = invalidated_nodes_for(state, options[:node])
    if !state.fetch('blocked_by', []).empty? && !invalidated_nodes.include?(state['current_node'])
      fail_with("Invalidation from #{options[:node]} does not cover blocker source #{state['current_node']}")
    end
    has_target_evidence = state.fetch('artifacts', {}).key?(options[:node]) ||
      state['current_node'] == options[:node] ||
      state.fetch('blocked_by', []).any? { |blocker| blocker['retry_node'] == options[:node] } ||
      state['gate']&.dig('node') == options[:node]
    fail_with("Node #{options[:node]} has no current result or execution to invalidate") unless has_target_evidence

    discard_plans = invalidated_nodes.map do |node|
      artifact_discard_plan!(options[:task_dir], state, node)
    end.compact
    discard_plans.each do |plan|
      state['attempts'][plan['node']] = [state['attempts'].fetch(plan['node'], 0), plan['attempt']].max
    end
    invalidated_nodes.each { |node| state['artifacts'].delete(node) }

    clear_current_gate!(state) if state['gate'] && invalidated_nodes.include?(state['gate']['node'])
    clear_current_blockers!(state)

    clear_delivery_from!(state, 'development-implementation') if invalidated_nodes.include?('development-implementation')

    state['path'] = nil if invalidated_nodes.include?('requirement-routing')
    state['status'] = 'active'
    state['current_node'] = nil
    state['next_node'] = next_node(options[:node])
    persist_with_discards!(options[:task_dir], state, discard_plans)
  end
when 'cancel'
  fail_with('--cancelled-by is required') unless options[:cancelled_by]
  fail_with('--reason is required') unless options[:reason]
  with_task_lock(options[:task_dir], options[:actor]) do
    state = task_state!(options[:task_dir], options[:expected_revision], verify_artifacts: false)
    clear_delivery_from!(state, state['current_node']) if state['current_node'] && !artifact_recorded?(state, state['current_node'])
    clear_current_gate!(state)
    clear_current_blockers!(state)
    state['cancellation'] = { 'cancelled_by' => options[:cancelled_by], 'reason' => options[:reason] }
    state['status'] = 'cancelled'
    state['next_node'] = nil
    persist!(options[:task_dir], state)
  end
end
