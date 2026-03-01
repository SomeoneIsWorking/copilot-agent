import * as vscode from 'vscode';
import { AgentLoop } from '../AgentLoop';
import { getModelPreferences, setModelPreferences } from '../config';

export function registerDebugCommands(context: vscode.ExtensionContext, agentLoop: AgentLoop): void {
  const diagnosticsOutput = vscode.window.createOutputChannel('Branching Timeline Live Test');
  context.subscriptions.push(diagnosticsOutput);

  const log = (line: string): void => {
    diagnosticsOutput.appendLine(line);
    console.log(`[BranchingTimelineLiveTest] ${line}`);
  };

  const logError = (line: string): void => {
    diagnosticsOutput.appendLine(line);
    console.error(`[BranchingTimelineLiveTest] ${line}`);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('branchingTimeline.listAvailableModelsDebug', async () => {
      diagnosticsOutput.clear();
      log('=== Available Chat Models ===');
      try {
        const models = await agentLoop.listAvailableModels();
        if (models.length === 0) {
          log('No models returned by vscode.lm.selectChatModels({}).');
          diagnosticsOutput.show(true);
          vscode.window.showWarningMessage('No chat models were returned.');
          return;
        }

        for (const model of models) {
          log(`- ${model.id} (${model.name})`);
        }
        log(`Total models: ${models.length}`);
        diagnosticsOutput.show(true);
        vscode.window.showInformationMessage(`Listed ${models.length} available chat models.`);
      } catch (error) {
        logError(`Failed to list models: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        diagnosticsOutput.show(true);
        vscode.window.showErrorMessage('Failed to list available models. See "Branching Timeline Live Test" output.');
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('branchingTimeline.runLiveModelTest', async () => {
      const previousPrefs = getModelPreferences();
      const session = agentLoop.createSession('live-test');
      const sessionId = session.id;
      const prompt = 'Read the project files and give a concise opinion.';
      const requestedModel = process.env.BRANCHING_TIMELINE_LIVE_TEST_MODEL ?? 'raptor-mini-free';

      diagnosticsOutput.clear();
      log('=== Live Model Test Start ===');
      log(`Session: ${sessionId}`);
      log(`Session label: ${session.label}`);
      log(`Previous model prefs: smart=${previousPrefs.smart}, fast=${previousPrefs.fast}`);
      log(`Requested live test model: ${requestedModel}`);
      log(`Prompt: ${prompt}`);

      const availableModels = await agentLoop.listAvailableModels();
      const availableModelIds = availableModels.map((model) => model.id);
      log(`Available model IDs: ${availableModelIds.join(', ') || '(none)'}`);

      const fallbackCandidates = ['copilot-fast', 'gpt-5-mini', 'gpt-4o-mini', 'gpt-5.3-codex'];
      const selectedModel = availableModelIds.includes(requestedModel)
        ? requestedModel
        : fallbackCandidates.find((candidate) => availableModelIds.includes(candidate))
          ?? availableModelIds[0];

      if (!selectedModel) {
        logError('Result: FAILED (no available models).');
        diagnosticsOutput.show(true);
        vscode.window.showErrorMessage('Live model test failed: no available models returned by vscode.lm.');
        return;
      }

      if (selectedModel !== requestedModel) {
        log(`Requested model not available. Falling back to: ${selectedModel}`);
      }

      log(`Target model prefs: smart=${selectedModel}, fast=${selectedModel}`);

      try {
        await setModelPreferences({ smart: selectedModel, fast: selectedModel });
        await agentLoop.configureModels(selectedModel, selectedModel, { strict: true });

        const activeModels = agentLoop.getActiveModelIds();
        log(`Resolved models: smart=${activeModels.smart ?? '(unknown)'}, fast=${activeModels.fast ?? '(unknown)'}`);
        if (activeModels.smart !== selectedModel || activeModels.fast !== selectedModel) {
          throw new Error(
            `Strict model mismatch. Expected ${selectedModel} for both, got smart=${activeModels.smart ?? 'unknown'}, fast=${activeModels.fast ?? 'unknown'}. Available IDs: ${availableModelIds.join(', ') || '(none)'}`,
          );
        }

        const beforeMessages = agentLoop.getSessionMessages(sessionId);
        const beforeCount = beforeMessages.length;
        log(`Messages before run: ${beforeCount}`);

        await agentLoop.runTurn(sessionId, prompt);

        const afterMessages = agentLoop.getSessionMessages(sessionId).slice(beforeCount);
        const readDirectoryCalls = afterMessages.filter(
          (message) => message.role === 'tool' && message.name === 'read_directory',
        );
        const allToolCalls = afterMessages
          .filter((message) => message.role === 'tool')
          .map((message) => message.name ?? '(unnamed tool)');
        const assistantMessages = afterMessages
          .filter((message) => message.role === 'assistant')
          .map((message) => message.content);

        log(`Messages added after run: ${afterMessages.length}`);
        log(`Tool calls detected: ${allToolCalls.length > 0 ? allToolCalls.join(', ') : '(none)'}`);
        log(`read_directory count: ${readDirectoryCalls.length}`);
        log('Recent message trace:');
        for (const message of afterMessages.slice(-8)) {
          const label = `${message.role}${message.name ? `:${message.name}` : ''}`;
          const excerpt = message.content.replace(/\s+/g, ' ').slice(0, 220);
          log(`- ${label}: ${excerpt}${message.content.length > 220 ? '…' : ''}`);
        }

        if (assistantMessages.length > 0) {
          log('Last assistant response excerpt:');
          const lastAssistant = assistantMessages[assistantMessages.length - 1] ?? '';
          log(lastAssistant.slice(0, 500));
        }

        if (readDirectoryCalls.length === 0) {
          logError('Result: FAILED (no read_directory tool call detected).');
          diagnosticsOutput.show(true);
          vscode.window.showErrorMessage('Live model test failed: no read_directory tool call detected. See "Branching Timeline Live Test" output.');
          return;
        }

        log('Result: PASSED');
        diagnosticsOutput.show(true);
        vscode.window.showInformationMessage(
          `Live model test passed with ${selectedModel}. read_directory calls: ${readDirectoryCalls.length}`,
        );
      } catch (error) {
        logError('Result: FAILED (exception)');
        logError(`Error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        diagnosticsOutput.show(true);
        vscode.window.showErrorMessage(
          `Live model test failed: ${error instanceof Error ? error.message : String(error)}. See "Branching Timeline Live Test" output.`,
        );
      } finally {
        await setModelPreferences(previousPrefs);
        await agentLoop.configureModels(previousPrefs.smart, previousPrefs.fast);
        log(`Restored model prefs: smart=${previousPrefs.smart}, fast=${previousPrefs.fast}`);
        log('=== Live Model Test End ===');
      }
    }),
  );
}
