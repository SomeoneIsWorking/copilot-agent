import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { McpStdioClient } from './agent/McpStdioClient';
import { createNativeToolDefinitions, type NativeToolDefinition } from './agent/nativeTools';
import { SessionManager } from './agent/SessionManager';
import { HistoryTreeManager } from './HistoryTreeManager';
import { ProcessKiller } from './ProcessKiller';
import type {
  AgentSession,
  AgentActionResult,
  ChatMessage,
  MCPConfigFile,
  MCPToolCall,
  NativeToolCall,
  PersistedAgentLoopState,
  TokenUsage,
} from './types';

type AnyModel = {
  id?: string;
  name?: string;
  sendRequest: (messages: any[], options: any, token: vscode.CancellationToken) => Promise<any>;
};

type ToolOutcome = {
  output: string;
  messageId: string;
};

type ConfigureModelOptions = {
  strict?: boolean;
};

export class AgentLoop {
  private planningModel: AnyModel | undefined;
  private analysisModel: AnyModel | undefined;
  private preferredSmartModel = 'gpt-5.3-codex';
  private preferredFastModel = 'gemini-3-flash';
  private readonly sessionMessages = new Map<string, ChatMessage[]>();
  private readonly sessionManager = new SessionManager();
  private readonly nodeSessionSnapshots = new Map<string, ChatMessage[]>();
  private readonly mcpClients = new Map<string, McpStdioClient>();
  private readonly onDidSessionChangeEmitter = new vscode.EventEmitter<{ sessionId: string; messages: ChatMessage[] }>();
  private readonly onDidSessionsChangeEmitter = new vscode.EventEmitter<AgentSession[]>();
  private readonly nativeToolDefinitions: NativeToolDefinition[];
  private systemPromptTemplate: string | undefined;
  private nativeToolsRegistered = false;

  readonly onDidSessionChange = this.onDidSessionChangeEmitter.event;
  readonly onDidSessionsChange = this.onDidSessionsChangeEmitter.event;

  constructor(
    private readonly workspacePath: string,
    private readonly workspaceRoots: string[],
    private readonly extensionUri: vscode.Uri,
    private readonly historyTreeManager: HistoryTreeManager,
    private readonly processKiller: ProcessKiller,
  ) {
    this.nativeToolDefinitions = createNativeToolDefinitions(
      this.workspacePath,
      this.workspaceRoots,
      this.processKiller,
    );
  }

  async initialize(): Promise<void> {
    await this.historyTreeManager.initialize();
    this.planningModel = await this.selectModel(this.preferredSmartModel);
    this.analysisModel = await this.selectModel(this.preferredFastModel);
    await this.connectMcpServers();
    this.registerNativeToolsWithVsCodeLm();
  }

  async configureModels(
    preferredSmartModel: string,
    preferredFastModel: string,
    options?: ConfigureModelOptions,
  ): Promise<void> {
    this.preferredSmartModel = preferredSmartModel;
    this.preferredFastModel = preferredFastModel;
    this.planningModel = await this.selectModel(this.preferredSmartModel, options?.strict === true);
    this.analysisModel = await this.selectModel(this.preferredFastModel, options?.strict === true);
  }

  getActiveModelIds(): { smart?: string; fast?: string } {
    return {
      smart: this.planningModel?.id ?? this.planningModel?.name,
      fast: this.analysisModel?.id ?? this.analysisModel?.name,
    };
  }

  async listAvailableModels(): Promise<Array<{ id: string; name: string }>> {
    const lmAny = vscode.lm as any;
    const models = await lmAny.selectChatModels({});
    if (!Array.isArray(models)) {
      return [];
    }

    return models.map((model: AnyModel) => ({
      id: String(model.id ?? model.name ?? 'unknown-model'),
      name: String(model.name ?? model.id ?? 'Unknown Model'),
    }));
  }

  createSession(label = 'session'): AgentSession {
    const session = this.sessionManager.createSession(label);
    this.emitSessionsChange();
    return session;
  }

