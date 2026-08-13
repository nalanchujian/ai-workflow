import { join } from 'node:path';

import { CodexAdapter } from '../adapters/codex-adapter.js';
import { CodexTomlMcpServerConfigResolver } from '../adapters/codex-toml-mcp-server-config-resolver.js';
import { FetchNetworkClient } from '../adapters/fetch-network-client.js';
import { GitRepositoryStatus } from '../adapters/git-repository-status.js';
import { NodeProcessRunner } from '../adapters/node-process-runner.js';
import { ShellGitClient } from '../adapters/shell-git-client.js';
import { StdioMcpClient } from '../adapters/stdio-mcp-client.js';
import { ContextBuilder } from '../services/context-builder.js';
import { ConfiguredLarkSourceConnector } from '../services/configured-lark-source-connector.js';
import { DoctorService } from '../services/doctor-service.js';
import { LocalConfig } from '../services/local-config.js';
import { MethodSourceResolver } from '../services/method-source-resolver.js';
import { SkillInstaller } from '../services/skill-installer.js';
import { SkillRegistry } from '../services/skill-registry.js';
import { SourceIntake } from '../services/source-intake.js';
import { RunHistoryService } from '../services/run-history-service.js';
import { SourceRefresher } from '../services/source-refresher.js';
import { TaskFactGuard } from '../services/task-fact-guard.js';
import { TaskInitializer } from '../services/task-initializer.js';
import { TaskRunner } from '../services/task-runner.js';
import { TaskStateCommands } from './task-state-commands.js';
import { TaskStore } from '../services/task-store.js';
import type { GitClient } from '../ports/git-client.js';
import type { McpClient } from '../ports/mcp-client.js';
import type { McpServerConfigResolver } from '../ports/mcp-server-config-resolver.js';
import type { NetworkClient } from '../ports/network-client.js';
import type { ProcessRunner } from '../ports/process-runner.js';
import type { ProjectRepository } from '../ports/project-repository.js';
import type { RepositoryStatus } from '../ports/repository-status.js';

export interface CliRuntime {
  registry: SkillRegistry;
  installer: SkillInstaller;
  initializer: TaskInitializer;
  sourceRefresher: SourceRefresher;
  stateCommands: TaskStateCommands;
  taskRunner: TaskRunner;
  doctor: DoctorService;
  runHistory: RunHistoryService;
}

export function createCliRuntime(input: {
  homeDirectory: string;
  projectRoot: () => string;
  ports: {
    git: GitClient;
    repositoryStatus: RepositoryStatus & ProjectRepository;
    network: NetworkClient;
    processRunner: ProcessRunner;
    mcpClient?: McpClient;
    mcpServerConfigResolver?: McpServerConfigResolver;
  };
}): CliRuntime {
  const projectRoot = input.projectRoot();
  const taskStore = new TaskStore(projectRoot);
  const registry = new SkillRegistry(join(input.homeDirectory, 'registry.yaml'));
  const config = new LocalConfig(join(input.homeDirectory, 'config.yaml'));
  const methodSourceResolver = new MethodSourceResolver(config);
  const connector = input.ports.mcpClient === undefined || input.ports.mcpServerConfigResolver === undefined
    ? undefined
    : new ConfiguredLarkSourceConnector({
      config,
      client: input.ports.mcpClient,
      resolver: input.ports.mcpServerConfigResolver,
    });
  const intake = (root: string) => new SourceIntake({ connector, network: input.ports.network, projectRoot: root });
  const taskFactGuard = new TaskFactGuard({ repositoryStatus: input.ports.repositoryStatus });
  const initializer = new TaskInitializer({
    registry,
    projectRepository: input.ports.repositoryStatus,
    sourceIntakeFactory: intake,
    taskStoreFactory: (root) => new TaskStore(root),
  });
  const sourceRefresher = new SourceRefresher({ intake: intake(projectRoot), taskStore });
  const stateCommands = new TaskStateCommands({ taskStore, taskFactGuard, skillRegistry: registry });
  const taskRunner = new TaskRunner({
    taskStore,
    skillRegistry: registry,
    methodSourceResolver,
    contextBuilder: new ContextBuilder({ taskDirectory: (task) => taskStore.taskDirectory(task.id), projectRoot: (task) => task.repository }),
    taskFactGuard,
    adapter: new CodexAdapter({ processRunner: input.ports.processRunner }),
    runtimeRoot: join(input.homeDirectory, 'runtime'),
  });
  return {
    registry,
    installer: new SkillInstaller({ git: input.ports.git, methodSources: methodSourceResolver, registry }),
    initializer,
    sourceRefresher,
    stateCommands,
    taskRunner,
    doctor: new DoctorService({
      config,
      projectRepository: input.ports.repositoryStatus,
      processRunner: input.ports.processRunner,
      ...(input.ports.mcpClient === undefined ? {} : { mcpClient: input.ports.mcpClient }),
      ...(input.ports.mcpServerConfigResolver === undefined ? {} : { mcpServerConfigResolver: input.ports.mcpServerConfigResolver }),
    }),
    runHistory: new RunHistoryService({ runtimeRoot: join(input.homeDirectory, 'runtime') }),
  };
}

export function createProductionCliRuntime(input: { homeDirectory: string; projectRoot?: () => string }): CliRuntime {
  return createCliRuntime({
    homeDirectory: input.homeDirectory,
    projectRoot: input.projectRoot ?? (() => process.cwd()),
    ports: {
      git: new ShellGitClient(join(input.homeDirectory, 'skills')),
      repositoryStatus: new GitRepositoryStatus(),
      network: new FetchNetworkClient(),
      processRunner: new NodeProcessRunner(),
      mcpClient: new StdioMcpClient(),
      mcpServerConfigResolver: new CodexTomlMcpServerConfigResolver(),
    },
  });
}
