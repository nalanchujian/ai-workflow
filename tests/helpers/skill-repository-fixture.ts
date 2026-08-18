import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function createBundledSkillRepositoryFixture(root: string): Promise<{ repository: string }> {
  const repository = join(root, 'bundled-agent-skills');
  const methodRoot = join(repository, 'method-sources', 'superpowers', '6.2.0');
  await mkdir(methodRoot, { recursive: true });
  await writeFile(join(methodRoot, 'SOURCE.yaml'), [
    'id: superpowers',
    'version: 6.2.0',
    'upstream:',
    '  url: https://github.com/obra/superpowers.git',
    `  revision: ${'a'.repeat(40)}`,
    '  license: MIT',
    'methods:',
    '  - brainstorming',
    '  - writing-plans',
    '  - test-driven-development',
    '',
  ].join('\n'));
  await writeMethod(methodRoot, 'brainstorming');
  await writeMethod(methodRoot, 'writing-plans');
  await writeMethod(methodRoot, 'test-driven-development');
  await mkdir(join(repository, 'skills'), { recursive: true });
  const skills = [
    ['requirements-clarification', ['clarify'], 'brainstorming'],
    ['technical-solution', ['solution'], 'brainstorming'],
    ['implementation-planning', ['plan'], 'writing-plans'],
    ['typescript-web-implementation', ['implement'], 'test-driven-development'],
  ] as const;
  for (const [name, phases, method] of skills) {
    const directory = join(repository, 'skills', name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\nversion: 2.0.0\ndescription: ${name} description\nphases: [${phases.join(', ')}]\nmethodSources:\n  - id: superpowers:${method}\n    version: 6.2.0\n    source: bundled:superpowers\n---\n\n# ${name}\n\n## 输入\n\n- input\n\n## 步骤\n\n1. step\n\n## 验证\n\n- verify\n`);
  }
  const profileDirectory = join(repository, 'profiles', 'standard-web-feature');
  await mkdir(profileDirectory, { recursive: true });
  await writeFile(join(profileDirectory, 'PROFILE.yaml'), `name: standard-web-feature\nversion: 2.0.0\ndescription: Standard web feature workflow\nskills:\n  clarify: requirements-clarification@2.0.0\n  solution: technical-solution@2.0.0\n  plan: implementation-planning@2.0.0\n  implement: typescript-web-implementation@2.0.0\n`);
  return { repository };
}

async function writeMethod(root: string, name: string): Promise<void> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\n---\n\n# ${name}\n`);
}
