import * as vscode from 'vscode';
import * as path from 'path';
import * as Workspace from '../workspace';

export interface CompletionQuery {
  /** The mutable query only: do not include the command or opening delimiter. */
  start: number;
  end: number;
  scope: string;
}

interface ActiveSession<T> extends CompletionQuery {
  document: vscode.TextDocument;
  version: number;
  cancellation: vscode.CancellationTokenSource;
  token: vscode.CancellationToken;
  waiters: number;
  value: Promise<T>;
  watches: Map<string, vscode.Disposable>;
  dependencies: Set<string>;
}

/** Keeps candidates only while one completion query is being edited. */
export default class CompletionSession<T> implements vscode.Disposable {
  private active?: ActiveSession<T>;
  private disposed = false;
  private readonly subscriptions: vscode.Disposable[];

  constructor() {
    this.subscriptions = [
      vscode.workspace.onDidChangeTextDocument(event => this.changed(event)),
      vscode.workspace.onDidCloseTextDocument(document => {
        if (this.active && (this.active.document === document || this.active.scope === 'project')) { this.invalidate(); }
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('vscode-fortex.completion')
          || event.affectsConfiguration('vscode-fortex.mainFileOrder')
          || event.affectsConfiguration('vscode-fortex.kpsewhich.path')) { this.invalidate(); }
      }),
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (this.active && editor?.document !== this.active.document) { this.invalidate(); }
      }),
      vscode.window.onDidChangeTextEditorSelection(event => {
        const active = this.active;
        if (!active || event.textEditor.document !== active.document) { return; }
        if (event.selections.length !== 1 || !event.selections[0].isEmpty
          || event.textEditor.document.offsetAt(event.selections[0].active) !== active.end) { this.invalidate(); }
      })
    ];
  }

  async get(
    document: vscode.TextDocument,
    query: CompletionQuery,
    token: vscode.CancellationToken,
    load: (token: vscode.CancellationToken) => T | Promise<T>
  ): Promise<T | undefined> {
    if (this.disposed || token.isCancellationRequested) { return undefined; }
    const requestedVersion = document.version;
    let active = this.active;
    if (!active || active.document !== document || active.version !== document.version
      || active.start !== query.start || active.end !== query.end || active.scope !== query.scope) {
      this.invalidate();
      const cancellation = new vscode.CancellationTokenSource();
      const sessionToken = cancellation.token;
      active = {
        ...query, document, version: document.version, cancellation, token: sessionToken, waiters: 0,
        watches: new Map(), dependencies: new Set(), value: Promise.resolve().then(() => load(sessionToken))
      };
      this.active = active;
      if (query.scope === 'project') {
        // Candidate files can be added before they belong to the discovered graph.
        const watcher = vscode.workspace.createFileSystemWatcher('**/*.tex');
        const invalidate = () => { if (this.active === active) { this.invalidate(); } };
        active.watches.set('workspace', vscode.Disposable.from(watcher,
          watcher.onDidChange(invalidate), watcher.onDidCreate(invalidate), watcher.onDidDelete(invalidate)));
      }
    }
    let subscription: vscode.Disposable | undefined;
    active.waiters++;
    try {
      const result = await Promise.race([
        active.value.then(value => ({ value })),
        new Promise<{ cancelled: true }>(resolve => {
          subscription = token.onCancellationRequested(() => resolve({ cancelled: true }));
          if (token.isCancellationRequested) { resolve({ cancelled: true }); }
        })
      ]);
      return !('cancelled' in result) && !token.isCancellationRequested && this.active === active ? result.value : undefined;
    } catch (error) {
      if (this.active === active) { this.invalidate(); }
      if (token.isCancellationRequested || active.token.isCancellationRequested
        || error instanceof vscode.CancellationError) { return undefined; }
      throw error;
    } finally {
      subscription?.dispose();
      active.waiters--;
      // VS Code cancels an older completion request when another query character
      // arrives, potentially before registering its successor. Preserve that
      // context's shared load when the allowed edit already advanced its version.
      if (token.isCancellationRequested && active.waiters === 0 && this.active === active
        && active.version === requestedVersion) { this.invalidate(); }
    }
  }

  /** Temporary watches also cover project sources outside workspace folders. */
  watch(uris: readonly vscode.Uri[], token?: vscode.CancellationToken): void {
    const active = this.active;
    if (!active || active.scope !== 'project' || (token && (active.token !== token || token.isCancellationRequested))) { return; }
    for (const uri of uris) { active.dependencies.add(Workspace.uriKey(uri)); }
    this.watchDirectories(uris.filter(uri => uri.scheme === 'file').map(uri => vscode.Uri.file(path.dirname(uri.fsPath))), token);
  }

  watchDirectories(directories: readonly vscode.Uri[], token?: vscode.CancellationToken): void {
    const active = this.active;
    if (!active || active.scope !== 'project' || (token && (active.token !== token || token.isCancellationRequested))) { return; }
    for (const directory of directories) {
      if (directory.scheme !== 'file') { continue; }
      const key = Workspace.uriKey(directory);
      if (active.watches.has(key)) { continue; }
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(directory, '*'));
      const invalidate = () => { if (this.active === active) { this.invalidate(); } };
      active.watches.set(key, vscode.Disposable.from(watcher,
        watcher.onDidChange(uri => {
          if (active.dependencies.has(Workspace.uriKey(uri)) || path.extname(uri.path).toLowerCase() === '.tex') { invalidate(); }
        }), watcher.onDidCreate(invalidate), watcher.onDidDelete(invalidate)));
    }
  }

  invalidate(): void {
    const active = this.active;
    this.active = undefined;
    if (!active) { return; }
    active.cancellation.cancel();
    active.cancellation.dispose();
    for (const watch of active.watches.values()) { watch.dispose(); }
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
    for (const subscription of this.subscriptions) { subscription.dispose(); }
  }

  private changed(event: vscode.TextDocumentChangeEvent): void {
    const active = this.active;
    if (!active || event.contentChanges.length === 0) { return; }
    if (event.document !== active.document) {
      if (active.scope === 'project') { this.invalidate(); }
      return;
    }
    let delta = 0;
    for (const change of event.contentChanges) {
      if (change.rangeOffset < active.start || change.rangeOffset + change.rangeLength > active.end
        || /[\r\n\\%{}\[\],]/.test(change.text)) {
        this.invalidate();
        return;
      }
      delta += change.text.length - change.rangeLength;
    }
    active.end += delta;
    active.version = event.document.version;
  }
}
