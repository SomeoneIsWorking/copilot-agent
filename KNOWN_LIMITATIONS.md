# Known Limitations

## 1) Global `vscode.ChatContext` Truncation
The VS Code extension API currently does not expose a supported way for an extension to physically rewrite/truncate the **global built-in chat transcript** for all participants.

### What is implemented instead
- Strict lineage-only replay in the extension-owned session transcript.
- On rewind, the extension restores branch state and replaces its own sidebar chat transcript from stored node snapshots.

This prevents memory leakage in model calls made by this extension.

## 2) Model Availability Depends on Account/Environment
Users can configure Smart/Fast models via settings:
- `branchingTimeline.models.smart`
- `branchingTimeline.models.fast`

The default values are `gpt-5.3-codex` and `gemini-3-flash`, but actual model availability depends on Copilot entitlement/region. If a configured model is unavailable, the selector falls back to another available model.

## 3) MCP Server Protocol Variants
MCP servers can differ in protocol version/capabilities. The extension currently uses stdio JSON-RPC framing and common methods (`initialize`, `tools/list`, `tools/call`).

## 4) Hard-Stop Semantics
Hard-stop is intentionally **stop-only**:
- cancels in-flight agent work
- terminates tracked child process groups (PGID)

It does not perform automatic git rollback.

## 5) Persistence Scope
Timeline and sidebar chat are persisted via VS Code `workspaceState` for the workspace. Data is scoped to the workspace and extension storage; it is not synchronized as cross-machine cloud state by this project.
