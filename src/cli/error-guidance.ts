export function renderCliError(error: unknown, args: string[]): string {
  const message = error instanceof Error ? error.message : '未知错误';
  const nextSteps = guidanceFor(message, args);
  return [
    `aiw: ${message}`,
    ...(nextSteps.length === 0 ? [] : ['', '下一步：', ...nextSteps.map((step, index) => `${index + 1}. ${step}`)]),
  ].join('\n');
}

function guidanceFor(message: string, args: string[]): string[] {
  const retry = commandFor(args);
  if (message.startsWith('任务事实尚未提交：')) {
    return [
      'git add .aiw',
      'git commit -m "chore(aiw): record task facts"',
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
  if (message.includes('上下文超过预算')) {
    const taskId = taskIdFrom(args);
    return taskId === undefined
      ? []
      : [`aiw task status ${taskId}`, '精简上游交接包或将实施计划拆为更小的工作单元后再运行。'];
  }
  if (message === '当前任务已有节点正在运行') {
    const taskId = taskIdFrom(args);
    return taskId === undefined ? [] : [`aiw task status ${taskId}`, '不要重复启动；等待当前节点结束，或在确认进程异常后按状态提示处理。'];
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
