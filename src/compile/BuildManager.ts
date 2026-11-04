import * as path from 'path';
import * as vscode from 'vscode';
import type { BuildContext, BuildNotice, BuildRequest, BuildResult } from './BuildProtocol';
import Process from './Process';
import Log from '../log';
import * as Workspace from '../workspace';

interface Session {
  /** 同じ所有者の処理または項目を識別する値． */
  readonly id: number;
  /** 対象ソースと実行処理を持つビルド要求． */
  readonly request: BuildRequest;
  /** 所有する処理へキャンセルを通知するトークンソース． */
  readonly cancellation: vscode.CancellationTokenSource;
  /** 現在のビルド段階を表示するメッセージ． */
  progress: string;
  /** 現在表示している処理対象のURI． */
  target: vscode.Uri;
  /** ビルドに付随する通知．通知がなければ未設定． */
  notice?: BuildNotice;
  /** 直前の停止要求が失敗した理由． */
  stopError?: string;
  /** 現在進行中の停止要求．同時の停止操作はこのPromiseを共有する． */
  stopping?: Promise<void>;
  /** 実行中のビルドが完了し，結果が確定するPromise． */
  done: Promise<BuildResult>;
}
interface LastResult {
  /** 同じ所有者の処理または項目を識別する値． */
  readonly id: number;
  /** 対象ソースと実行処理を持つビルド要求． */
  readonly request: BuildRequest;
  /** 現在表示している処理対象のURI． */
  readonly target: vscode.Uri;
  /** ビルドが完了した時刻． */
  readonly time: Date;
  /** 確定したビルドの成否と診断情報． */
  readonly result: BuildResult;
  /** 完了結果を一時的にステータス表示する期間内ならtrue． */
  transientVisible: boolean;
  /** ビルドに付随する通知．通知がなければ未設定． */
  notice?: BuildNotice;
}

/** 個々のビルド段階には依存せず，要求の有効期間と共通の通知を管理する． */
export default class BuildManager implements vscode.Disposable {
  /** 停止確認を待つ時間の上限．単位はミリ秒． */
  private static readonly stopTimeoutMilliseconds = 5000;
  /** 実行中の段階や最後の結果を表示するステータスバー項目． */
  private readonly status: vscode.StatusBarItem;
  /** Problemsへ公開する診断情報． */
  private readonly diagnostics: vscode.DiagnosticCollection;
  /** ビルドの対象キーごとに保持する診断スナップショット． */
  private readonly snapshots = new Map<string, NonNullable<BuildResult['diagnostics']>>();
  /** ソースURIの識別キーごとに最後の保存ビルド要求を保持する待機列． */
  private readonly pending = new Map<string, BuildRequest>();
  /** 現在実行中または共有中のセッション． */
  private active?: Session;
  /** 最後に完了したビルドの結果と表示状態． */
  private last?: LastResult;
  /** ビルド要求を順に識別する番号． */
  private latestId = 0;
  /** 通常の遅延実行または一時表示を終了するタイマー． */
  private timer?: ReturnType<typeof setTimeout>;
  /** 一時的な案内表示を終了するタイマー． */
  private hintTimer?: ReturnType<typeof setTimeout>;
  /** 実行を受け付けなかった理由などの一時的な案内． */
  private hint?: string;
  /** 古い案内タイマーの更新を無視するための世代番号． */
  private hintVersion = 0;
  /** 古い完了表示タイマーの更新を無視するための世代番号． */
  private displayVersion = 0;
  /** 所有するリソースを解放し，新しい要求を受け付けない場合はtrue． */
  private disposed = false;

  /**
   * テーマに対応するステータス表示と，所有する診断コレクションを作成する．
   * 引数はない．
   * @returns 新しいインスタンス．コンストラクタから明示的な値は返さない．
   */
  public constructor() {
    this.status = vscode.window.createStatusBarItem('fortex.build', vscode.StatusBarAlignment.Left, 20);
    this.status.name = 'fortex Build';
    this.status.command = 'vscode-fortex.buildActions';
    this.diagnostics = vscode.languages.createDiagnosticCollection('vscode-fortex');
    this.updateStatusBar();
  }

  /**
   * ビルド要求を受け付け，直ちに実行するか，ソースURIごとに保存要求をまとめて待機させる．
   * @param request 起点ソースのURI，表示名，および繰り返し実行可能なビルド処理．
   * @param origin manualは明示的な実行，saveは保存に伴う実行．省略時は'manual'．
   * @returns 実行された要求の結果．保存要求が待機列にまとめられた場合などはundefined．Promiseで返す．
   */
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

  /**
   * 非同期の探索中に別のビルドが始まらないよう，セッションを同期的に開始する．
   * @param request 起点ソースのURI，表示名，および繰り返し実行可能なビルド処理．
   * @returns 開始したビルドの完了結果．Promiseで返す．
   */
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

