I want to build a VS Code extension for a "Branching Timeline" AI Agent that uses my GitHub Copilot subscription via the `vscode.lm` API.

1. MODELS & AUTH:
   - Use `vscode.lm.selectChatModels` to access the user's Copilot subscription. 
   - Default to `gpt-5.3-codex` for planning and `gemini-3-flash` for high-speed file analysis.

2. TOOL CALLS & MCP INTEGRATION:
   - NATIVE TOOLS: Implement tool-calling using `vscode.lm.tools`. The agent must be able to:
     - `execute_terminal_command`: Run commands and read output.
     - `edit_file`: Patch specific lines of code.
     - `read_directory`: Map out the project structure.
   - MCP SUPPORT: Enable the agent to connect to external MCP Servers (Model Context Protocol). It should be able to list and invoke tools from servers defined in the user's `mcp.json`.

3. BRANCHING TIMELINE (DAG):
   - Every "Action" (Tool Call or MCP call) creates a Node in a tree: { MessageID, GitHash, ParentID, TokenUsage }.
   - VISUALIZATION: Provide a sidebar Timeline View showing each node, its action, and a "Context Fullness" bar (tokens used vs. total limit).

4. SYNCED UNDO & HARD-STOP:
   - HARD STOP: A button that kills the `CancellationToken`, terminates all terminal child processes via PGID, and rolls back the files to the last Git checkpoint.
   - CONTEXT REWIND: When the user jumps to a previous node or undos, the extension must physically truncate the `vscode.ChatContext` to match that node's history exactly. NO "memory leakage" from failed branches allowed.

5. CHECKPOINTING:
   - Automatically run a Git commit on a hidden "agent-shadow" branch before and after every Tool or MCP call.

Please provide the TypeScript implementation for the `AgentLoop` (handling Tool/MCP orchestration), the `HistoryTreeManager` for branching logic, and the `ProcessKiller` for the Hard-Stop button.