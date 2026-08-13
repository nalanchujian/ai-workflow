export interface DefaultWorkflow {
  defaultSkillSource: {
    url: string;
    ref: string;
  };
  defaultProfile: string;
}

export const officialDefaultWorkflow: DefaultWorkflow = {
  defaultSkillSource: {
    url: 'https://github.com/nalanchujian/ai-workflow-skills.git',
    ref: 'v2.1.0',
  },
  defaultProfile: 'standard-web-feature@2.1.0',
};
