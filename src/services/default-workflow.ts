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
    ref: 'v0.0.8',
  },
  defaultProfile: 'standard-web-feature',
};
