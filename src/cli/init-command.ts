import { Command } from 'commander';

import type { LocalInitializer } from '../services/local-initializer.js';
import { writeCommandResult } from './output.js';

export function createInitCommand(deps: { initializer: LocalInitializer; stdout: NodeJS.WriteStream }): Command {
  return new Command('init')
    .description('初始化本机 AI Workflow 配置模板')
    .action(async (_options: unknown, command: Command) => {
      writeCommandResult(await deps.initializer.init(), command, deps.stdout);
    });
}
