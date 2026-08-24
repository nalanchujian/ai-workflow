import { Command } from 'commander';

import type { TaskRunner } from '../services/task-runner.js';
import { writeCommandResult } from './output.js';
import { createReviewPrompter, type ReviewPrompter } from './review-prompter.js';
import { executeTaskNode } from './task-run-command.js';
import {
  nextStepsForTask,
  reviewClarifyInteractively,
  type TaskStateCommands,
} from './task-state-commands.js';
import type { ProgressReporter } from './progress-reporter.js';

type ContinueTaskState = Pick<
  TaskStateCommands,
  'status' | 'uncommittedTaskPaths' | 'runBusinessPaths' | 'pendingDecisions' | 'reviewClarify'
>;

export function createTaskContinueCommand(deps: {
  runner: TaskRunner;
  taskState: ContinueTaskState;
  progress?: ProgressReporter;
  reviewPrompter?: ReviewPrompter;
  stdout: NodeJS.WriteStream;
}): Command {
  return new Command('continue')
    .description('按当前状态继续任务')
    .argument('<task-id>')
    .option('--project <path>', '业务仓库根目录；默认当前目录')
    .action(async (taskId: string, _options: unknown, command: Command) => {
      const task = await deps.taskState.status(taskId);
      const uncommitted = await deps.taskState.uncommittedTaskPaths(taskId);
      if (uncommitted.length > 0) {
        writeCommandResult(task, command, deps.stdout, {
          headline: '继续任务前需要先提交任务记录',
          nextSteps: [
            'git add .aiw && git commit -m "chore(aiw): record task facts"',
            `aiw task continue ${taskId}`,
          ],
        });
        return;
      }

      if (task.nodes.clarify?.status === 'awaiting_approval') {
        if (command.optsWithGlobals().json) {
          writeCommandResult(task, command, deps.stdout, {
            headline: '需求澄清等待确认',
            nextSteps: [`aiw task review ${taskId}`],
          });
          return;
        }
        const reviewed = await reviewClarifyInteractively(
          deps.taskState,
          taskId,
          deps.reviewPrompter ?? createReviewPrompter(deps.stdout),
          deps.stdout,
        );
        writeCommandResult(reviewed, command, deps.stdout, {
          headline: '需求澄清已确认',
          nextSteps: await nextStepsForTask(deps.taskState, reviewed, 'review clarify'),
        });
        return;
      }

      const approval = Object.entries(task.nodes).find(([, node]) => node.status === 'awaiting_approval');
      if (approval !== undefined) {
        writeCommandResult(task, command, deps.stdout, {
          headline: approval[0] === 'plan' ? '开发计划等待确认' : `「${approval[1].title}」等待确认`,
          nextSteps: [`aiw task approve ${taskId} ${approval[0]} --note "<审批说明>"`],
        });
        return;
      }

      const runnable = Object.entries(task.nodes).find(([, node]) =>
        ['ready', 'failed'].includes(node.status)
        && node.dependsOn.every((dependency) => task.nodes[dependency]?.status === 'completed'));
      if (runnable !== undefined) {
        await executeTaskNode(deps, {
          taskId,
          nodeId: runnable[0],
          dryRun: false,
          includes: [],
          command,
        });
        return;
      }

      writeCommandResult(task, command, deps.stdout, task.status === 'completed'
        ? { headline: '任务开发已完成' }
        : { headline: '任务当前无法自动继续', nextSteps: [`aiw task status ${taskId}`] });
    });
}
