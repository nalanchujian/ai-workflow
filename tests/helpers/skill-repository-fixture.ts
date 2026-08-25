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
    '',
  ].join('\n'));
  await writeMethod(methodRoot, 'brainstorming');
  await writeMethod(methodRoot, 'writing-plans');
  await mkdir(join(repository, 'skills'), { recursive: true });
  const skills = [
    ['figma-design-analysis', ['design'], undefined],
    ['requirements-clarification', ['clarify'], 'brainstorming'],
    ['technical-solution', ['solution'], 'brainstorming'],
    ['implementation-planning', ['plan'], 'writing-plans'],
    ['typescript-web-implementation', ['development'], undefined],
  ] as const;
  for (const [name, phases, method] of skills) {
    const directory = join(repository, 'skills', name);
    await mkdir(directory, { recursive: true });
    const methodSources = method === undefined
      ? 'methodSources: []'
      : `methodSources:\n  - id: superpowers:${method}\n    version: 6.2.0\n    source: bundled:superpowers`;
    await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\nversion: 2.0.0\ndescription: ${name} description\naiwCompatibility: ">=0.0.1 <1.0.0"\nartifactContract: aiw.task-output/v1\nphases: [${phases.join(', ')}]\n${methodSources}\n---\n\n# ${name}\n\n## 输入\n\n- input\n\n## 步骤\n\n1. step\n\n## 输出\n\n- result\n`);
  }
  const profileDirectory = join(repository, 'profiles', 'standard-web-feature');
  await mkdir(profileDirectory, { recursive: true });
  await writeFile(join(profileDirectory, 'PROFILE.yaml'), `name: standard-web-feature\ndescription: Standard web feature workflow\naiwCompatibility: ">=0.0.1 <1.0.0"\nartifactContract: aiw.task-output/v1\nskills:\n  design: figma-design-analysis@2.0.0\n  clarify: requirements-clarification@2.0.0\n  solution: technical-solution@2.0.0\n  plan: implementation-planning@2.0.0\n  development: typescript-web-implementation@2.0.0\n`);
  return { repository };
}

async function writeMethod(root: string, name: string): Promise<void> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\n---\n\n# ${name}\n`);
}
