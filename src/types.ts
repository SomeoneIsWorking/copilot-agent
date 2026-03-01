export type ActionKind = 'tool' | 'mcp' | 'checkpoint' | 'model';

export interface TokenUsage {
  used: number;
  limit: number;
}

export interface HistoryNode {
  id: string;
  sessionId: string;
  messageId: string;
  gitHash: string;
  parentId?: string;
  childrenIds: string[];
  tokenUsage: TokenUsage;
  actionKind: ActionKind;
  actionLabel: string;
  timestamp: number;
}

export interface NativeToolCall {
  name: 'execute_terminal_command' | 'edit_file' | 'read_directory';
  input: Record<string, unknown>;
}

export interface MCPToolCall {
  server: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentActionResult {
  outputText: string;
  tokenUsage: TokenUsage;
  messageId: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  messageId: string;
  name?: string;
}

export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface MCPConfigFile {
  servers: Record<string, MCPServerConfig>;
}

export interface MCPListedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface CheckpointMetadata {
  reason: string;
  actionLabel: string;
}

export interface PersistedHistoryState {
  nodes: HistoryNode[];
  roots: string[];
  activeSessionId?: string;
  headBySession?: Record<string, string>;
}

export interface PersistedAgentLoopState {
  sessions?: AgentSession[];
  sessionMessages: Record<string, ChatMessage[]>;
  nodeSessionSnapshots: Record<string, ChatMessage[]>;
}

export interface AgentSession {
  id: string;
  label: string;
  createdAt: number;
  updatedAt: number;
}
