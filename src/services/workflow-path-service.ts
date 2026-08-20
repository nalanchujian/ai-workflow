import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse, stringify } from 'yaml';

import {
  QUICK_SOURCE_CHARACTER_LIMIT,
  WORKFLOW_PATH_POLICY_VERSION,
  WorkflowPathAssessmentSchema,
  type WorkflowPathAssessment,
} from '../domain/workflow-path.js';
import { type Task } from '../domain/task.js';
import { readClarificationImpactArtifacts } from './task-impact-service.js';
import { TaskStore } from './task-store.js';

export class WorkflowPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowPathError';
  }
}

/**
 * AIW owns this assessment rather than asking the agent to self-classify a
 * task.  The rules deliberately only permit a fast path when every relevant
 * input is explicit and small; uncertainty always falls back to standard.
 */
export class WorkflowPathService {
  constructor(private readonly taskStore: TaskStore, private readonly now: () => Date = () => new Date()) {}

  async assess(task: Task): Promise<WorkflowPathAssessment> {
    const clarify = task.nodes.clarify;
    if (clarify?.hasResult !== true) {
      throw new WorkflowPathError('需求澄清尚未生成，无法评估工作方式');
    }
    const [artifacts, sourceContents] = await Promise.all([
      readClarificationImpactArtifacts(task, this.taskStore),
      Promise.all(Object.values(task.sources).map(async (source) => readFile(join(this.taskStore.taskDirectory(task.id), source.snapshotPath), 'utf8'))),
    ]);
    const sourceCharacters = sourceContents.reduce((total, content) => total + [...content].length, 0);
    const nonConfirmedFacts = artifacts.facts.items.filter((fact) => fact.kind !== 'confirmed' || fact.confidence !== 'high');
    const reasons: Array<{ code: string; message: string }> = [];

    if (sourceContents.length !== 1) {
      reasons.push({ code: 'multiple-sources', message: `当前有 ${sourceContents.length} 个需求来源，需要标准需求统一处理来源间关系。` });
    }
    if (sourceCharacters > QUICK_SOURCE_CHARACTER_LIMIT) {
      reasons.push({ code: 'source-too-large', message: `需求快照约 ${sourceCharacters} 字，超过快速修改的 ${QUICK_SOURCE_CHARACTER_LIMIT} 字上限。` });
    }
    if (artifacts.acceptance.items.length !== 1) {
      reasons.push({ code: 'multiple-acceptance', message: `当前有 ${artifacts.acceptance.items.length} 个验收项，需按业务单元规划交付。` });
    }
    if (artifacts.decisions.items.length > 0) {
      reasons.push({ code: 'has-decisions', message: `当前有 ${artifacts.decisions.items.length} 个待确认业务结论，不能绕过方案与规划。` });
    }
    if (nonConfirmedFacts.length > 0) {
      reasons.push({ code: 'uncertain-facts', message: `存在 ${nonConfirmedFacts.length} 个非已确认事实，必须走标准需求处理不确定性。` });
    }

    return WorkflowPathAssessmentSchema.parse({
      schemaVersion: 'aiw.workflow-path-assessment/v1',
      taskId: task.id,
      policyVersion: WORKFLOW_PATH_POLICY_VERSION,
      recommendedPath: reasons.length === 0 ? 'quick' : 'standard',
      signals: {
        sourceCount: sourceContents.length,
        sourceCharacters,
        acceptanceCount: artifacts.acceptance.items.length,
        decisionCount: artifacts.decisions.items.length,
        confirmedFactCount: artifacts.facts.items.length - nonConfirmedFacts.length,
        nonConfirmedFactCount: nonConfirmedFacts.length,
      },
      quick: { eligible: reasons.length === 0, reasons },
      evaluatedAt: this.now().toISOString(),
    });
  }

  artifactPath(): string {
    return 'workflow-assessments/clarify.yaml';
  }

  serialize(assessment: WorkflowPathAssessment): { path: string; content: string; sha256: string } {
    const content = stringify(assessment);
    return {
      path: this.artifactPath(),
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  }

  async validateSelection(task: Task): Promise<void> {
    const selection = task.workflowPath;
    if (selection === undefined) return;
    const clarify = task.nodes.clarify;
    if (clarify?.hasResult !== true) {
      throw new WorkflowPathError('当前工作方式缺少需求澄清结果；请重新执行 aiw task review 确认。');
    }
    let content: string;
    try {
      content = await readFile(join(this.taskStore.taskDirectory(task.id), selection.assessmentPath), 'utf8');
    } catch {
      throw new WorkflowPathError('工作方式评估记录缺失；请重新执行 aiw task review 确认。');
    }
    const sha256 = createHash('sha256').update(content).digest('hex');
    if (sha256 !== selection.assessmentSha256) {
      throw new WorkflowPathError('工作方式评估记录已变化；请重新执行 aiw task review 确认。');
    }
    const assessment = WorkflowPathAssessmentSchema.parse(parse(content));
    if (assessment.taskId !== task.id || assessment.policyVersion !== selection.policyVersion) {
      throw new WorkflowPathError('工作方式评估记录与当前任务不匹配；请重新执行 aiw task review 确认。');
    }
    if (selection.id === 'quick' && !assessment.quick.eligible) {
      throw new WorkflowPathError('快速修改条件已不满足；请重新执行 aiw task review 并按标准需求推进。');
    }
  }
}
