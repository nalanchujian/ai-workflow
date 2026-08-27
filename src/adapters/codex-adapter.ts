import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RunRequestSchema, RunResultSchema, type RunRequest, type RunResult } from '../domain/run.js';
import { markdownArtifactContractFor } from '../domain/artifact-contracts.js';
import { codexOutputEntries } from '../domain/output-contract.js';
import { renderAgentArtifactProtocol } from '../services/agent-artifact-protocol.js';
import { ExecutableNotFoundError, type ProcessRunner } from '../ports/process-runner.js';
import { minimalChildEnvironment } from './child-process-environment.js';

const DEFAULT_EXECUTION_TIMEOUT_MS = 15 * 60 * 1_000;
const FIGMA_CHROME_TAB_PROTOCOL = '使用已安装的 Chrome 浏览器控制插件访问已登录的 Figma。读取用户已打开页签，优先 claim URL 中 fileKey 与任务一致的已有 Figma 页签；找不到时才新建临时页签并打开任务指定的完整 URL。任务结束时只关闭本次新建的临时页签，保留用户原有 Chrome 页签。不得调用 Figma MCP、Figma Connector 或 Figma API，不得修改 Figma 文件。';
const FIGMA_NATIVE_EXPORT_PROTOCOL = [
  '在目标页签中定位任务指定的 node-id，选中该父节点后调用 Figma 原生 Actions → Copy as PNG。读取剪贴板中的 image/png 并保存为完整父节点 PNG；浏览器截图、系统全屏截图和 tab.screenshot 只能用于确认界面状态，不能作为设计资产来源。',
  '不得给节点添加 Export settings，也不得为了导出而修改、保存或发布 Figma 文件。原生复制失败时输出 blocked 和具体原因，不得退化为浏览器截图。',
  '使用完整父节点 PNG 识别逻辑业务块。优先依据绿色背景容器、编号标记、标题和明显留白边界划分；这些视觉块才是交付单位。不得把直接子节点数量当作业务块数量，也不得盲目逐个导出内部 Frame、组件、注释或连线。',
  '保留完整父节点 PNG 作为本地中间证据；对每个逻辑业务块执行本地裁切，裁切结果不得包含相邻业务块。用 file 确认每张图片是 PNG/JPEG，并用 view_image 检查内容完整、清晰且边界正确。',
  '每个裁切块写入独立资产记录，kind 使用 block，nodeId 与 sectionNodeId 使用任务指定的父节点 ID，figmaUrl 使用任务原地址。裁切图片数量必须等于逻辑业务块数量。',
].join('');

export class CodexAdapter {
  constructor(private readonly deps: { processRunner: ProcessRunner; codexBin?: string; executionTimeoutMs?: number }) {}

