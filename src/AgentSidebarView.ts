import * as vscode from 'vscode';
import { AgentLoop } from './AgentLoop';
import {
  SIDEBAR_SESSION_ID,
  getModelPreferences,
  setModelPreferences,
} from './config';

const VIEW_ID = 'branchingTimeline.agentView';

export class AgentSidebarViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private readonly sessionId = SIDEBAR_SESSION_ID;
  private sessionEventsBound = false;

  constructor(
    private readonly agentLoop: AgentLoop,
    private readonly extensionUri: vscode.Uri,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };
    void this.setHtml(webviewView.webview);
    this.ensureSessionSyncBinding();

    webviewView.webview.onDidReceiveMessage(async (event) => {
      if (event?.type === 'runPrompt') {
        const prompt = String(event.prompt ?? '').trim();
        if (!prompt) {
          return;
        }

        this.postMessage({ type: 'state', state: 'thinking' });
        try {
          const result = await this.agentLoop.runTurn(this.sessionId, prompt);
          this.postMessage({ type: 'assistantMessage', content: result.outputText });
        } catch (error) {
          this.postMessage({
            type: 'assistantMessage',
            content: `Error: ${error instanceof Error ? error.message : String(error)}`,
          });
        } finally {
          this.postMessage({ type: 'state', state: 'idle' });
        }
      }

      if (event?.type === 'hardStop') {
        await this.agentLoop.hardStop();
        this.postMessage({ type: 'state', state: 'idle' });
      }

      if (event?.type === 'saveModels') {
        const smart = String(event.smartModel ?? '').trim();
        const fast = String(event.fastModel ?? '').trim();
        if (!smart || !fast) {
          this.postMessage({
            type: 'assistantMessage',
            content: 'Both Smart Model and Fast Model are required.',
          });
          return;
        }

        await setModelPreferences({ smart, fast });
        await this.agentLoop.configureModels(smart, fast);
        this.postMessage({
          type: 'assistantMessage',
          content: `Model preferences updated. Smart=${smart}, Fast=${fast}`,
        });
      }
    });

    void this.postInitialModelData();
    this.postMessage({
      type: 'replaceMessages',
      messages: this.agentLoop.getSessionMessages(this.sessionId),
    });
    this.postMessage({ type: 'state', state: 'idle' });
  }

  private postMessage(message: unknown): void {
    this.view?.webview.postMessage(message);
  }

  private async postInitialModelData(): Promise<void> {
    const modelPrefs = getModelPreferences();
    const models = await this.agentLoop.listAvailableModels();
    this.postMessage({
      type: 'modelOptions',
      options: models,
    });
    this.postMessage({
      type: 'modelPrefs',
      smartModel: modelPrefs.smart,
      fastModel: modelPrefs.fast,
    });
  }

  private async setHtml(webview: vscode.Webview): Promise<void> {
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const templateUri = vscode.Uri.joinPath(this.extensionUri, 'media', 'agent-sidebar.html');
    const rawTemplate = await vscode.workspace.fs.readFile(templateUri);
    const template = Buffer.from(rawTemplate).toString('utf8');

    const html = template
      .replaceAll('__CSP_SOURCE__', webview.cspSource)
      .replaceAll('__NONCE__', nonce);

    webview.html = html;
  }

  private ensureSessionSyncBinding(): void {
    if (this.sessionEventsBound) {
      return;
    }
    this.sessionEventsBound = true;

    this.agentLoop.onDidSessionChange((event) => {
      if (event.sessionId !== this.sessionId) {
        return;
      }
      this.postMessage({
        type: 'replaceMessages',
        messages: event.messages,
      });
    });
  }
}

export const AGENT_VIEW_ID = VIEW_ID;
