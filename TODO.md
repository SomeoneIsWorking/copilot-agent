# Branching Timeline Agent TODO

## Done
- [x] Model selection via `vscode.lm.selectChatModels` with defaults:
  - `gpt-5.3-codex` (planning)
  - `gemini-3-flash` (fast analysis)
- [x] User-selectable Smart/Fast models via Agent sidebar textboxes (`Apply Models`)
- [x] Native tool handlers:
  - `execute_terminal_command`
  - `edit_file`
  - `read_directory`
- [x] MCP stdio integration from `mcp.json` / `.vscode/mcp.json`
- [x] Timeline DAG nodes with `{ MessageID, GitHash, ParentID, TokenUsage }`
- [x] Timeline sidebar with action labels and context fullness bar
- [x] Agent sidebar webview UI with chat transcript, prompt box, send button, and running/stopped state
- [x] Hard-stop:
  - cancel token
  - kill tracked process groups via PGID
  - no rollback side effects
- [x] Rewind command from timeline node to restore workspace and sync/replace sidebar chat history
- [x] Checkpointing upgraded to **real git commits** on hidden `agent-shadow` ref before/after tool calls
- [x] Per-tool approval gate with configurable mode (`branchingTimeline.toolApprovalMode`, default `auto`)
- [x] Persistent timeline + chat state across reopen via `workspaceState`
- [x] External system prompt in `prompts/agent-system.md` with dynamic tool section injection
- [x] Agent internals split into modules (`src/agent/nativeTools.ts`, `src/agent/McpStdioClient.ts`)

## Next Recommended
- [ ] Add guarded allowlist for terminal commands (security profile)
- [ ] Add retry/backoff for MCP server reconnect on failure
- [ ] Add richer UI details for nodes (duration, exit codes, file diffs)
- [ ] Add token usage + current tool indicator to Agent sidebar
- [ ] Add a "Reset Agent State" command (clear persisted chat/timeline)
- [ ] Add tests for:
  - checkpoint commit creation
  - rewind + chat sync behavior
  - hard-stop process cleanup (stop-only)
  - persistence restore/load

## How To Use
1. Press `F5` with the launch profile `Run Branching Timeline Extension`.
2. In Extension Host:
   - Open **Branching Timeline Agent** in the activity bar.
   - Use the **Agent** view to chat and apply model settings.
   - Use the **Branching Timeline** view for branch navigation/rewind.
3. Use `Hard Stop` to stop running agent work (no rollback).
