import { Command } from 'commander';

import { TaskInputService } from '../services/task-input-service.js';
import { writeCommandResult } from './output.js';
import { createReviewPrompter, type ReviewPrompter } from './review-prompter.js';
import { workflowNextSteps } from './task-state-commands.js';

export function createTaskInputCommand(deps: { inputs: TaskInputService; stdout: NodeJS.WriteStream; prompter?: ReviewPrompter }): Command {
  return new Command('inputs')
    .description('通过对话补充可选的接口文档和设计图')
    .argument('<task-id>')
    .action(async (taskId: string, _options: unknown, command: Command) => {
      if (deps.prompter === undefined && !process.stdin.isTTY) throw new Error('资料选择需要交互终端，请在终端执行 aiw task inputs <task-id>');
      const task = await deps.inputs.status(taskId);
      if (task.nodes['requirement-analysis']?.status !== 'completed') throw new Error('请先完成需求分析及待决策事项，再补充资料');
      const prompter = deps.prompter ?? createReviewPrompter(deps.stdout);
      let current = task;
      if (current.inputs.apiDocuments.status === 'not-asked') current = await collectApiDocuments(deps.inputs, current.id, prompter, deps.stdout);
      if (current.inputs.design.status === 'not-asked') current = await collectDesignImage(deps.inputs, current.id, prompter, deps.stdout);
      writeCommandResult(current, command, deps.stdout, { headline: '补充资料已保存', nextSteps: workflowNextSteps(current) });
    });
}

async function collectApiDocuments(inputs: TaskInputService, taskId: string, prompter: ReviewPrompter, stdout: NodeJS.WriteStream) {
  const choice = await askChoice(prompter, '是否提供接口文档？（1. 提供 / 2. 不提供）：');
  if (choice === 2) return inputs.saveApiDocuments(taskId, undefined);
  stdout.write('每行输入一个接口文档 URL，输入空行结束。\n');
  while (true) {
    const urls: string[] = [];
    while (true) {
      const url = (await prompter.ask('接口文档 URL：')).trim();
      if (url === '') break;
      urls.push(url);
    }
    try { return await inputs.saveApiDocuments(taskId, urls); } catch (error) { stdout.write(`${errorMessage(error)}，请重新输入。\n`); }
  }
}

async function collectDesignImage(inputs: TaskInputService, taskId: string, prompter: ReviewPrompter, stdout: NodeJS.WriteStream) {
  const choice = await askChoice(prompter, '是否提供设计图？（1. 提供 / 2. 不提供）：');
  if (choice === 2) return inputs.saveDesignImage(taskId, undefined);
  while (true) {
    const image = (await prompter.ask('设计图路径：')).trim();
    try { return await inputs.saveDesignImage(taskId, image); } catch (error) { stdout.write(`${errorMessage(error)}，请重新输入。\n`); }
  }
}

async function askChoice(prompter: ReviewPrompter, prompt: string): Promise<1 | 2> {
  while (true) {
    const choice = Number((await prompter.ask(prompt)).trim());
    if (choice === 1 || choice === 2) return choice;
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : '资料保存失败'; }
