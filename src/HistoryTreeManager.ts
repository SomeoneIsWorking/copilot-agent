import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import type { ChatMessage, CheckpointMetadata, HistoryNode, PersistedHistoryState, TokenUsage } from './types';

const execFileAsync = promisify(execFile);

export class HistoryTreeManager implements vscode.TreeDataProvider<HistoryNode> {
  private readonly nodes = new Map<string, HistoryNode>();
  private readonly roots: string[] = [];
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<HistoryNode | undefined>();
  private readonly shadowRef = 'refs/heads/agent-shadow';
  private headId: string | undefined;

  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(private readonly repositoryPath: string) {}

  async initialize(): Promise<void> {
    await this.ensureRepository();
    await this.ensureShadowBranchExists();
  }

  async createCheckpoint(metadata: CheckpointMetadata, parentId?: string): Promise<HistoryNode> {
    const hash = await this.captureSnapshotToShadowRef(metadata.reason);
    const node = this.addNode({
      messageId: randomUUID(),
      gitHash: hash,
      parentId: parentId ?? this.headId,
      tokenUsage: { used: 0, limit: 1 },
      actionKind: 'checkpoint',
      actionLabel: metadata.actionLabel,
    });
    return node;
  }

  addNode(input: {
    messageId: string;
    gitHash: string;
    parentId?: string;
    tokenUsage: TokenUsage;
    actionKind: HistoryNode['actionKind'];
    actionLabel: string;
  }): HistoryNode {
    const id = randomUUID();
    const node: HistoryNode = {
      id,
      messageId: input.messageId,
      gitHash: input.gitHash,
      parentId: input.parentId,
      childrenIds: [],
      tokenUsage: input.tokenUsage,
      actionKind: input.actionKind,
      actionLabel: input.actionLabel,
      timestamp: Date.now(),
    };

    this.nodes.set(node.id, node);
    if (node.parentId) {
      const parent = this.nodes.get(node.parentId);
      if (!parent) {
        throw new Error(`Unknown parent node: ${node.parentId}`);
      }
      parent.childrenIds.push(node.id);
    } else {
      this.roots.push(node.id);
    }

    this.headId = node.id;
    this.onDidChangeTreeDataEmitter.fire(undefined);
    return node;
  }

  getCurrentNode(): HistoryNode | undefined {
    return this.headId ? this.nodes.get(this.headId) : undefined;
  }

  getNode(nodeId: string): HistoryNode | undefined {
    return this.nodes.get(nodeId);
  }

  getLineage(nodeId: string): HistoryNode[] {
    const lineage: HistoryNode[] = [];
    let cursor = this.nodes.get(nodeId);
    while (cursor) {
      lineage.unshift(cursor);
      cursor = cursor.parentId ? this.nodes.get(cursor.parentId) : undefined;
    }
    return lineage;
  }

  jumpToNode(nodeId: string): HistoryNode[] {
    if (!this.nodes.has(nodeId)) {
      throw new Error(`Unknown node: ${nodeId}`);
    }
    this.headId = nodeId;
    this.onDidChangeTreeDataEmitter.fire(undefined);
    return this.getLineage(nodeId);
  }

  truncateMessagesForNode(nodeId: string, messages: ChatMessage[]): ChatMessage[] {
    const allowedMessageIds = new Set(this.getLineage(nodeId).map((node) => node.messageId));
    return messages.filter((message) => allowedMessageIds.has(message.messageId));
  }

  async rollbackToGitHash(gitHash: string): Promise<void> {
    await this.runGit(['reset', '--hard', gitHash]);
    await this.runGit(['clean', '-fd']);
  }