  listSessions(): AgentSession[] {
    return this.sessionManager.listSessions();
  }

  deleteSession(sessionId: string): void {
    this.sessionManager.deleteSession(sessionId);
    this.sessionMessages.delete(sessionId);
    this.emitSessionsChange();
    this.emitSessionChange(sessionId);
  }

  pruneNodeSnapshots(nodeIds: string[]): void {
    for (const nodeId of nodeIds) {
      this.nodeSessionSnapshots.delete(nodeId);
    }
  }

  renameSession(sessionId: string, label: string): AgentSession | undefined {
    const renamed = this.sessionManager.renameSession(sessionId, label);
    if (renamed) {
      this.emitSessionsChange();
    }
    return renamed;
  }

  getSessionMessages(sessionId: string): ChatMessage[] {
    return this.cloneMessages(this.sessionMessages.get(sessionId) ?? []);
  }

  exportState(): PersistedAgentLoopState {
    const sessionMessages = Object.fromEntries(
      Array.from(this.sessionMessages.entries()).map(([sessionId, messages]) => [sessionId, this.cloneMessages(messages)]),
    );
    const nodeSessionSnapshots = Object.fromEntries(
      Array.from(this.nodeSessionSnapshots.entries()).map(([nodeId, messages]) => [nodeId, this.cloneMessages(messages)]),
    );
    return {
      sessions: this.sessionManager.exportState(),
      sessionMessages,
      nodeSessionSnapshots,
    };
  }

  importState(state: PersistedAgentLoopState): void {
    this.sessionMessages.clear();
    this.nodeSessionSnapshots.clear();
    this.sessionManager.importState(state.sessions ?? []);
    this.emitSessionsChange();

    for (const [sessionId, messages] of Object.entries(state.sessionMessages ?? {})) {
      this.sessionManager.ensureSession(sessionId);
      this.sessionMessages.set(sessionId, this.cloneMessages(messages ?? []));
    }
    for (const [nodeId, messages] of Object.entries(state.nodeSessionSnapshots ?? {})) {
      this.nodeSessionSnapshots.set(nodeId, this.cloneMessages(messages ?? []));
    }

    for (const sessionId of this.sessionMessages.keys()) {
      this.emitSessionChange(sessionId);
    }
  }

