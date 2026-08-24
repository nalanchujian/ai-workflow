export function renderCliError(error: unknown, args: string[]): string {
  const rawMessage = error instanceof Error ? error.message : '未知错误';
  const message = userMessageFor(rawMessage);
  const nextSteps = guidanceFor(rawMessage, args);
  if (args.includes('--json')) {
    return JSON.stringify({ schemaVersion: 'aiw.error/v1', status: 'failed', error: { message }, nextSteps });
  }
  return [
    '操作未完成',
    '',
    `原因：${message}`,
    `结果：${args.includes('task') ? '已完成的任务记录不受影响。' : '当前命令未完成。'}`,
    ...(nextSteps.length === 0 ? [] : ['', '下一步：', ...nextSteps.map((step, index) => `${index + 1}. ${step}`)]),
  ].join('\n');
}

function userMessageFor(message: string): string {
  if (message.startsWith('任务事实尚未提交：')) return '任务记录尚未提交，暂时不能继续。';
  if (message.startsWith('业务仓库存在未提交变更')) return '业务仓库存在未提交代码，无法建立安全的执行基线。';
  if (message.includes('上下文超过预算')) return '当前节点需要的上下文超过配置上限。';
  if (looksLikeSchemaError(message)) return '节点产物格式不符合 AIW 要求。';
  return message;
}

function looksLikeSchemaError(message: string): boolean {
  return message.trimStart().startsWith('[')
    || message.includes('Invalid input')
    || message.includes('Unrecognized key')
    || message.includes('产物格式无效');
}

function guidanceFor(message: string, args: string[]): string[] {
  const retry = commandFor(args);
  if (message.startsWith('任务事实尚未提交：')) {
    return [
      'git add .aiw && git commit -m "chore(aiw): record task facts"',
      retry,
    ];
  }
  if (message.startsWith('业务仓库存在未提交变更，无法建立可信基线：')) {
    return [
      'git status --short',
      '将已有业务改动提交、暂存到其他工作区，或明确处理后再继续。',
      retry,
    ];
  }
  if (message.includes('重新固化需求来源后再运行。')) {
    return [
      '不要手动编辑 .aiw/tasks/ 下的 snapshot.md 或 meta.json。',
      '执行错误信息中给出的 task source refresh 命令，重新读取并固化需求来源。',
      retry,
    ];
  }
  if (message.includes('上下文超过预算')) {
    return ['精简上游交接包，或将实施计划拆为更小的工作单元后重试当前节点。'];
  }
  if (looksLikeSchemaError(message)) {
    return ['aiw doctor --project .', retry];
  }
  if (message === '当前任务已有节点正在运行' || message.includes('当前任务正在被其他命令修改')) {
    const taskId = taskIdFrom(args);
    return [
      ...(taskId === undefined ? [] : [`aiw task status ${taskId}`]),
      '不要同时执行运行、审批、决策或来源刷新；等待当前操作结束后再重试。',
    ];
  }
  if (message.includes('只能运行已就绪且已锁定技能的节点')) {
    const taskId = taskIdFrom(args);
    return taskId === undefined ? [] : [`aiw task status ${taskId}`];
  }
  return [];
}

function taskIdFrom(args: string[]): string | undefined {
  const taskIndex = args.indexOf('task');
  return taskIndex !== -1 && args[taskIndex + 1] === 'run' ? args[taskIndex + 2] : undefined;
}

function commandFor(args: string[]): string {
  return `aiw ${args.map(shellQuote).join(' ')}`;
}

function shellQuote(value: string): string {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}
