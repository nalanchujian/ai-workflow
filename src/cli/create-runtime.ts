import { join } from 'node:path';

import { CodexAdapter } from '../adapters/codex-adapter.js';
import { CodexTomlMcpServerConfigResolver } from '../adapters/codex-toml-mcp-server-config-resolver.js';
import { FetchNetworkClient } from '../adapters/fetch-network-client.js';
import { GitRepositoryStatus } from '../adapters/git-repository-status.js';
import { GitDeliveryWorkspaceManager } from '../adapters/git-delivery-workspace.js';
import { NodeProcessRunner } from '../adapters/node-process-runner.js';
import { ShellGitClient } from '../adapters/shell-git-client.js';
import { StdioMcpClient } from '../adapters/stdio-mcp-client.js';
import { ContextBuilder } from '../services/context-builder.js';
import { ConfiguredLarkSourceConnector } from '../services/configured-lark-source-connector.js';
import { ConfiguredFigmaDesignConnector } from '../services/configured-figma-design-connector.js';
import { DesignAnalysisInputPreparer } from '../services/design-analysis-input-preparer.js';
import { DoctorService } from '../services/doctor-service.js';
import { DefaultWorkflowBootstrapper } from '../services/default-workflow-bootstrapper.js';
import { LocalConfig } from '../services/local-config.js';
import { LocalInitializer } from '../services/local-initializer.js';
import { LarkConnectorAutoDiscovery } from '../services/lark-connector-auto-discovery.js';
import { MethodSourceResolver } from '../services/method-source-resolver.js';
import { SkillInstaller } from '../services/skill-installer.js';
import { SkillRegistry } from '../services/skill-registry.js';
import { SourceIntake } from '../services/source-intake.js';
import { RunHistoryService } from '../services/run-history-service.js';
import { SourceRefresher } from '../services/source-refresher.js';
import { TaskFactGuard } from '../services/task-fact-guard.js';
import { TaskInitializer } from '../services/task-initializer.js';
import { TaskRunner } from '../services/task-runner.js';
import { TaskCancellationService } from '../services/task-cancellation-service.js';
import { TaskDecisionService } from '../services/task-decision-service.js';
import { TaskStateCommands } from './task-state-commands.js';
import { TaskStore } from '../services/task-store.js';
import { FileTaskRunLock } from '../services/task-run-lock.js';
import type { GitClient } from '../ports/git-client.js';
import type { McpClient } from '../ports/mcp-client.js';
import type { McpServerCatalog } from '../ports/mcp-server-catalog.js';
import type { McpServerConfigResolver } from '../ports/mcp-server-config-resolver.js';
import type { NetworkClient } from '../ports/network-client.js';
import type { ProcessRunner } from '../ports/process-runner.js';
import type { ProjectRepository } from '../ports/project-repository.js';
import type { RepositoryStatus, WorkingTreeStatus } from '../ports/repository-status.js';
import type { DeliveryWorkspaceManager } from '../ports/delivery-workspace.js';

export interface CliRuntime {
  registry: SkillRegistry;
  installer: SkillInstaller;
  initializer: TaskInitializer;
  sourceRefresher: SourceRefresher;
  stateCommands: TaskStateCommands;
  taskRunner: TaskRunner;
  taskCancellation: TaskCancellationService;
  doctor: DoctorService;
  runHistory: RunHistoryService;
  localConfig: LocalConfig;
  localInitializer: LocalInitializer;
  defaultWorkflowBootstrapper: DefaultWorkflowBootstrapper;
}

