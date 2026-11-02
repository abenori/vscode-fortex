import * as path from 'path';
import * as vscode from 'vscode';
import type { BuildContext, BuildNotice, BuildRequest, BuildResult } from './BuildProtocol';
import Process from './Process';
import Log from '../log';
import * as Workspace from '../workspace';

interface Session {
  readonly id: number;
  readonly request: BuildRequest;
  readonly cancellation: vscode.CancellationTokenSource;
  progress: string;
  target: vscode.Uri;
  notice?: BuildNotice;
  done: Promise<BuildResult>;
}
interface LastResult {
  readonly id: number;
  readonly request: BuildRequest;
  readonly target: vscode.Uri;
  readonly time: Date;
  readonly result: BuildResult;
  notice?: BuildNotice;
}

/** Owns request lifetime and generic reports, without knowing individual build stages. */
export default class BuildManager implements vscode.Disposable {
  private readonly status: vscode.StatusBarItem;
  private readonly diagnostics: vscode.DiagnosticCollection;
  private readonly snapshots = new Map<string, NonNullable<BuildResult['diagnostics']>>();
  private readonly pending = new Map<string, BuildRequest>();
  private active?: Session;
  private last?: LastResult;
  private latestId = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private hintTimer?: ReturnType<typeof setTimeout>;
  private hint?: string;
  private hintVersion = 0;
  private displayVersion = 0;
  private disposed = false;

  /** Creates the single themed status entry and the diagnostic collection it owns. */
  public constructor() {
    this.status = vscode.window.createStatusBarItem('fortex.build', vscode.StatusBarAlignment.Left, 20);
    this.status.name = 'fortex Build';
    this.status.command = 'vscode-fortex.buildActions';
    this.diagnostics = vscode.languages.createDiagnosticCollection('vscode-fortex');
    this.updateStatusBar();
  }

  /** Accepts build requests, reserving immediate execution or coalescing queued saves by source URI. */
  public async requestBuild(request: BuildRequest, origin: 'manual' | 'save' = 'manual'): Promise<BuildResult | undefined> {
    if (this.disposed) { return; }
    if (!vscode.workspace.isTrusted) {
      if (origin === 'manual') { this.showHint('Build disabled: workspace is not trusted.'); }
      return;
    }
    if (this.active) {
      if (this.active.cancellation.token.isCancellationRequested) {
        if (origin === 'manual') { this.showHint('The build is stopping.'); }
        return;
      }
      if (origin === 'save') {
        const key = Workspace.uriKey(request.source);
        this.pending.set(key, request);
        this.updateStatusBar();
      } else { this.showHint('A build is already running.'); }
      return;
    }
    return this.start(request);
  }

  /** Starts a session synchronously so asynchronous discovery cannot admit a second build. */
  private start(request: BuildRequest): Promise<BuildResult> {
    this.clearTimers();
    const session: Session = {
      id: ++this.latestId, request, target: request.source, cancellation: new vscode.CancellationTokenSource(),
      progress: 'Processing…', done: Promise.resolve({ outcome: 'cancelled', severity: 'info', message: 'Build cancelled.' })
    };
    this.active = session;
    this.setRunning(true);
    this.updateStatusBar();
    session.done = this.run(session).finally(() => {
      session.cancellation.dispose();
      if (this.active === session) { this.active = undefined; }
      this.setRunning(false);
      if (!this.disposed && this.pending.size) {
        const [key, request] = this.pending.entries().next().value!;
        this.pending.delete(key);
        void this.start(request);
      }
    });
    return session.done;
  }