  getTreeItem(element: HistoryNode): vscode.TreeItem {
    const fullness = element.tokenUsage.limit <= 0
      ? 0
      : Math.max(0, Math.min(1, element.tokenUsage.used / element.tokenUsage.limit));

    const barSize = 12;
    const filled = Math.round(fullness * barSize);
    const bar = `${'█'.repeat(filled)}${'░'.repeat(barSize - filled)}`;

    const item = new vscode.TreeItem(
      `${element.actionLabel}`,
      element.childrenIds.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    item.description = `${element.actionKind} ${bar}`;
    item.tooltip = `Node: ${element.id}\nMessageID: ${element.messageId}\nGit: ${element.gitHash}\nTokens: ${element.tokenUsage.used}/${element.tokenUsage.limit}`;
    item.contextValue = 'timelineNode';
    item.command = {
      command: 'branchingTimeline.rewindToNode',
      title: 'Rewind to Node',
      arguments: [element],
    };
    return item;
  }

  getChildren(element?: HistoryNode): Thenable<HistoryNode[]> {
    if (!element) {
      return Promise.resolve(this.roots.map((id) => this.nodes.get(id)).filter((v): v is HistoryNode => !!v));
    }
    return Promise.resolve(element.childrenIds.map((id) => this.nodes.get(id)).filter((v): v is HistoryNode => !!v));
  }

  exportState(): PersistedHistoryState {
    return {
      nodes: Array.from(this.nodes.values()).map((node) => ({
        ...node,
        childrenIds: [...node.childrenIds],
        tokenUsage: { ...node.tokenUsage },
      })),
      roots: [...this.roots],
      headId: this.headId,
    };
  }

  importState(state: PersistedHistoryState): void {
    this.nodes.clear();
    this.roots.splice(0, this.roots.length);

    for (const node of state.nodes) {
      this.nodes.set(node.id, {
        ...node,
        childrenIds: [...node.childrenIds],
        tokenUsage: { ...node.tokenUsage },
      });
    }

    for (const rootId of state.roots) {
      if (this.nodes.has(rootId)) {
        this.roots.push(rootId);
      }
    }

    if (state.headId && this.nodes.has(state.headId)) {
      this.headId = state.headId;
    } else {
      this.headId = this.roots.length > 0 ? this.roots[this.roots.length - 1] : undefined;
    }

    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  private async ensureRepository(): Promise<void> {
    await this.runGit(['rev-parse', '--is-inside-work-tree']);
  }

  private async ensureShadowBranchExists(): Promise<void> {
    try {
      await this.runGit(['show-ref', '--verify', '--quiet', this.shadowRef]);
    } catch {
      const head = (await this.runGit(['rev-parse', 'HEAD'])).trim();
      await this.runGit(['update-ref', this.shadowRef, head]);
    }
  }

  private async captureSnapshotToShadowRef(reason: string): Promise<string> {
    const parentHash = (await this.runGit(['rev-parse', this.shadowRef])).trim();
    const indexFile = path.join(os.tmpdir(), `agent-shadow-index-${randomUUID()}`);
    const liveIndex = path.join(this.repositoryPath, '.git', 'index');

    try {
      try {
        await fs.copyFile(liveIndex, indexFile);
      } catch {
        await fs.writeFile(indexFile, '');
      }

      const env = {
        ...process.env,
        GIT_INDEX_FILE: indexFile,
      };

      await this.runGit(['add', '-A'], env);
      const treeHash = (await this.runGit(['write-tree'], env)).trim();
      const commitHash = (await this.runGit(
        ['commit-tree', treeHash, '-p', parentHash, '-m', `agent-shadow checkpoint: ${reason}`],
        env,
      )).trim();

      await this.runGit(['update-ref', this.shadowRef, commitHash]);
      return commitHash;
    } finally {
      await fs.rm(indexFile, { force: true });
    }
  }

  private async runGit(args: string[], envOverride?: NodeJS.ProcessEnv): Promise<string> {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: this.repositoryPath,
      env: envOverride ?? process.env,
      maxBuffer: 1024 * 1024 * 16,
    });
    if (stderr?.trim().length) {
      return stdout.toString();
    }
    return stdout.toString();
  }
}