  async runTurn(sessionId: string, userPrompt: string): Promise<AgentActionResult> {
    if (!this.planningModel || !this.analysisModel) {
      await this.initialize();
    }

    const sessionWasMissing = !this.sessionManager.hasSession(sessionId);
    this.sessionManager.ensureSession(sessionId);
    if (sessionWasMissing) {
      this.emitSessionsChange();
    }
    this.historyTreeManager.setActiveSession(sessionId);
    const messages = this.sessionMessages.get(sessionId) ?? [];
    const userMessage: ChatMessage = {
      role: 'user',
      content: userPrompt,
      messageId: randomUUID(),
    };
    messages.push(userMessage);

    const maxSteps = 12;
    let finalText = '';
    let totalUsed = 0;
    let totalLimit = 1;

    for (let step = 0; step < maxSteps; step++) {
      const model = step === 0 ? this.planningModel! : this.analysisModel!;
      const toolingContext = await this.collectToolingContext();
      const systemMessage: ChatMessage = {
        role: 'system',
        content: await this.renderSystemPrompt(toolingContext.promptSection),
        messageId: `system-${sessionId}`,
      };

      const response = await model.sendRequest(
        this.toLanguageModelMessages([systemMessage, ...messages]),
        {
          tools: toolingContext.descriptors,
        },
        this.processKiller.token,
      );

      const streamedText: string[] = [];
      const requestedCalls: Array<NativeToolCall | MCPToolCall> = [];

      for await (const chunk of response.stream) {
        const parsed = this.parseChunk(chunk);
        if (parsed.text) {
          streamedText.push(parsed.text);
        }
        requestedCalls.push(...parsed.calls);
      }

      requestedCalls.push(...this.extractToolCalls(response));
      const dedupedCalls = this.dedupeCalls(requestedCalls);

      const tokenUsage = this.readTokenUsage(response);
      totalUsed += tokenUsage.used;
      totalLimit = Math.max(totalLimit, tokenUsage.limit);

      const assistantText = streamedText.join('');
      finalText = assistantText;

      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: assistantText,
        messageId: randomUUID(),
      };
      messages.push(assistantMessage);

      const baseHash = (await this.historyTreeManager.createCheckpoint({
        reason: `model-turn-${step}-before-tools`,
        actionLabel: 'Model turn start',
      }, undefined, sessionId)).gitHash;

      const modelNode = this.historyTreeManager.addNode({
        sessionId,
        messageId: assistantMessage.messageId,
        gitHash: baseHash,
        tokenUsage,
        actionKind: 'model',
        actionLabel: model.id ?? model.name ?? 'model-response',
      });
      this.nodeSessionSnapshots.set(modelNode.id, this.cloneMessages(messages));

      if (dedupedCalls.length === 0) {
        this.sessionMessages.set(sessionId, this.cloneMessages(messages));
        this.sessionManager.touchSession(sessionId);
        this.emitSessionChange(sessionId);
        return {
          outputText: finalText,
          tokenUsage: { used: totalUsed, limit: totalLimit },
          messageId: modelNode.messageId,
        };
      }

      for (const requestedCall of dedupedCalls) {
        const beforeNode = await this.historyTreeManager.createCheckpoint({
          reason: `before-${this.callLabel(requestedCall)}`,
          actionLabel: `Before ${this.callLabel(requestedCall)}`,
        }, undefined, sessionId);

        const toolOutcome = await this.executeRequestedCall(requestedCall);

        const afterNode = await this.historyTreeManager.createCheckpoint({
          reason: `after-${this.callLabel(requestedCall)}`,
          actionLabel: `After ${this.callLabel(requestedCall)}`,
        }, beforeNode.id, sessionId);

        const actionKind = this.isNativeCall(requestedCall) ? 'tool' : 'mcp';
        const actionNode = this.historyTreeManager.addNode({
          sessionId,
          messageId: toolOutcome.messageId,
          gitHash: afterNode.gitHash,
          parentId: afterNode.id,
          tokenUsage: { used: 0, limit: totalLimit },
          actionKind,
          actionLabel: this.callLabel(requestedCall),
        });

        messages.push({
          role: 'tool',
          content: toolOutcome.output,
          messageId: toolOutcome.messageId,
          name: this.callLabel(requestedCall),
        });
        this.nodeSessionSnapshots.set(actionNode.id, this.cloneMessages(messages));
      }
    }