  /** Monitors one opaque request and publishes its final snapshot without interpreting its stages. */
  private async run(session: Session): Promise<BuildResult> {
    const context: BuildContext = {
      token: session.cancellation.token,
      /** Shows progress only while this execution is still active. */
      reportProgress: (message, target) => {
        if (this.disposed || this.active !== session || context.token.isCancellationRequested) { return; }
        session.progress = message;
        if (target) { session.target = target; }
        this.updateStatusBar();
      },
      /** Accepts delayed notices only for the latest execution, including after its promise settles. */
      reportNotice: notice => {
        if (this.disposed || this.latestId !== session.id || context.token.isCancellationRequested) { return; }
        session.notice = notice;
        if (this.last?.id === session.id) {
          this.last.notice = notice;
          this.showResult(this.last);
        }
      }
    };
    Log.clear_process_message();
    let result: BuildResult;
    try {
      result = await session.request.execute(context);
      this.checkCancellation(context);
    } catch (error) {
      if (context.token.isCancellationRequested || error instanceof vscode.CancellationError) {
        result = { outcome: 'cancelled', severity: 'info', message: 'Build cancelled.' };
      } else {
        const message = error instanceof Error ? error.message : String(error);
        Log.error(message);
        result = { outcome: 'failed', severity: 'error', message };
      }
    }
    if (!this.disposed) {
      if (result.outcome !== 'cancelled' && result.diagnostics !== undefined) {
        this.publishDiagnostics(result.diagnostics);
      }
      this.clearTimers();
      this.last = { id: session.id, request: session.request, target: session.target,
        time: new Date(), result, notice: session.notice };
      this.showResult(this.last);
    }
    return result;
  }

  /** Rejects late completion after stop or disposal, retaining Problems on cancellation. */
  private checkCancellation(context: BuildContext): void {
    if (this.disposed || context.token.isCancellationRequested) { throw new vscode.CancellationError(); }
  }

  /** Replaces one opaque diagnostic group while retaining all other groups, including shared error files. */
  private publishDiagnostics(snapshot: NonNullable<BuildResult['diagnostics']>): void {
    const key = Workspace.uriKey(snapshot.key);
    if (snapshot.entries.some(([, diagnostics]) => diagnostics.length)) { this.snapshots.set(key, snapshot); }
    else { this.snapshots.delete(key); }
    const grouped = new Map<string, { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }>();
    for (const saved of this.snapshots.values()) {
      for (const [uri, entries] of saved.entries) {
        const groupKey = Workspace.uriKey(uri);
        const group = grouped.get(groupKey) ?? { uri, diagnostics: [] };
        for (const entry of entries) {
          const diagnostic = Object.assign(new vscode.Diagnostic(entry.range, entry.message, entry.severity), entry);
          diagnostic.source = 'fortex (' + saved.key.fsPath + '; last build)';
          group.diagnostics.push(diagnostic);
        }
        grouped.set(groupKey, group);
      }
    }
    this.diagnostics.clear();
    this.diagnostics.set([...grouped.values()].map(group => [group.uri, group.diagnostics]));
  }

  /** Updates the status bar from the current state, preserving progress while a brief hint is shown. */
  private updateStatusBar(): void {
    if (this.disposed) { return; }
    if (this.active) {
      this.setStatusBarDisplay('sync~spin', this.hint ?? this.active.progress,
        this.active.progress + (this.pending.size ? '\nA saved update is waiting to be built.' : ''),
        this.active.target, undefined, this.pending.size > 0);
    } else if (this.last) { this.showResult(this.last); }
    else { this.setStatusBarDisplay('file-code', this.hint ?? '', this.hint ?? 'Build saved sources or inspect build actions.'); }
  }

