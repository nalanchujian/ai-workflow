import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createCliRuntime } from '../../src/cli/create-runtime.js';
import { FakeGitClient, FakeRepositoryStatus } from '../fakes/fake-git-client.js';
import { FakeNetworkClient } from '../fakes/fake-network-client.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { completeNode } from '../helpers/complete-node.js';
import { runCli } from '../helpers/run-cli.js';
import { createBundledSkillRepositoryFixture } from '../helpers/skill-repository-fixture.js';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp-directory.js';

const directories: string[] = [];
const taskId = 'task-20260813-120000-000';

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTempDirectory));
});

describe('MVP workflow (AC-1, AC-3, AC-7, AC-12, AC-24)', () => {
  it('initializes seven phases and dry-runs clarify with a committed locked Superpowers method', async () => {
    const fixture = await createFixture();

    await expect(runCli(['skills', 'install', fixture.skillRepository], fixture.runtime)).resolves.toMatchObject({ exitCode: 0 });
    await expect(runCli(['skills', 'profiles', 'list', '--json'], fixture.runtime)).resolves.toMatchObject({ exitCode: 0 });
    await expect(runCli(['task', 'init', '--project', fixture.projectRoot, '--source', fixture.requirementsPath, '--skill-profile', 'standard-web-feature@2.0.0'], fixture.runtime)).resolves.toMatchObject({ exitCode: 0 });
    await expect(runCli(['task', 'source', 'refresh', taskId, 'requirements', '--json'], fixture.runtime)).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining('"changed":false'),
    });
    fixture.repository.commitTaskFacts();

    const result = await runCli(['task', 'run', taskId, 'clarify', '--dry-run', '--json'], fixture.runtime);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'succeeded',
      contextManifest: { skill: { methodSources: [expect.objectContaining({ id: 'superpowers:brainstorming', source: 'bundled:superpowers', revision: 'a'.repeat(40) })] } },
    });
    expect(fixture.process.calls).toHaveLength(0);
  });

  it('runs all seven phases through public commands with deterministic process and Git substitutes', async () => {
    const fixture = await createFixture();
    await runCli(['skills', 'install', fixture.skillRepository], fixture.runtime);
    await runCli(['task', 'init', '--project', fixture.projectRoot, '--source', fixture.requirementsPath, '--skill-profile', 'standard-web-feature@2.0.0'], fixture.runtime);
    fixture.repository.commitTaskFacts();
    fixture.process.onRun = async (input) => {
      const nodeId = /node="([a-z]+)"/.exec(input.stdin)?.[1];
      if (nodeId === undefined) {
        throw new Error('未找到当前节点');
      }
      await completeNode(fixture.projectRoot, taskId, nodeId);
    };

    for (const nodeId of ['clarify', 'solution', 'plan', 'implement', 'verify', 'test']) {
      const run = await runCli(['task', 'run', taskId, nodeId], fixture.runtime);
      expect(run.exitCode).toBe(0);
      fixture.repository.commitTaskFacts();
      if (['clarify', 'plan', 'test'].includes(nodeId)) {
        await expect(runCli(['task', 'approve', taskId, nodeId, '--actor', 'tech-lead'], fixture.runtime)).resolves.toMatchObject({ exitCode: 0 });
        fixture.repository.commitTaskFacts();
      }
    }

    const status = await runCli(['task', 'status', taskId, '--json'], fixture.runtime);
    expect(JSON.parse(status.stdout).nodes.test.status).toBe('completed');
    expect(fixture.process.calls).toHaveLength(6);
  });

});

async function createFixture() {
  const root = await createTempDirectory('aiw-e2e-');
  directories.push(root);
  const projectRoot = join(root, 'project');
  const localHome = join(root, 'local');
  await mkdir(projectRoot, { recursive: true });
  const requirementsPath = join(projectRoot, 'requirements.md');
  await writeFile(requirementsPath, '# 退款需求\n', 'utf8');
  const skillRepository = (await createBundledSkillRepositoryFixture(root)).repository;
  const repository = new FakeRepositoryStatus();
  const process = new FakeProcessRunner();
  const runtime = createCliRuntime({
    homeDirectory: localHome,
    projectRoot: () => projectRoot,
    taskCreatedAt: () => new Date('2026-08-13T12:00:00.000Z'),
    ports: {
      git: new FakeGitClient({ [skillRepository]: { directory: skillRepository, revision: 'fixture-revision' } }),
      repositoryStatus: repository,
      network: new FakeNetworkClient(),
      processRunner: process,
    },
  });
  return { runtime, repository, process, projectRoot, requirementsPath, skillRepository };
}