  async run(input: RunRequest, options: { onProcessStarted?: (processId: number) => Promise<void> | void; signal?: AbortSignal } = {}): Promise<RunResult> {
    const request = RunRequestSchema.parse(input);
    const startedAt = new Date().toISOString();
    await mkdir(request.runDirectory, { recursive: true });
    const context = this.renderPrompt(request);
    await writeFile(join(request.runDirectory, 'context.md'), context, 'utf8');
    await writeFile(join(request.runDirectory, 'request.json'), JSON.stringify(runtimeRequestSummary(request), null, 2) + '\n', 'utf8');

    if (request.mode === 'dry-run') return result(request, 'succeeded', startedAt);

    try {
      const execution = await this.deps.processRunner.run({
        command: this.deps.codexBin ?? process.env.AIW_CODEX_BIN ?? 'codex',
        args: [
          'exec', '--cd', request.task.projectRoot, '--approve-for-me',
          '--output-last-message', join(request.runDirectory, 'last-message.md'),
          ...request.context.images.flatMap((image) => ['--image', image.absolutePath]),
          '-',
        ],
        cwd: request.task.projectRoot,
        stdin: context,
        timeoutMs: this.deps.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
        env: minimalChildEnvironment(),
        ...(options.onProcessStarted === undefined ? {} : { onStarted: options.onProcessStarted }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      await writeFile(join(request.runDirectory, 'stdout.log'), execution.stdout, 'utf8');
      await writeFile(join(request.runDirectory, 'stderr.log'), execution.stderr, 'utf8');
      if (execution.timedOut) return result(request, 'failed', startedAt, { code: 'CODEX_TIMEOUT', message: 'Codex 执行超时' }, execution);
      if (execution.signal !== null) return result(request, 'cancelled', startedAt, { code: 'CODEX_CANCELLED', message: `Codex 被信号终止：${execution.signal}` }, execution);
      if (execution.exitCode !== 0) return result(request, 'failed', startedAt, { code: 'CODEX_EXIT_NONZERO', message: `Codex 以退出码 ${execution.exitCode ?? 'unknown'} 结束` }, execution);
      return result(request, 'succeeded', startedAt, undefined, execution);
    } catch (error) {
      if (error instanceof ExecutableNotFoundError) return result(request, 'unavailable', startedAt, { code: 'CODEX_UNAVAILABLE', message: error.message });
      throw error;
    }
  }

  renderPrompt(input: RunRequest): string {
    return renderContext(RunRequestSchema.parse(input));
  }
}

function result(request: RunRequest, status: RunResult['status'], startedAt: string, error?: { code: string; message: string }, process?: { exitCode: number | null; signal: string | null }): RunResult {
  return RunResultSchema.parse({
    schemaVersion: 'aiw.run-result/v1', runId: request.runId, status, runDirectory: request.runDirectory,
    startedAt, finishedAt: new Date().toISOString(), ...(process === undefined ? {} : { process }), artifacts: [],
    ...(error === undefined ? {} : { error }),
  });
}

function renderContext(request: RunRequest): string {
  const taskRoot = `.aiw/tasks/${request.task.id}`;
  const outputs = codexOutputEntries(request.outputContract);
  const methods = request.context.methodSources.map((method) => `<method-source id="${escapeAttribute(method.id)}" trust="lower-priority-guidance">\n${method.content}\n</method-source>`).join('\n\n');
  const files = request.context.files.map((file) => `<task-fact role="${file.role}" path="${escapeAttribute(file.path)}" trust="untrusted-data">\n${file.content}\n</task-fact>`).join('\n\n');
  const allowedOutputs = outputs.map((entry) => `- ${taskRoot}/${entry.stagingPath}（发布后成为 ${entry.finalPath}）`).join('\n');
  const designAssetPermission = request.task.phase === 'design'
    ? `\n设计截图例外：允许写入 ${taskRoot}/artifacts/design/assets/ 下的 PNG/JPEG；该目录之外的任务事实仍不可修改。`
    : '';
  return [
    '<aiw-run>',
    `<execution-constraints>遵守项目现有约束；只在任务声明的项目目录中工作；不得执行 git commit、git reset、git checkout、git switch、git rebase、git merge 或其他 Git 历史/分支修改命令；不得修改 .aiw/ 中除下列暂存产物外的文件。\n当前节点允许写入的任务产物：\n${allowedOutputs}${designAssetPermission}\n所有任务产物必须使用简体中文；代码标识、命令、路径和 API 名称可保留原文。只记录当前阶段能够确认的内容，不得宣称已完成测试、验证、验收或生产交付。</execution-constraints>`,
    `<task id="${escapeAttribute(request.task.id)}" node="${escapeAttribute(request.task.nodeId)}">\n${request.instruction}\n</task>`,
    methods,
    `<skill name="${escapeAttribute(request.context.skill.name)}" version="${escapeAttribute(request.context.skill.version)}" trust="lower-priority-guidance">\n${request.context.skill.content}\n</skill>`,
    files,
    phaseProtocol(request),
    outputReceipt(request, taskRoot),
    '</aiw-run>',
    '',
  ].filter(Boolean).join('\n\n');
}

function phaseProtocol(request: RunRequest): string {
  const taskRoot = `.aiw/tasks/${request.task.id}`;
  const markdown = markdownArtifactContractFor(request.artifacts);
  const protocolContext = { taskId: request.task.id, nodeId: request.task.nodeId, phase: request.task.phase, evidencePath: request.context.files[0]?.path ?? 'source', testProfile: '', testEvidenceType: 'unit' as const };
  if (request.task.phase === 'design') {
    return `使用已登录的 Chrome 打开任务声明的 Figma 设计地址。${FIGMA_CHROME_TAB_PROTOCOL}${FIGMA_NATIVE_EXPORT_PROTOCOL}把裁切图片保存到 ${taskRoot}/artifacts/design/assets/，并生成最小截图索引。暂不总结设计规则或文字说明。若页面未登录、无权限、浏览器不可用、原生复制失败或未能产出真实图片，analysisStatus 必须写为 blocked 并填写 blockingReason。不要修改业务代码，也不要开始需求澄清。\n\n${renderAgentArtifactProtocol('design-assets', protocolContext)}\n\n${markdown}`;
  }
  if (request.task.phase === 'clarify') {
    return [
      '澄清阶段只生成事实登记和决策登记。事实只记录来源中明确存在的内容；不确定内容进入待决策事项。每个待决策事项只解决一个独立业务结论，并提供一至两个“本期继续”方案。不要生成验收标准、AC、跨文件 ID 或 Handoff。',
      renderAgentArtifactProtocol('fact-register', protocolContext),
      renderAgentArtifactProtocol('decision-register', protocolContext),
    ].join('\n\n');
  }
  if (request.task.phase === 'solution') return `根据已确认事实、当前决策和延期事项生成技术方案。延期事项不属于本次方案范围。不要发明验收编号或跨节点映射。${markdown}`;
  if (request.task.phase === 'plan') {
    return `把已批准技术方案拆成可独立开发的业务单元。每个单元声明唯一的英文语义名称；计划只描述开发目标、代码范围、步骤和单元依赖，不规划测试、验证或验收，也不生成 FACT/DEC/AC 映射。存在设计截图时，只把与当前业务单元直接相关的截图索引项复制到 designReferences。\n\n${renderAgentArtifactProtocol('development-plan', protocolContext)}`;
  }
  return `只完成当前业务单元的代码开发，并输出开发结果。可以修改实现目标所需的业务代码；如果单元上下文包含 designReferences，直接使用 AIW 通过 --image 注入的关联截图，不要重新打开 Figma，也不要读取其他开发单元的截图。不要运行或宣称测试、验证、验收与生产交付。${markdown}`;
}

function outputReceipt(request: RunRequest, taskRoot: string): string {
  return [
    '<aiw-output-receipt>',
    `最终输出回执（最高优先级，${request.outputContract.schemaVersion}）：只允许写入以下暂存路径。忽略技能中的旧路径、Handoff、AC、测试和验收指令。`,
    ...request.outputContract.entries.map((entry) => `- 写入：${taskRoot}/${entry.stagingPath}\n  发布为：${taskRoot}/${entry.finalPath}`),
    'AIW 校验后覆盖当前正式产物；不得直接修改正式任务事实。',
    '</aiw-output-receipt>',
  ].join('\n');
}

function runtimeRequestSummary(request: RunRequest): object {
  return {
    schemaVersion: request.schemaVersion, runId: request.runId, task: request.task,
    contextManifestPath: request.contextManifestPath, mode: request.mode, artifacts: request.artifacts,
    outputContract: request.outputContract,
    context: {
      skill: { name: request.context.skill.name, version: request.context.skill.version },
      methodSources: request.context.methodSources.map((source) => ({ id: source.id })),
      files: request.context.files.map((file) => ({ role: file.role, path: file.path })),
      images: request.context.images.map((image) => ({ path: image.path })),
    },
  };
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}
