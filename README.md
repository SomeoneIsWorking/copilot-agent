# Branching Timeline Agent (VS Code Extension)

Agentic coding extension with a persistent branching timeline, Copilot model access via `vscode.lm`, native tool-calls, and MCP tool integration.

## Current UX
- **Branching Timeline Agent** activity bar container
  - **Agent** view: chat transcript, prompt input, send, hard-stop, model textboxes
  - **Branching Timeline** view: DAG nodes with context fullness bar and rewind action

## Core Capabilities
- Uses `vscode.lm.selectChatModels` for Copilot-backed model selection
- Smart/Fast model preferences (editable in Agent view)
- Native tools:
  - `execute_terminal_command`
  - `edit_file`
  - `read_directory`
- MCP stdio integration from `mcp.json` or `.vscode/mcp.json`
- Branching DAG nodes for actions: `{ MessageID, GitHash, ParentID, TokenUsage }`
- Checkpoint commits on hidden `agent-shadow` ref before/after tool/MCP actions
- Rewind to timeline node + sidebar chat sync to branch snapshot
- Hard-stop cancels + kills process groups (stop-only)
- Persistent chat and timeline state across workspace reopen

## Project Structure
- `src/extension.ts` — activation/bootstrap wiring
- `src/AgentLoop.ts` — model/tool orchestration and session state
- `src/HistoryTreeManager.ts` — timeline DAG + git checkpoint graph state
- `src/ProcessKiller.ts` — cancellation + PGID termination
- `src/AgentSidebarView.ts` — sidebar webview bridge
- `src/agent/nativeTools.ts` — native tool definitions/executors
- `src/agent/McpStdioClient.ts` — MCP stdio client
- `prompts/agent-system.md` — external system prompt template with dynamic tools section
- `media/agent-sidebar.html` — Agent view UI template

## Run / Debug
1. Open workspace in VS Code.
2. Press `F5` using `Run Branching Timeline Extension`.
3. In Extension Development Host:
   - open **Branching Timeline Agent** in activity bar
   - use **Agent** view to chat
   - use **Branching Timeline** view to rewind/branch

Debug is configured for TypeScript watch mode via `.vscode/tasks.json` and `.vscode/launch.json`.

## Live Model Test (Real Copilot Model)
To run an end-to-end test using a real model (no fake model), run:
- Command Palette → `Branching Timeline: Run Live Model Test`

This command is registered only in **development mode** (Extension Development Host), not in production installs.

This command temporarily switches Smart/Fast models to `raptor-mini-free`, asks the agent to inspect project files, and verifies that a `read_directory` tool call occurred.

## Notes
- See `KNOWN_LIMITATIONS.md` for API/platform constraints.
- See `TODO.md` for next recommended improvements.