    this.sessionMessages.set(sessionId, this.cloneMessages(messages));
    this.sessionManager.touchSession(sessionId);
    this.emitSessionChange(sessionId);
    return {
      outputText: finalText,
      tokenUsage: { used: totalUsed, limit: totalLimit },
      messageId: randomUUID(),
    };
  }

  async rewindToNode(sessionId: string, nodeId: string): Promise<ChatMessage[]> {
    const sessionWasMissing = !this.sessionManager.hasSession(sessionId);
    this.sessionManager.ensureSession(sessionId);
    if (sessionWasMissing) {
      this.emitSessionsChange();
    }
    this.historyTreeManager.setActiveSession(sessionId);
    const lineage = this.historyTreeManager.jumpToNode(nodeId);
    const node = lineage[lineage.length - 1];
    if (node) {
      await this.historyTreeManager.rollbackToGitHash(node.gitHash);
    }
    const snapshot = this.nodeSessionSnapshots.get(nodeId);
    if (snapshot) {
      const cloned = this.cloneMessages(snapshot);
      this.sessionMessages.set(sessionId, cloned);
      this.sessionManager.touchSession(sessionId);
      this.emitSessionChange(sessionId);
      return cloned;
    }

    const existing = this.sessionMessages.get(sessionId) ?? [];
    const truncated = this.historyTreeManager.truncateMessagesForNode(nodeId, existing);
    const cloned = this.cloneMessages(truncated);
    this.sessionMessages.set(sessionId, cloned);
    this.sessionManager.touchSession(sessionId);
    this.emitSessionChange(sessionId);
    return cloned;
  }

  async hardStop(): Promise<void> {
    await this.processKiller.hardStop();
  }

  private emitSessionChange(sessionId: string): void {
    this.onDidSessionChangeEmitter.fire({
      sessionId,
      messages: this.getSessionMessages(sessionId),
    });
  }

  private emitSessionsChange(): void {
    this.onDidSessionsChangeEmitter.fire(this.listSessions());
  }

  private cloneMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((message) => ({ ...message }));
  }

  private async selectModel(preferredModelId: string, strict = false): Promise<AnyModel> {
    const lmAny = vscode.lm as any;
    const selectors = [
      { id: preferredModelId },
      { family: preferredModelId },
      { name: preferredModelId },
      {},
    ];

    let fallbackModel: AnyModel | undefined;

    for (const selector of selectors) {
      const models = await lmAny.selectChatModels(selector);
      if (Array.isArray(models) && models.length > 0) {
        const exact = models.find((m: AnyModel) => [m.id, m.name].includes(preferredModelId));
        if (exact) {
          return exact;
        }
        fallbackModel ??= models[0];
      }
    }

    if (!strict && fallbackModel) {
      return fallbackModel;
    }

    throw new Error(`No chat model available for selector: ${preferredModelId}`);
  }

  private toLanguageModelMessages(messages: ChatMessage[]): any[] {
    const lmAny = vscode as any;
    const MessageCtor = lmAny.LanguageModelChatMessage;
    return messages.map((message) => {
      if (MessageCtor?.User && message.role === 'user') {
        return MessageCtor.User(message.content);
      }
      if (MessageCtor?.Assistant && message.role === 'assistant') {
        return MessageCtor.Assistant(message.content);
      }
      if (MessageCtor?.Tool && message.role === 'tool') {
        return MessageCtor.Tool(message.name ?? 'tool', message.content);
      }
      if (MessageCtor?.System && message.role === 'system') {
        return MessageCtor.System(message.content);
      }
      return { role: message.role, content: message.content, name: message.name };
    });
  }

  private parseChunk(chunk: any): { text: string; calls: Array<NativeToolCall | MCPToolCall> } {
    if (!chunk) {
      return { text: '', calls: [] };
    }

    const text = typeof chunk === 'string'
      ? chunk
      : typeof chunk.text === 'string'
        ? chunk.text
        : typeof chunk.value === 'string'
          ? chunk.value
          : '';

    const calls = this.extractToolCalls(chunk);

    return { text, calls };
  }

  private extractToolCalls(source: any): Array<NativeToolCall | MCPToolCall> {
    const calls: Array<NativeToolCall | MCPToolCall> = [];
    const nativeToolNames = new Set(this.nativeToolDefinitions.map((tool) => tool.name));

    const visit = (value: any, depth: number): void => {
      if (depth > 6 || value == null) {
        return;
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          visit(item, depth + 1);
        }
        return;
      }

      if (typeof value !== 'object') {
        return;
      }

      const maybeName = typeof value.name === 'string'
        ? value.name
        : typeof value.toolName === 'string'
          ? value.toolName
          : typeof value.function?.name === 'string'
            ? value.function.name
            : undefined;

      if (maybeName) {
        const rawInput = value.input
          ?? value.arguments
          ?? value.args
          ?? value.function?.arguments
          ?? {};

        let parsedInput: Record<string, unknown>;
        if (typeof rawInput === 'string') {
          try {
            parsedInput = JSON.parse(rawInput) as Record<string, unknown>;
          } catch {
            parsedInput = { raw: rawInput };
          }
        } else {
          parsedInput = (rawInput ?? {}) as Record<string, unknown>;
        }

        if (nativeToolNames.has(maybeName as NativeToolCall['name'])) {
          calls.push({ name: maybeName as NativeToolCall['name'], input: parsedInput });
        } else if (maybeName.includes('.')) {
          const [server, toolName] = maybeName.split('.', 2);
          calls.push({ server, name: toolName, input: parsedInput });
        }
      }

      for (const key of Object.keys(value)) {
        if (['name', 'toolName', 'input', 'arguments', 'args', 'function'].includes(key)) {
          continue;
        }
        visit(value[key], depth + 1);
      }
    };

    visit(source, 0);
    return calls;
  }

  private dedupeCalls(calls: Array<NativeToolCall | MCPToolCall>): Array<NativeToolCall | MCPToolCall> {
    const seen = new Set<string>();
    const unique: Array<NativeToolCall | MCPToolCall> = [];

    for (const call of calls) {
      const key = this.isNativeCall(call)
        ? `${call.name}:${JSON.stringify(call.input ?? {})}`
        : `${call.server}.${call.name}:${JSON.stringify(call.input ?? {})}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      unique.push(call);
    }

    return unique;
  }

  private readTokenUsage(response: any): TokenUsage {
    const usage = response?.tokenUsage ?? response?.usage ?? {};
    const totalTokens = typeof usage.totalTokens === 'number'
      ? usage.totalTokens
      : Number(usage.inputTokens ?? 0) + Number(usage.outputTokens ?? 0);
    const used = Number(usage.used ?? totalTokens ?? 0);
    const limit = Number(usage.maxTokens ?? usage.limit ?? 128000);
    return {
      used: Number.isFinite(used) ? used : 0,
      limit: Number.isFinite(limit) && limit > 0 ? limit : 128000,
    };
  }

  private callLabel(call: NativeToolCall | MCPToolCall): string {
    if (this.isNativeCall(call)) {
      return call.name;
    }
    return `${call.server}.${call.name}`;
  }

  private isNativeCall(call: NativeToolCall | MCPToolCall): call is NativeToolCall {
    return this.nativeToolDefinitions.some((tool) => tool.name === (call as NativeToolCall).name);
  }

  private async executeRequestedCall(call: NativeToolCall | MCPToolCall): Promise<ToolOutcome> {
    const approved = await this.requestApproval(call);
    if (!approved) {
      return {
        output: JSON.stringify({
          skipped: true,
          reason: 'User denied tool call',
          call: this.callLabel(call),
        }, null, 2),
        messageId: randomUUID(),
      };
    }

    if (this.isNativeCall(call)) {
      const definition = this.nativeToolDefinitions.find((tool) => tool.name === call.name);
      if (!definition) {
        throw new Error(`Unknown native tool: ${call.name}`);
      }
      return {
        output: await definition.execute(call.input),
        messageId: randomUUID(),
      };
    }

    const client = this.mcpClients.get(call.server);
    if (!client) {
      throw new Error(`Unknown MCP server: ${call.server}`);
    }

    const result = await client.callTool(call.name, call.input);
    return {
      output: JSON.stringify(result, null, 2),
      messageId: randomUUID(),
    };
  }

  private async requestApproval(call: NativeToolCall | MCPToolCall): Promise<boolean> {
    const config = vscode.workspace.getConfiguration();
    const approvalMode = config.get<string>('branchingTimeline.toolApprovalMode', 'ask');
    if (approvalMode === 'auto') {
      return true;
    }

    const detail = this.describeCall(call);
    const run = 'Run';
    const deny = 'Deny';
    const selected = await vscode.window.showWarningMessage(
      `Approve agent action: ${this.callLabel(call)}?`,
      {
        modal: true,
        detail,
      },
      run,
      deny,
    );
    return selected === run;
  }

  private describeCall(call: NativeToolCall | MCPToolCall): string {
    const payload = this.isNativeCall(call)
      ? { tool: call.name, input: call.input }
      : { server: call.server, tool: call.name, input: call.input };
    const text = JSON.stringify(payload, null, 2);
    return text.length > 2000 ? `${text.slice(0, 2000)}\n...(truncated)` : text;
  }

  private registerNativeToolsWithVsCodeLm(): void {
    if (this.nativeToolsRegistered) {
      return;
    }
    const lmAny = vscode.lm as any;
    const toolsApi = lmAny?.tools;
    if (!toolsApi?.registerTool) {
      return;
    }

    const register = (name: string, description: string, inputSchema: unknown) => {
      toolsApi.registerTool({
        name,
        description,
        inputSchema,
      });
    };

    for (const tool of this.nativeToolDefinitions) {
      register(tool.name, tool.description, tool.inputSchema);
    }

    this.nativeToolsRegistered = true;
  }

  private async collectToolingContext(): Promise<{ descriptors: any[]; promptSection: string }> {
    const descriptors = this.nativeToolDefinitions.map((tool) => ({ name: tool.name }));

    const nativeSection = this.nativeToolDefinitions
      .map((tool) => {
        const schema = JSON.stringify(tool.inputSchema, null, 2);
        return `- ${tool.name}: ${tool.description}\n  inputSchema:\n${this.indentBlock(schema, 4)}`;
      })
      .join('\n');

    const mcpSectionRows: string[] = [];
    const mcpToolDescriptors: Array<{ name: string }> = [];
    for (const [serverName, client] of this.mcpClients.entries()) {
      const tools = await client.listTools();
      for (const tool of tools) {
        mcpToolDescriptors.push({ name: `${serverName}.${tool.name}` });
        const schema = tool.inputSchema ? JSON.stringify(tool.inputSchema, null, 2) : '{}';
        mcpSectionRows.push(`- ${serverName}.${tool.name}: ${tool.description ?? 'No description'}\n  inputSchema:\n${this.indentBlock(schema, 4)}`);
      }
    }

    const mcpSection = mcpSectionRows.length > 0
      ? mcpSectionRows.join('\n')
      : '- (none connected)';

    return {
      descriptors: [...descriptors, ...mcpToolDescriptors],
      promptSection: [
        'Native tools:',
        nativeSection,
        '',
        'MCP tools:',
        mcpSection,
      ].join('\n'),
    };
  }

  private indentBlock(value: string, spaces: number): string {
    const indent = ' '.repeat(spaces);
    return value
      .split('\n')
      .map((line) => `${indent}${line}`)
      .join('\n');
  }

  private async renderSystemPrompt(toolsSection: string): Promise<string> {
    if (!this.systemPromptTemplate) {
      const promptUri = vscode.Uri.joinPath(this.extensionUri, 'prompts', 'agent-system.md');
      const bytes = await vscode.workspace.fs.readFile(promptUri);
      this.systemPromptTemplate = Buffer.from(bytes).toString('utf8');
    }

    return this.systemPromptTemplate.replaceAll('__TOOLS_SECTION__', toolsSection);
  }

  private async connectMcpServers(): Promise<void> {
    const config = await this.readMcpConfig();
    if (!config) {
      return;
    }

    for (const [serverName, serverConfig] of Object.entries(config.servers)) {
      if (this.mcpClients.has(serverName)) {
        continue;
      }
      const client = new McpStdioClient(
        serverName,
        serverConfig.command,
        serverConfig.args ?? [],
        {
          ...(process.env as Record<string, string>),
          ...(serverConfig.env ?? {}),
        },
        serverConfig.cwd ? this.resolvePath(serverConfig.cwd) : this.workspacePath,
        this.processKiller,
      );
      await client.connect();
      this.mcpClients.set(serverName, client);
    }
  }

  private async readMcpConfig(): Promise<MCPConfigFile | undefined> {
    const candidates = [
      path.join(this.workspacePath, 'mcp.json'),
      path.join(this.workspacePath, '.vscode', 'mcp.json'),
    ];

    for (const candidate of candidates) {
      try {
        const raw = await fs.readFile(candidate, 'utf8');
        const parsed = JSON.parse(raw) as MCPConfigFile;
        if (parsed && parsed.servers && typeof parsed.servers === 'object') {
          return parsed;
        }
      } catch {
      }
    }

    return undefined;
  }

  private resolvePath(p: string): string {
    return path.isAbsolute(p) ? p : path.join(this.workspacePath, p);
  }
}
