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
  stopError?: string;
  stopping?: Promise<void>;
  done: Promise<BuildResult>;
}
interface LastResult {
  readonly id: number;
  readonly request: BuildRequest;
  readonly target: vscode.Uri;
  readonly time: Date;
  readonly result: BuildResult;
  transientVisible: boolean;
  notice?: BuildNotice;
}

/** Owns request lifetime and generic reports, without knowing individual build stages. */
export default class BuildManager implements vscode.Disposable {
  private static readonly stopTimeoutMilliseconds = 5000;
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
        if (session.notice?.severity === notice?.severity && session.notice?.message === notice?.message) { return; }
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
        time: new Date(), result, transientVisible: true, notice: session.notice };
      this.scheduleResultExpiry(this.last);
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

  /** Updates progress or results, giving an unconfirmed stop priority over brief hints. */
  private updateStatusBar(): void {
    if (this.disposed) { return; }
    if (this.active) {
      const stopError = this.active.stopError;
      this.setStatusBarDisplay(stopError ? 'error' : 'sync~spin', stopError ? 'Stop not confirmed' : this.hint ?? this.active.progress,
        stopError ? `${stopError}\nUse the stop action to retry. New builds remain disabled until this build finishes.`
          : this.active.progress + (this.pending.size ? '\nA saved update is waiting to be built.' : ''),
        this.active.target, stopError ? 'error' : undefined, this.pending.size > 0);
    } else if (this.last) { this.showResult(this.last); }
    else { this.setStatusBarDisplay('file-code', this.hint ?? '', this.hint ?? 'Build saved sources or inspect build actions.'); }
  }

  /** Displays a finished result without restarting its original visibility period. */
  private showResult(last: LastResult): void {
    if (this.disposed || this.last !== last) { return; }
    const result = last.result;
    const severity = result.severity === 'error' || last.notice?.severity === 'error' ? 'error'
      : result.severity === 'warning' || last.notice?.severity === 'warning' ? 'warning' : 'info';
    const label = result.outcome === 'cancelled' ? 'Cancelled'
      : result.outcome === 'failed' ? 'Failed' : severity === 'warning' ? 'Completed with warnings' : 'Succeeded';
    const icon = result.outcome === 'cancelled' ? 'debug-stop'
      : severity === 'error' ? 'error' : severity === 'warning' ? 'warning' : 'check';
    const detail = `${result.message}${last.notice ? `\n${last.notice.message}` : ''}\n${last.time.toLocaleString()}\nResult for saved sources.`;
    const visible = last.transientVisible || (severity !== 'info' && result.outcome !== 'cancelled');
    this.setStatusBarDisplay(visible ? icon : 'file-code', this.hint ?? (visible ? label : ''), detail,
      last.target, visible ? severity : undefined);
  }

  /** Starts the completion timer once, allowing later warnings to outlive the underlying success label. */
  private scheduleResultExpiry(last: LastResult): void {
    if (last.result.severity !== 'info' && last.result.outcome !== 'cancelled') { return; }
    const version = this.displayVersion;
    this.timer = setTimeout(() => {
      if (this.disposed || this.displayVersion !== version || this.last !== last) { return; }
      this.timer = undefined;
      last.transientVisible = false;
      this.updateStatusBar();
    }, 3000);
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

  /** Cancels work and coalesces stop attempts while retaining the build lock until actual completion. */
  public async stop(): Promise<void> {
    this.pending.clear();
    const session = this.active;
    if (!session || this.disposed) { return; }
    if (session.stopping) { return session.stopping; }
    this.clearTimers();
    session.stopError = undefined;
    session.cancellation.cancel();
    session.progress = 'Stopping…';
    this.updateStatusBar();
    session.stopping = this.stopSession(session).finally(() => { session.stopping = undefined; });
    await session.stopping;
  }

  /** Reports a failed stop separately from the still-running producer, permitting an explicit retry. */
  private async stopSession(session: Session): Promise<void> {
    try { await this.waitForStop(session); }
    catch (error) {
      if (this.disposed || this.active !== session) { return; }
      session.stopError = error instanceof Error ? error.message : String(error);
      Log.error(`Unable to stop build: ${session.stopError}`);
      this.updateStatusBar();
    }
  }

  /** Bounds the stop operation without settling or releasing ownership of the producer itself. */
  private async waitForStop(session?: Session): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([Process.killAll(), session?.done]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Build termination was not confirmed within 5 seconds.')),
            BuildManager.stopTimeoutMilliseconds);
        })
      ]);
    } finally { if (timer) { clearTimeout(timer); } }
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
    if (this.active) {
      actions.unshift({ label: this.active.stopError ? '$(debug-stop) Retry stopping build' : '$(debug-stop) Stop build', action: 'stop' });
    }
    else if (this.last) { actions.push({ label: '$(refresh) Rebuild saved sources', action: 'rebuild' }); }
    const choice = await vscode.window.showQuickPick(actions, {
      placeHolder: this.active?.stopError ?? this.active?.progress ?? this.last?.result.message ?? 'Build actions'
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

  /** Attempts bounded process shutdown before waiting on work that may otherwise never return. */
  public async shutdown(): Promise<void> {
    const session = this.active;
    this.dispose();
    try { await this.waitForStop(session); }
    catch (error) { Log.error(`Unable to stop build during shutdown: ${String(error)}`); }
  }
}