export function createCliRuntime(input: {
  homeDirectory: string;
  projectRoot: () => string;
  taskCreatedAt?: () => Date;
  ports: {
    git: GitClient;
    repositoryStatus: RepositoryStatus & ProjectRepository & WorkingTreeStatus;
    network: NetworkClient;
    processRunner: ProcessRunner;
    mcpClient?: McpClient;
    mcpServerConfigResolver?: McpServerConfigResolver;
    mcpServerCatalog?: McpServerCatalog;
    deliveryWorkspaceManager?: DeliveryWorkspaceManager;
  };
}): CliRuntime {
  const projectRoot = input.projectRoot();
  const taskStore = new TaskStore(projectRoot);
  const runtimeRoot = join(input.homeDirectory, 'runtime');
  const taskLock = new FileTaskRunLock(runtimeRoot);
  const registry = new SkillRegistry(join(input.homeDirectory, 'registry.yaml'));
  const config = new LocalConfig(join(input.homeDirectory, 'config.yaml'));
  const methodSourceResolver = new MethodSourceResolver(registry);
  const connector = input.ports.mcpClient === undefined || input.ports.mcpServerConfigResolver === undefined
    ? undefined
    : new ConfiguredLarkSourceConnector({
      config,
      client: input.ports.mcpClient,
      resolver: input.ports.mcpServerConfigResolver,
    });
  const designConnector = input.ports.mcpClient === undefined || input.ports.mcpServerConfigResolver === undefined
    ? undefined
    : new ConfiguredFigmaDesignConnector({
      config,
      client: input.ports.mcpClient,
      resolver: input.ports.mcpServerConfigResolver,
    });
  const intake = (root: string) => new SourceIntake({ ...(connector === undefined ? {} : { connectors: [connector] }), network: input.ports.network, projectRoot: root });
  const taskFactGuard = new TaskFactGuard({ repositoryStatus: input.ports.repositoryStatus });
  const initializer = new TaskInitializer({
    registry,
    projectRepository: input.ports.repositoryStatus,
    sourceIntakeFactory: intake,
    taskStoreFactory: (root) => new TaskStore(root),
    ...(input.taskCreatedAt === undefined ? {} : { now: input.taskCreatedAt }),
  });
  const installer = new SkillInstaller({ git: input.ports.git, registry });
  const localInitializer = new LocalInitializer(join(input.homeDirectory, 'config.yaml'));
  const defaultWorkflowBootstrapper = new DefaultWorkflowBootstrapper({
    initializer: localInitializer,
    config,
    installer,
    registry,
    ...(input.ports.mcpClient === undefined || input.ports.mcpServerCatalog === undefined ? {} : {
      larkDiscovery: new LarkConnectorAutoDiscovery({
        config,
        catalog: input.ports.mcpServerCatalog,
        client: input.ports.mcpClient,
      }),
    }),
  });
  const sourceRefresher = new SourceRefresher({ intake: intake(projectRoot), taskStore, taskLock });
  const taskCancellation = new TaskCancellationService({ taskStore, runtimeRoot });
  const codexAdapter = new CodexAdapter({ processRunner: input.ports.processRunner });
  const stateCommands = new TaskStateCommands({ taskStore, taskFactGuard, taskLock, cancellation: taskCancellation, decisionService: new TaskDecisionService({ taskStore }) });
  const taskRunner = new TaskRunner({
    taskStore,
    skillRegistry: registry,
    methodSourceResolver,
    contextBuilder: new ContextBuilder({
      taskDirectory: (task) => taskStore.taskDirectory(task.id),
      projectRoot: () => taskStore.projectDirectory(),
      maxTokens: () => config.contextTokenBudget(),
    }),
    taskFactGuard,
    changeInspector: input.ports.repositoryStatus,
    adapter: codexAdapter,
    ...(input.ports.deliveryWorkspaceManager === undefined ? {} : { deliveryWorkspaceManager: input.ports.deliveryWorkspaceManager }),
    ...(designConnector === undefined ? {} : { designInputPreparer: new DesignAnalysisInputPreparer({ taskStore, connector: designConnector }) }),
    runtimeRoot,
    runLock: taskLock,
  });
  return {
    registry,
    installer,
    initializer,
    sourceRefresher,
    stateCommands,
    taskRunner,
    taskCancellation,
    doctor: new DoctorService({
      config,
      registry,
      projectRepository: input.ports.repositoryStatus,
      processRunner: input.ports.processRunner,
      ...(input.ports.mcpClient === undefined ? {} : { mcpClient: input.ports.mcpClient }),
      ...(input.ports.mcpServerConfigResolver === undefined ? {} : { mcpServerConfigResolver: input.ports.mcpServerConfigResolver }),
    }),
    runHistory: new RunHistoryService({ runtimeRoot }),
    localConfig: config,
    localInitializer,
    defaultWorkflowBootstrapper,
  };
}

export function createProductionCliRuntime(input: { homeDirectory: string; projectRoot?: () => string }): CliRuntime {
  const mcpServerConfig = new CodexTomlMcpServerConfigResolver();
  return createCliRuntime({
    homeDirectory: input.homeDirectory,
    projectRoot: input.projectRoot ?? (() => process.cwd()),
    ports: {
      git: new ShellGitClient(join(input.homeDirectory, 'skills')),
      repositoryStatus: new GitRepositoryStatus(),
      network: new FetchNetworkClient(),
      processRunner: new NodeProcessRunner(),
      mcpClient: new StdioMcpClient(),
      mcpServerConfigResolver: mcpServerConfig,
      mcpServerCatalog: mcpServerConfig,
      deliveryWorkspaceManager: new GitDeliveryWorkspaceManager(),
    },
  });
}