  /**
   * 要求内の処理段階には立ち入らず，1件の要求を監視して最終結果を公開する．
   * @param session 処理の状態を保持する現在のセッション．
   * @returns 実行した要求の成功・失敗・キャンセルの結果．Promiseで返す．
   */
  private async run(session: Session): Promise<BuildResult> {
    const context: BuildContext = {
      token: session.cancellation.token,
      reportProgress: (message, target) => {
        if (this.disposed || this.active !== session || context.token.isCancellationRequested) { return; }
        session.progress = message;
        if (target) { session.target = target; }
        this.updateStatusBar();
      },
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

  /**
   * 停止・破棄後の遅い完了を拒否する．キャンセル時はProblemsの既存の診断を保持する．
   * @param context キャンセルトークンと，ビルドの進捗・通知を受け取る関数．
   * @returns なし．
   */
  private checkCancellation(context: BuildContext): void {
    if (this.disposed || context.token.isCancellationRequested) { throw new vscode.CancellationError(); }
  }

  /**
   * 指定された診断グループだけを置き換え，同じエラーファイルを共有する他のグループも保持する．
   * @param snapshot 捕捉済みの解析結果または診断情報．
   * @returns なし．
   */
  private publishDiagnostics(snapshot: NonNullable<BuildResult['diagnostics']>): void {
    const key = Workspace.uriKey(snapshot.key);
    if (snapshot.entries.some(([, diagnostics]) => diagnostics.length)) { this.snapshots.set(key, snapshot); }
    else { this.snapshots.delete(key); }
    const grouped = new Map<string, {
      /** 対象ファイルのURI． */
      uri: vscode.Uri;
      /** Problemsへ公開する診断情報． */
      diagnostics: vscode.Diagnostic[]
    }>();
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

  /**
   * 進捗または結果を更新する．停止を確認できていない状態は一時的な案内より優先して表示する．
   * 引数はない．
   * @returns なし．
   */
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

  /**
   * 最初に設定した表示期間を延長せず，完了した結果を表示する．
   * @param last 最後に完了したビルドの結果と表示時刻．
   * @returns なし．
   */
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

  /**
   * 完了時のタイマーを一度だけ開始する．後から届いた警告は成功表示の終了後も残せる．
   * @param last 最後に完了したビルドの結果と表示時刻．
   * @returns なし．
   */
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

  /**
   * テーマの色を使い，ステータスバーの文字列・アイコン・ツールチップ・読み上げ用の名前を設定する．
   * @param icon ステータス表示のアイコン名．
   * @param label 表示用の短い名前．
   * @param detail 表示する補足説明．
   * @param target 処理または表示の対象．省略可能．
   * @param severity 情報・警告・エラーの通知種別．省略可能．
   * @param waiting 終了待ち状態として表示する場合はtrue．省略時はfalse．
   * @returns なし．
   */
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

  /**
   * 保存しているビルド結果を変えずに，実行を受け付けなかった理由を短時間表示する．
   * @param message 表示または記録するメッセージ．
   * @returns なし．
   */
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

  /**
   * ビルド状態の変更時や破棄時に表示タイマーを無効化し，一時的な案内を消す．
   * 引数はない．
   * @returns なし．
   */
  private clearTimers(): void {
    this.hintVersion++;
    this.displayVersion++;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.hintTimer) { clearTimeout(this.hintTimer); this.hintTimer = undefined; }
    this.hint = undefined;
  }

  /**
   * 実行状態をコマンドの有効条件へ反映する．実行時にも状態を検証する．
   * @param value 変換または検証する値．
   * @returns なし．
   */
  private setRunning(value: boolean): void {
    void vscode.commands.executeCommand('setContext', 'fortex.buildRunning', value).then(undefined, () => {});
  }

  /**
   * 処理をキャンセルして同時の停止要求をまとめる．実際の完了まではビルドの実行権を保持する．
   * 引数はない．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
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

  /**
   * 実行中の処理とは別に停止失敗を通知し，利用者が停止を再試行できるようにする．
   * @param session 処理の状態を保持する現在のセッション．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
  private async stopSession(session: Session): Promise<void> {
    try { await this.waitForStop(session); }
    catch (error) {
      if (this.disposed || this.active !== session) { return; }
      session.stopError = error instanceof Error ? error.message : String(error);
      Log.error(`Unable to stop build: ${session.stopError}`);
      this.updateStatusBar();
    }
  }

  /**
   * 実行中の処理自体を完了扱いにしたり実行権を解放したりせず，停止操作の待機時間を制限する．
   * @param session 処理の状態を保持する現在のセッション．省略可能．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
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

  /**
   * 利用者の明示的な操作で既存のProblemsビューを開く．
   * 引数はない．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
  public async showProblems(): Promise<void> {
    await vscode.commands.executeCommand('workbench.actions.view.problems');
  }

  /**
   * 常駐するポップアップを使わず，マウスとキーボードから同じ操作を選択できるようにする．
   * 引数はない．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
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

  /**
   * 新しい処理の受け付けを止め，非同期のキャンセル完了を待つ間にUIリソースを解放する．
   * 引数はない．
   * @returns なし．
   */
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

  /**
   * 終了しない可能性のある処理を待つ前に，時間制限付きで子プロセスの終了を試みる．
   * 引数はない．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
  public async shutdown(): Promise<void> {
    const session = this.active;
    this.dispose();
    try { await this.waitForStop(session); }
    catch (error) { Log.error(`Unable to stop build during shutdown: ${String(error)}`); }
  }
}