  /** Shows a finished result, with timers detached from the completed build promise. */
  private showResult(last: LastResult): void {
    if (this.disposed || this.last !== last) { return; }
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const version = ++this.displayVersion;
    const result = last.result;
    const severity = result.severity === 'error' || last.notice?.severity === 'error' ? 'error'
      : result.severity === 'warning' || last.notice?.severity === 'warning' ? 'warning' : 'info';
    const label = result.outcome === 'cancelled' ? 'Cancelled'
      : result.outcome === 'failed' ? 'Failed' : severity === 'warning' ? 'Completed with warnings' : 'Succeeded';
    const icon = result.outcome === 'cancelled' ? 'debug-stop'
      : severity === 'error' ? 'error' : severity === 'warning' ? 'warning' : 'check';
    const detail = `${result.message}${last.notice ? `\n${last.notice.message}` : ''}\n${last.time.toLocaleString()}\nResult for saved sources.`;
    this.setStatusBarDisplay(icon, this.hint ?? label, detail, last.target, severity);
    if (severity === 'info' || result.outcome === 'cancelled') {
      const id = this.latestId;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (this.disposed || this.latestId !== id || this.displayVersion !== version || this.last !== last || this.active) { return; }
        this.setStatusBarDisplay('file-code', '', detail, last.target);
      }, 3000);
    }
  }

  /** Sets status bar text, icons, tooltips and accessible labels using native theme colors. */
  private setStatusBarDisplay(icon: string, label: string, detail: string, target?: vscode.Uri,
    severity?: BuildNotice['severity'], waiting = false): void {
    const buildLabel = this.active?.request.label ?? this.last?.request.label ?? 'Build';
    const name = target ? path.basename(target.fsPath) : '';
    const shortLabel = Array.from(label).slice(0, 80).join('');
    this.status.text = `$(${icon}) ${buildLabel}${shortLabel ? `: ${shortLabel}` : ''}${name ? ` — ${name}` : ''}${waiting ? ' · Update waiting' : ''}`;
    this.status.tooltip = new vscode.MarkdownString().appendText(`${name ? `${name}\n${target!.fsPath}\n\n` : ''}${detail}\n\nClick for build actions.`);
    this.status.backgroundColor = severity === 'error' ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
    this.status.color = undefined;
    this.status.accessibilityInformation = { label: `${buildLabel} build. ${name}. ${label}. ${detail}` };
    this.status.show();
  }

  /** Displays an informational refusal briefly without changing the stored build result. */
  private showHint(message: string): void {
    if (this.hintTimer) { clearTimeout(this.hintTimer); }
    this.hint = message;
    const version = ++this.hintVersion;
    this.updateStatusBar();
    this.hintTimer = setTimeout(() => {
      if (version !== this.hintVersion) { return; }
      this.hintTimer = undefined;
      this.hint = undefined;
      this.updateStatusBar();
    }, 5000);
  }

  /** Invalidates display timers and clears transient hints on build state changes or disposal. */
  private clearTimers(): void {
    this.hintVersion++;
    this.displayVersion++;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.hintTimer) { clearTimeout(this.hintTimer); this.hintTimer = undefined; }
    this.hint = undefined;
  }

  /** Mirrors running state to command enablement; runtime checks remain authoritative. */
  private setRunning(value: boolean): void {
    void vscode.commands.executeCommand('setContext', 'fortex.buildRunning', value).then(undefined, () => {});
  }

  /** Clears transient hints and cancels work, retaining the lock until the producer returns. */
  public async stop(): Promise<void> {
    this.pending.clear();
    const session = this.active;
    if (!session) { return; }
    this.clearTimers();
    session.cancellation.cancel();
    session.progress = 'Stopping…';
    this.updateStatusBar();
    await session.done;
  }

  /** Opens the existing Problems view on explicit user request. */
  public async showProblems(): Promise<void> {
    await vscode.commands.executeCommand('workbench.actions.view.problems');
  }

  /** Offers the same actions to mouse and keyboard users without persistent popups. */
  public async showActions(): Promise<void> {
    const actions = [
      { label: '$(list-unordered) Show build problems', action: 'problems' },
      { label: '$(output) Show build output', action: 'output' }
    ];
    if (this.active) { actions.unshift({ label: '$(debug-stop) Stop build', action: 'stop' }); }
    else if (this.last) { actions.push({ label: '$(refresh) Rebuild saved sources', action: 'rebuild' }); }
    const choice = await vscode.window.showQuickPick(actions, {
      placeHolder: this.active?.progress ?? this.last?.result.message ?? 'Build actions'
    });
    if (choice?.action === 'stop') { await this.stop(); }
    else if (choice?.action === 'problems') { await this.showProblems(); }
    else if (choice?.action === 'output') { Log.show(); }
    else if (choice?.action === 'rebuild' && this.last) {
      const request = this.last.request;
      const document = await vscode.workspace.openTextDocument(request.source);
      await vscode.window.showTextDocument(document);
      await this.requestBuild(request);
    }
  }

  /** Prevents new work and releases UI resources while cancellation finishes asynchronously. */
  public dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    this.pending.clear();
    this.active?.cancellation.cancel();
    this.clearTimers();
    this.setRunning(false);
    this.status.dispose();
    this.diagnostics.dispose();
  }

  /** Lets VS Code await process shutdown without keeping any notification promise pending. */
  public async shutdown(): Promise<void> {
    const done = this.active?.done;
    this.dispose();
    await done;
    await Process.killAll();
  }
}
