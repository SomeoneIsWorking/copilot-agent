import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { AgentLoop } from '../src/AgentLoop';

type FakeChunk = {
  text?: string;
  toolCalls?: Array<{ name: string; input: Record<string, unknown> }>;
};

class FakeModel {
  constructor(
    public readonly id: string,
    private readonly turns: FakeChunk[][],
  ) {}

  private turnIndex = 0;

  async sendRequest(): Promise<any> {
    const chunks = this.turns[Math.min(this.turnIndex, this.turns.length - 1)] ?? [];
    this.turnIndex += 1;

    return {
      stream: (async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      })(),
      tokenUsage: {
        totalTokens: 50,
        limit: 128000,
      },
    };
  }
}

class FakeHistoryTreeManager {
  private checkpointCount = 0;

  async initialize(): Promise<void> {}

  async createCheckpoint(): Promise<any> {
    this.checkpointCount += 1;
    return {
      id: `cp-${this.checkpointCount}`,
      messageId: `msg-cp-${this.checkpointCount}`,
      gitHash: `hash-${this.checkpointCount}`,
    };
  }

  addNode(input: any): any {
    this.checkpointCount += 1;
    return {
      id: `node-${this.checkpointCount}`,
      messageId: input.messageId,
      gitHash: input.gitHash,
    };
  }

  jumpToNode(): any[] {
    return [];
  }

  async rollbackToGitHash(): Promise<void> {}

  truncateMessagesForNode(_nodeId: string, messages: any[]): any[] {
    return messages;
  }
}

class FakeProcessKiller {
  private source = new vscode.CancellationTokenSource();

  get token(): any {
    return this.source.token;
  }

  registerPgid(): void {}
  unregisterPgid(): void {}
  async hardStop(): Promise<void> {}
}

describe('AgentLoop tool calling', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-loop-test-'));
    await fs.writeFile(path.join(workspaceDir, 'file-a.ts'), 'export const a = 1;\n', 'utf8');
    await fs.mkdir(path.join(workspaceDir, 'src'));
    await fs.writeFile(path.join(workspaceDir, 'src', 'file-b.ts'), 'export const b = 2;\n', 'utf8');
  });

  it('calls tools for project inspection prompt (raptor-mini-free)', async () => {
    const fakeModel = new FakeModel('raptor-mini-free', [
      [
        {
          text: 'Preparing repository inspection',
          toolCalls: [
            {
              name: 'read_directory',
              input: { path: '.', depth: 2 },
            },
          ],
        },
      ],
      [
        {
          text: 'I inspected the repository structure and found key files.',
        },
      ],
    ]);

    const selectChatModels = vi.fn(async () => [fakeModel]);
    (vscode.lm as any).selectChatModels = selectChatModels;
    (vscode.lm as any).tools = {
      registerTool: vi.fn(),
    };

    const history = new FakeHistoryTreeManager();
    const processKiller = new FakeProcessKiller();
    const extensionUri = vscode.Uri.file(process.cwd());
    const agentLoop = new AgentLoop(
      workspaceDir,
      [workspaceDir],
      extensionUri as any,
      history as any,
      processKiller as any,
    );

    await agentLoop.configureModels('raptor-mini-free', 'raptor-mini-free');
    await agentLoop.initialize();

    const result = await agentLoop.runTurn('test-session', 'read the project files and give your opinion');

    const messages = agentLoop.getSessionMessages('test-session');
    const toolMessages = messages.filter((msg) => msg.role === 'tool' && msg.name === 'read_directory');

    expect(selectChatModels).toHaveBeenCalled();
    expect(toolMessages.length).toBeGreaterThan(0);
    expect(result.outputText).toContain('inspected the repository');
  });
});
