import * as vscode from 'vscode';

export const SIDEBAR_SESSION_ID = 'sidebar-session';

export const SMART_MODEL_SETTING = 'branchingTimeline.models.smart';
export const FAST_MODEL_SETTING = 'branchingTimeline.models.fast';

export const DEFAULT_SMART_MODEL = 'gpt-5.3-codex';
export const DEFAULT_FAST_MODEL = 'gemini-3-flash';

export type ModelPreferences = {
  smart: string;
  fast: string;
};

export function getModelPreferences(): ModelPreferences {
  const config = vscode.workspace.getConfiguration();
  return {
    smart: config.get<string>(SMART_MODEL_SETTING, DEFAULT_SMART_MODEL),
    fast: config.get<string>(FAST_MODEL_SETTING, DEFAULT_FAST_MODEL),
  };
}

export async function setModelPreferences(models: ModelPreferences): Promise<void> {
  const config = vscode.workspace.getConfiguration();
  await config.update(SMART_MODEL_SETTING, models.smart, vscode.ConfigurationTarget.Global);
  await config.update(FAST_MODEL_SETTING, models.fast, vscode.ConfigurationTarget.Global);
}
