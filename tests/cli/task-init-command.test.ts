import { describe, expect, it } from 'vitest';

import { createTaskInitCommand } from '../../src/cli/task-init-command.js';

describe('task init command', () => {
  it('creates a task without accepting a caller-provided task ID', async () => {
    let received: unknown;
    let output = '';
    const command = createTaskInitCommand({
      initializer: { async init(input: { projectRoot: string; source: string; skillProfile: string }) { received = input; return { id: 'task-20260813-120000-000', status: 'active', skillProfile: { name: 'standard-web-feature' }, nodes: {} }; } } as never,
      defaultSkillProfile: async () => 'standard-web-feature',
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'init', '--project', '/repo', '--source', '/repo/requirements.md', '--skill-profile', 'standard-web-feature']);

    expect(received).toEqual({ projectRoot: '/repo', source: '/repo/requirements.md', skillProfile: 'standard-web-feature' });
    expect(output).toContain('任务已创建');
    expect(output).toContain('任务 ID：task-20260813-120000-000');
    expect(output).toContain('工作流：standard-web-feature');
    expect(output).not.toContain('standard-web-feature@');
    expect(output).toContain('下一步：');
    expect(output).toContain('git add .aiw && git commit -m "chore(aiw): initialize task"');
    expect(output).toContain('aiw task run task-20260813-120000-000 clarify');
    expect(output).not.toContain('aiw task continue');
    expect(output).not.toContain('"taskId"');
  });

  it('rejects a manually supplied task ID', async () => {
    const command = createTaskInitCommand({
      initializer: { async init() { throw new Error('不应调用初始化器'); } } as never,
      defaultSkillProfile: async () => 'standard-web-feature',
      stdout: { write() { return true; } } as unknown as NodeJS.WriteStream,
    });
    command.configureOutput({ writeErr() {} });
    command.exitOverride();

    await expect(command.parseAsync(['node', 'init', 'manual-id', '--project', '/repo', '--source', '/repo/requirements.md', '--skill-profile', 'standard-web-feature']))
      .rejects.toMatchObject({ code: 'commander.excessArguments' });
  });

  it('uses the local default profile when the caller omits the override', async () => {
    let received: unknown;
    const command = createTaskInitCommand({
      initializer: { async init(input: unknown) { received = input; return { id: 'task-20260813-120000-000', status: 'active', skillProfile: { name: 'standard-web-feature' }, nodes: {} }; } } as never,
      defaultSkillProfile: async () => 'standard-web-feature',
      stdout: { write() { return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'init', '--project', '/repo', '--source', '/repo/requirements.md']);

    expect(received).toEqual({ projectRoot: '/repo', source: '/repo/requirements.md', skillProfile: 'standard-web-feature' });
  });

  it('forwards a generic document section selector without exposing its connector', async () => {
    let received: unknown;
    const command = createTaskInitCommand({
      initializer: { async init(input: unknown) { received = input; return { id: 'task-20260813-120000-000', status: 'active', skillProfile: { name: 'standard-web-feature' }, nodes: {} }; } } as never,
      defaultSkillProfile: async () => 'standard-web-feature',
      stdout: { write() { return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'init', '--project', '/repo', '--source', 'https://acme.larksuite.com/docx/doccn123', '--section', '订单退款流程']);

    expect(received).toEqual({
      projectRoot: '/repo',
      source: 'https://acme.larksuite.com/docx/doccn123',
      section: '订单退款流程',
      skillProfile: 'standard-web-feature',
    });
  });

  it('forwards force-new only when the caller explicitly requests another task', async () => {
    let received: unknown;
    const command = createTaskInitCommand({
      initializer: { async init(input: unknown) { received = input; return { id: 'task-20260813-120000-000', status: 'active', skillProfile: { name: 'standard-web-feature' }, nodes: {} }; } } as never,
      defaultSkillProfile: async () => 'standard-web-feature',
      stdout: { write() { return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'init', '--project', '/repo', '--source', '/repo/requirements.md', '--force-new']);

    expect(received).toEqual({
      projectRoot: '/repo',
      source: '/repo/requirements.md',
      skillProfile: 'standard-web-feature',
      forceNew: true,
    });
  });

  it('forwards multiple exported design images and keeps clarification as the first executable node', async () => {
    let received: unknown;
    let output = '';
    const command = createTaskInitCommand({
      initializer: { async init(input: unknown) { received = input; return { id: 'task-20260813-120000-000', status: 'active', skillProfile: { name: 'standard-web-feature' }, nodes: { clarify: { status: 'ready' }, 'design-analysis': { status: 'pending' } } }; } } as never,
      defaultSkillProfile: async () => 'standard-web-feature',
      stdout: { write(chunk: string) { output += chunk; return true; } } as unknown as NodeJS.WriteStream,
    });

    await command.parseAsync(['node', 'init', '--project', '/repo', '--source', '/repo/requirements.md', '--design-image', 'design/main.png', '--design-image', 'design/details.png']);

    expect(received).toEqual({ projectRoot: '/repo', source: '/repo/requirements.md', designImages: ['design/main.png', 'design/details.png'], skillProfile: 'standard-web-feature' });
    expect(output).toContain('aiw task run task-20260813-120000-000 clarify');
  });
});
