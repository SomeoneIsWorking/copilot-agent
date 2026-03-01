import * as vscode from 'vscode';
import { AgentLoop } from './AgentLoop';
import { AGENT_VIEW_ID, AgentSidebarViewProvider } from './AgentSidebarView';
import { FAST_MODEL_SETTING, SMART_MODEL_SETTING, getModelPreferences } from './config';
import { registerCommands } from './commands';
import { HistoryTreeManager } from './HistoryTreeManager';
import { ProcessKiller } from './ProcessKiller';
import type { PersistedAgentLoopState, PersistedHistoryState } from './types';

let agentLoop: AgentLoop | undefined;
const HISTORY_STATE_KEY = 'branchingTimeline.historyState.v1';
const AGENT_STATE_KEY = 'branchingTimeline.agentState.v1';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return;
  }

  const workspacePath = workspaceFolder.uri.fsPath;
  if (context.extensionMode === vscode.ExtensionMode.Development) {
    setupDevAutoReload(context, workspaceFolder);
  }

  const historyTreeManager = new HistoryTreeManager(workspacePath);
  const cancellationSource = new vscode.CancellationTokenSource();
  const processKiller = new ProcessKiller(cancellationSource);
  agentLoop = new AgentLoop(workspacePath, context.extensionUri, historyTreeManager, processKiller);
  const configured = getModelPreferences();
  await agentLoop.configureModels(configured.smart, configured.fast);
  await agentLoop.initialize();

  const persistedHistoryState = context.workspaceState.get<PersistedHistoryState>(HISTORY_STATE_KEY);
  if (persistedHistoryState) {
    historyTreeManager.importState(persistedHistoryState);
  }

  const persistedAgentState = context.workspaceState.get<PersistedAgentLoopState>(AGENT_STATE_KEY);
  if (persistedAgentState) {
    agentLoop.importState(persistedAgentState);
  }

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('branchingTimeline.timelineView', historyTreeManager),
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      AGENT_VIEW_ID,
      new AgentSidebarViewProvider(agentLoop, context.extensionUri),
    ),
  );
  registerCommands(context, agentLoop);

  context.subscriptions.push(
    historyTreeManager.onDidChangeTreeData(() => {
      void context.workspaceState.update(HISTORY_STATE_KEY, historyTreeManager.exportState());
    }),
  );
  context.subscriptions.push(
    agentLoop.onDidSessionChange(() => {
      if (!agentLoop) {
        return;
      }
      void context.workspaceState.update(AGENT_STATE_KEY, agentLoop.exportState());
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!agentLoop) {
        return;
      }

      if (!event.affectsConfiguration(SMART_MODEL_SETTING) && !event.affectsConfiguration(FAST_MODEL_SETTING)) {
        return;
      }

      const refreshed = getModelPreferences();
      await agentLoop.configureModels(refreshed.smart, refreshed.fast);
    }),
  );
}

function setupDevAutoReload(context: vscode.ExtensionContext, workspaceFolder: vscode.WorkspaceFolder): void {
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceFolder, 'out/**/*.js'),
  );

  let reloadTimer: NodeJS.Timeout | undefined;
  const scheduleReload = () => {
    if (reloadTimer) {
      clearTimeout(reloadTimer);
    }
    reloadTimer = setTimeout(() => {
      void vscode.commands.executeCommand('workbench.action.reloadWindow');
    }, 250);
  };

  watcher.onDidChange(scheduleReload, null, context.subscriptions);
  watcher.onDidCreate(scheduleReload, null, context.subscriptions);
  watcher.onDidDelete(scheduleReload, null, context.subscriptions);

  context.subscriptions.push(
    watcher,
    {
      dispose: () => {
        if (reloadTimer) {
          clearTimeout(reloadTimer);
        }
      },
    },
  );
}

export function deactivate(): void {
  agentLoop = undefined;
}
