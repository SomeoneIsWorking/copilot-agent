import * as vscode from 'vscode';
import { AgentLoop } from './AgentLoop';
import { SIDEBAR_SESSION_ID } from './config';
import type { HistoryNode } from './types';

export function registerCommands(context: vscode.ExtensionContext, agentLoop: AgentLoop): void {
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
}
