import type * as vscode from 'vscode';

/** A producer-owned explanation, independent of the kind of build. */
export interface BuildNotice {
  readonly message: string;
  readonly severity: 'info' | 'warning' | 'error';
}

/** Omitted diagnostics retain Problems; an empty entries array clears the supplied key. */
export interface BuildResult extends BuildNotice {
  readonly outcome: 'succeeded' | 'failed' | 'cancelled';
  readonly diagnostics?: {
    readonly key: vscode.Uri;
    readonly entries: readonly [vscode.Uri, readonly vscode.Diagnostic[]][];
  };
}

/** A request-scoped channel for progress and cooperative cancellation. */
export interface BuildContext {
  readonly token: vscode.CancellationToken;
  reportProgress(message: string, target?: vscode.Uri): void;
  reportNotice(notice?: BuildNotice): void;
}

/** A reusable saved-source request; each execution discovers fresh inputs. */
export interface BuildRequest {
  readonly source: vscode.Uri;
  readonly label: string;
  execute(context: BuildContext): Promise<BuildResult>;
}
