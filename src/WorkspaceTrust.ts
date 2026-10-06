import * as vscode from 'vscode';

/**
 * Guards features that execute a tool or render generated workspace content.
 * UI enablement is only advisory, so every underlying implementation calls this
 * before doing work as a defense against programmatic command invocation.
 */
export function assertWorkspaceTrusted(feature: string): void {
  if (!vscode.workspace.isTrusted) {
    throw new Error(`${feature} is disabled until this workspace is trusted.`);
  }
}
