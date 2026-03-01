import * as vscode from 'vscode';
import { AgentLoop } from './AgentLoop';
import { SIDEBAR_SESSION_ID } from './config';
import type { HistoryNode } from './types';
import { HistoryTreeManager } from './HistoryTreeManager';

type SessionItem = {
  kind: 'session';
  sessionId: string;
  label: string;
};

export function registerCommands(
  context: vscode.ExtensionContext,
  agentLoop: AgentLoop,
  historyTreeManager: HistoryTreeManager,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('branchingTimeline.hardStop', async () => {
      await agentLoop.hardStop();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('branchingTimeline.rewindToNode', async (node?: HistoryNode) => {
      let nodeId = node?.id;
      if (!nodeId) {
        nodeId = await vscode.window.showInputBox({
          prompt: 'Enter timeline node ID to rewind to',
        });
      }

      if (!nodeId) {
        return;
      }

      await agentLoop.rewindToNode(SIDEBAR_SESSION_ID, nodeId);
      vscode.window.showInformationMessage(`Rewound to node: ${nodeId}`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('branchingTimeline.deleteCheckpoint', async (node?: HistoryNode) => {
      if (!node?.id) {
        return;
      }

      const confirmation = await vscode.window.showWarningMessage(
        'Delete this checkpoint and all descendant nodes?',
        { modal: true },
        'Delete',
      );
      if (confirmation !== 'Delete') {
        return;
      }

      const deletedNodeIds = historyTreeManager.deleteNodeSubtree(node.id);
      agentLoop.pruneNodeSnapshots(deletedNodeIds);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('branchingTimeline.renameSession', async (item?: SessionItem) => {
      if (!item?.sessionId) {
        return;
      }

      const currentLabel = item.label.replace(/\s*\(active\)\s*$/, '');
      const nextLabel = await vscode.window.showInputBox({
        prompt: 'Rename session',
        value: currentLabel,
      });
      const trimmed = nextLabel?.trim();
      if (!trimmed) {
        return;
      }

      const renamed = agentLoop.renameSession(item.sessionId, trimmed);
      if (!renamed) {
        return;
      }

      historyTreeManager.setSessionMetadata(agentLoop.listSessions());
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('branchingTimeline.deleteSession', async (item?: SessionItem) => {
      if (!item?.sessionId) {
        return;
      }

      const confirmation = await vscode.window.showWarningMessage(
        'Delete this session and all its timeline nodes?',
        { modal: true },
        'Delete',
      );
      if (confirmation !== 'Delete') {
        return;
      }

      agentLoop.deleteSession(item.sessionId);
      historyTreeManager.deleteSession(item.sessionId);
      historyTreeManager.setSessionMetadata(agentLoop.listSessions());
    }),
  );
}
