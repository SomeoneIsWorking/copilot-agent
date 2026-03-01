import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import type { AgentSession, ChatMessage, CheckpointMetadata, HistoryNode, PersistedHistoryState, TokenUsage } from './types';

const execFileAsync = promisify(execFile);

type SessionTreeItem = {
  kind: 'session';
  sessionId: string;
  label: string;
};

type HistoryTreeItem = HistoryNode | SessionTreeItem;

export class HistoryTreeManager implements vscode.TreeDataProvider<HistoryTreeItem> {
  private readonly nodes = new Map<string, HistoryNode>();
  private readonly roots: string[] = [];
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<HistoryTreeItem | undefined>();
  private readonly shadowRef = 'refs/heads/agent-shadow';
  private readonly headBySession = new Map<string, string>();
  private readonly sessionLabels = new Map<string, string>();
  private activeSessionId = 'default';

  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(private readonly repositoryPath: string) {}

  async initialize(): Promise<void> {
    await this.ensureRepository();
    await this.ensureShadowBranchExists();
  }

  setActiveSession(sessionId: string): void {
    this.activeSessionId = sessionId;
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  setSessionMetadata(sessions: AgentSession[]): void {
    this.sessionLabels.clear();
    for (const session of sessions) {
      this.sessionLabels.set(session.id, session.label);
    }
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  deleteSession(sessionId: string): void {
    const toDelete = Array.from(this.nodes.values())
      .filter((node) => node.sessionId === sessionId)
      .map((node) => node.id);

    const deleteSet = new Set(toDelete);
    for (const node of this.nodes.values()) {
      node.childrenIds = node.childrenIds.filter((id) => !deleteSet.has(id));
    }
    for (const nodeId of toDelete) {
      this.nodes.delete(nodeId);
    }

    const remainingRoots = this.roots.filter((rootId) => {
      const node = this.nodes.get(rootId);
      return !!node && node.sessionId !== sessionId;
    });
    this.roots.splice(0, this.roots.length, ...remainingRoots);

    this.headBySession.delete(sessionId);
    this.sessionLabels.delete(sessionId);
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = this.headBySession.keys().next().value as string ?? 'default';
    }
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  deleteNodeSubtree(nodeId: string): string[] {
    const rootNode = this.nodes.get(nodeId);
    if (!rootNode) {
      return [];
    }

    const toDelete: string[] = [];
    const walk = (id: string) => {
      const node = this.nodes.get(id);
      if (!node) {
        return;
      }
      toDelete.push(id);
      for (const childId of node.childrenIds) {
        walk(childId);
      }
    };
    walk(nodeId);

    const deleteSet = new Set(toDelete);
    for (const node of this.nodes.values()) {
      node.childrenIds = node.childrenIds.filter((childId) => !deleteSet.has(childId));
    }

    const rootIndex = this.roots.indexOf(nodeId);
    if (rootIndex >= 0) {
      this.roots.splice(rootIndex, 1);
    }

    for (const id of toDelete) {
      this.nodes.delete(id);
    }

    this.recomputeSessionHeads(rootNode.sessionId);
    if (!this.headBySession.has(this.activeSessionId)) {
      this.activeSessionId = this.headBySession.keys().next().value as string ?? 'default';
    }

    this.onDidChangeTreeDataEmitter.fire(undefined);
    return toDelete;
  }

  async createCheckpoint(metadata: CheckpointMetadata, parentId?: string, sessionId = this.activeSessionId): Promise<HistoryNode> {
    const parent = parentId ?? this.headBySession.get(sessionId);
    const hash = await this.captureSnapshotToShadowRef(metadata.reason);
    const node = this.addNode({
      sessionId,
      messageId: randomUUID(),
      gitHash: hash,
      parentId: parent,
      tokenUsage: { used: 0, limit: 1 },
      actionKind: 'checkpoint',
      actionLabel: metadata.actionLabel,
    });
    return node;
  }

  addNode(input: {
    sessionId?: string;
    messageId: string;
    gitHash: string;
    parentId?: string;
    tokenUsage: TokenUsage;
    actionKind: HistoryNode['actionKind'];
    actionLabel: string;
  }): HistoryNode {
    const id = randomUUID();
    const sessionId = input.sessionId ?? this.activeSessionId;
    const node: HistoryNode = {
      id,
      sessionId,
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
      if (parent.sessionId !== sessionId) {
        throw new Error(`Cross-session parent linkage is not allowed: ${parent.sessionId} -> ${sessionId}`);
      }
      parent.childrenIds.push(node.id);
    } else {
      this.roots.push(node.id);
    }

    this.headBySession.set(sessionId, node.id);
    this.activeSessionId = sessionId;
    this.onDidChangeTreeDataEmitter.fire(undefined);
    return node;
  }

  getCurrentNode(sessionId = this.activeSessionId): HistoryNode | undefined {
    const headId = this.headBySession.get(sessionId);
    return headId ? this.nodes.get(headId) : undefined;
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
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Unknown node: ${nodeId}`);
    }
    this.activeSessionId = node.sessionId;
    this.headBySession.set(node.sessionId, nodeId);
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

  getTreeItem(element: HistoryTreeItem): vscode.TreeItem {
    if (this.isSessionItem(element)) {
      const roots = this.getSessionRoots(element.sessionId);
      const item = new vscode.TreeItem(
        element.label,
        roots.length > 0
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.None,
      );
      item.description = `${roots.length} root ${roots.length === 1 ? 'branch' : 'branches'}`;
      item.tooltip = `Session: ${element.sessionId}`;
      item.contextValue = 'timelineSession';
      return item;
    }

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
    item.tooltip = `Session: ${element.sessionId}\nNode: ${element.id}\nMessageID: ${element.messageId}\nGit: ${element.gitHash}\nTokens: ${element.tokenUsage.used}/${element.tokenUsage.limit}`;
    item.contextValue = 'timelineNode';
    return item;
  }

  getChildren(element?: HistoryTreeItem): Thenable<HistoryTreeItem[]> {
    if (!element) {
      return Promise.resolve(this.getSessionItems());
    }

    if (this.isSessionItem(element)) {
      return Promise.resolve(this.getSessionRoots(element.sessionId));
    }

    return Promise.resolve(element.childrenIds.map((id) => this.nodes.get(id)).filter((v): v is HistoryNode => !!v));
  }

  exportState(): PersistedHistoryState {
    const headBySession = Object.fromEntries(this.headBySession.entries());
    return {
      nodes: Array.from(this.nodes.values()).map((node) => ({
        ...node,
        childrenIds: [...node.childrenIds],
        tokenUsage: { ...node.tokenUsage },
      })),
      roots: [...this.roots],
      activeSessionId: this.activeSessionId,
      headBySession,
    };
  }

  importState(state: PersistedHistoryState): void {
    this.nodes.clear();
    this.roots.splice(0, this.roots.length);

    for (const node of state.nodes) {
      this.nodes.set(node.id, {
        ...node,
        sessionId: node.sessionId ?? 'default',
        childrenIds: [...node.childrenIds],
        tokenUsage: { ...node.tokenUsage },
      });
    }

    for (const rootId of state.roots) {
      if (this.nodes.has(rootId)) {
        this.roots.push(rootId);
      }
    }

    this.headBySession.clear();
    if (state.headBySession) {
      for (const [sessionId, headId] of Object.entries(state.headBySession)) {
        if (this.nodes.has(headId)) {
          this.headBySession.set(sessionId, headId);
        }
      }
    }

    if (this.headBySession.size === 0) {
      const legacyHeadId = (state as unknown as { headId?: string }).headId;
      if (legacyHeadId && this.nodes.has(legacyHeadId)) {
        const legacyNode = this.nodes.get(legacyHeadId)!;
        this.headBySession.set(legacyNode.sessionId, legacyHeadId);
      } else {
        for (const rootId of this.roots) {
          const rootNode = this.nodes.get(rootId);
          if (rootNode && !this.headBySession.has(rootNode.sessionId)) {
            this.headBySession.set(rootNode.sessionId, rootNode.id);
          }
        }
      }
    }

    if (state.activeSessionId) {
      this.activeSessionId = state.activeSessionId;
    } else if (this.headBySession.size > 0) {
      this.activeSessionId = this.headBySession.keys().next().value as string;
    }

    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  private getSessionItems(): SessionTreeItem[] {
    const sessionIds = new Set<string>();
    for (const node of this.nodes.values()) {
      sessionIds.add(node.sessionId);
    }

    return Array.from(sessionIds.values())
      .sort((left, right) => {
        if (left === this.activeSessionId) {
          return -1;
        }
        if (right === this.activeSessionId) {
          return 1;
        }
        return left.localeCompare(right);
      })
      .map((sessionId) => ({
        kind: 'session',
        sessionId,
        label: sessionId === this.activeSessionId
          ? `${this.getSessionLabel(sessionId)} (active)`
          : this.getSessionLabel(sessionId),
      }));
  }

  private getSessionRoots(sessionId: string): HistoryNode[] {
    return this.roots
      .map((id) => this.nodes.get(id))
      .filter((node): node is HistoryNode => !!node && node.sessionId === sessionId);
  }

  private isSessionItem(item: HistoryTreeItem): item is SessionTreeItem {
    return (item as SessionTreeItem).kind === 'session';
  }

  private getSessionLabel(sessionId: string): string {
    return this.sessionLabels.get(sessionId) ?? `Session ${sessionId.slice(0, 8)}`;
  }

  private recomputeSessionHeads(sessionId: string): void {
    const sessionNodes = Array.from(this.nodes.values()).filter((node) => node.sessionId === sessionId);
    if (sessionNodes.length === 0) {
      this.headBySession.delete(sessionId);
      return;
    }

    const newest = sessionNodes.reduce((best, current) =>
      current.timestamp > best.timestamp ? current : best,
    sessionNodes[0]);
    this.headBySession.set(sessionId, newest.id);
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
