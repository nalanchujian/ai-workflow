import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function createBundledSkillRepositoryFixture(root: string): Promise<{ repository: string }> {
  const repository = join(root, 'bundled-agent-skills');
  await mkdir(join(repository, 'skills'), { recursive: true });
  const skills = [
    ['api-analysis', ['api-analysis']],
    ['design-slicing', ['design-slicing']],
    ['requirement-analysis', ['requirement-analysis']],
    ['technical-solution', ['solution']],
    ['implementation-planning', ['plan']],
    ['typescript-web-implementation', ['development']],
  ] as const;
  for (const [name, phases] of skills) {
    const directory = join(repository, 'skills', name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\nversion: 2.0.0\ndescription: ${name} description\naiwCompatibility: ">=0.0.1 <1.0.0"\nartifactContract: aiw.task-output/v2\nphases: [${phases.join(', ')}]\n---\n\n# ${name}\n\n## 输入\n\n- input\n\n## 步骤\n\n1. step\n\n## 输出\n\n- result\n`);
  }
  const profileDirectory = join(repository, 'profiles', 'standard-web-feature');
  await mkdir(profileDirectory, { recursive: true });
  await writeFile(join(profileDirectory, 'PROFILE.yaml'), `name: standard-web-feature\ndescription: Standard web feature workflow\naiwCompatibility: ">=0.0.1 <1.0.0"\nartifactContract: aiw.task-output/v2\nskills:\n  api-analysis: [api-analysis@2.0.0]\n  design-slicing: [design-slicing@2.0.0]\n  'requirement-analysis': [requirement-analysis@2.0.0]\n  solution: [technical-solution@2.0.0]\n  plan: [implementation-planning@2.0.0]\n  development: [typescript-web-implementation@2.0.0]\n`);
  return { repository };
}
