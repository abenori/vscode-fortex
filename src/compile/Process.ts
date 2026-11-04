import * as spawn from 'cross-spawn';
import * as vscode from 'vscode';
import type { ChildProcess } from 'child_process';
import Log from '../log';

/** 外部プログラムの1回の実行と，キャンセル・停止の再試行・終了確認を管理する． */
export default class Process {
  /** 停止確認を待つ時間の上限．単位はミリ秒． */
  private static readonly stopTimeoutMilliseconds = 5000;
  /** 起動後，closeイベントをまだ受信していない外部プロセスの集合． */
  private static readonly running = new Set<Process>();
  /** 実行ファイルへ個別に渡す追加引数．シェル用の引用符は加えない． */
  private readonly args: readonly string[];
  /** 起動した子プロセス．未起動なら未設定． */
  private child?: ChildProcess;
  /** 起動処理を一度でも開始した場合はtrue． */
  private started = false;
  /** 子プロセスのcloseイベントを受信した場合はtrue． */
  private finished = false;
  /** 要求がキャンセルされたことを表す値． */
  private cancelled = false;
  /** 現在進行中の停止要求．同時の停止操作はこのPromiseを共有する． */
  private stopping?: Promise<void>;
  /** 起動した子プロセスのclose通知後に完了するPromise． */
  private readonly closed: Promise<void>;
  /** 子プロセスのcloseイベントで終了確認Promiseを完了させる関数． */
  private resolveClosed!: () => void;

  /**
   * プロセスを起動・登録せず，変更されない実行コマンドを保存する．
   * @param command 起動する実行ファイル名またはパス．
   * @param args 呼び出し先へ渡す引数．
   * @param directory 外部コマンドの作業ディレクトリのパス．nullなら現在の作業場所を使う．
   * @returns 新しいインスタンス．コンストラクタから明示的な値は返さない．
   */
  public constructor(/** 対象のコマンド名または実行ファイル名． */ private readonly command: string, args: readonly string[], /** 外部プログラムの作業ディレクトリ．nullなら既定の作業場所を使用する． */ private readonly directory: string | null) {
    this.args = [...args];
    this.closed = new Promise<void>(resolve => { this.resolveClosed = resolve; });
  }

  /**
   * 管理中のプログラムへ停止を要求する．まだ終了していないものは保持し，停止失敗を報告する．
   * 引数はない．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
  public static async killAll(): Promise<void> {
    const running = [...Process.running];
    await Promise.all(running.map(entry => entry.kill()));
  }

  /**
   * 未起動なら起動を禁止する．停止中の要求を共有し，子プロセスが終了するまでは停止を再試行できる．
   * 引数はない．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
  public kill(): Promise<void> {
    if (this.finished) { return Promise.resolve(); }
    this.cancelled = true;
    if (!this.child) { return Promise.resolve(); }
    if (this.stopping) { return this.stopping; }
    this.stopping = Process.stopAndWait(this.child, this.closed).finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  /**
   * 一度だけ起動し，停止要求が失敗してもclose通知を受けるまでは実行結果を確定しない．
   * @param token 要求のキャンセルを確認するトークン．省略可能．
   * @returns 終了コード．シグナル終了などでコードが得られない場合はnull．Promiseで返す．
   */
  public async execute(token?: vscode.CancellationToken): Promise<number | null> {
    if (this.started) { throw new Error('A Process instance can only be executed once.'); }
    this.started = true;
    if (this.cancelled || token?.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    Log.debug_log(`Executing process: ${this.command} ${this.args.join(' ')}${this.directory ? ` in directory ${this.directory}` : ''}`);
    return new Promise<number | null>((resolve, reject) => {
      const child = spawn.spawn(this.command, [...this.args], {
        stdio: ['ignore', 'pipe', 'pipe'], shell: false, cwd: this.directory || undefined,
        windowsHide: true, detached: process.platform !== 'win32'
      });
      this.child = child;
      Process.running.add(this);
      let error: Error | undefined;
      let cancellation: vscode.Disposable | undefined;
      child.stdout?.on('data', data => Process.writeOutput(data.toString()));
      child.stderr?.on('data', data => Process.writeOutput(data.toString()));
      child.on('error', value => { error = value; });
      child.on('close', code => {
        if (this.finished) { return; }
        this.finished = true;
        cancellation?.dispose();
        Process.running.delete(this);
        this.child = undefined;
        this.resolveClosed();
        Process.writeOutput('\n');
        if (this.cancelled) { reject(new vscode.CancellationError()); }
        else if (error) { reject(error); }
        else { resolve(code); }
      });
      const requestStop = () => {
        void this.kill().catch(error => {
          if (!this.finished) { Process.writeOutput(`Unable to stop process: ${String(error)}\n`); }
        });
      };
      cancellation = token?.onCancellationRequested(requestStop);
      if (token?.isCancellationRequested) { requestStop(); }
    });
  }

  /**
   * 終了処理中に出力チャンネルが破棄されても，プロセスの後始末を続けられるようにする．
   * @param message 表示または記録するメッセージ．
   * @returns なし．
   */
  private static writeOutput(message: string): void {
    try { Log.process_message(message); } catch {}
  }

  /**
   * 停止と終了確認の待機時間を制限し，試行ごとにtaskkillの補助プロセスを片付ける．
   * @param child 停止または監視する子プロセス．
   * @param closed 子プロセスのclose通知後に完了するPromise．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
  private static async stopAndWait(child: ChildProcess, closed: Promise<void>): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([Process.terminateTree(child, controller.signal), closed]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Process${child.pid ? ` ${child.pid}` : ''} termination was not confirmed within 5 seconds.`)),
            Process.stopTimeoutMilliseconds);
        })
      ]);
    } finally {
      if (timer) { clearTimeout(timer); }
      controller.abort();
    }
  }

  /**
   * 代替として子プロセスへ直接停止シグナルを送り，要求が拒否された場合は無期限に待たず失敗を報告する．
   * @param child 停止または監視する子プロセス．
   * @returns なし．
   */
  private static killChild(child: ChildProcess): void {
    if (!child.kill() && typeof child.exitCode !== 'number' && typeof child.signalCode !== 'string') {
      throw new Error('The process rejected the termination request.');
    }
  }

  /**
   * 起動したプロセスツリーを終了する．OSのエラーを返し，中断シグナルは補助プロセスだけに適用する．
   * @param child 停止または監視する子プロセス．
   * @param signal 終了要求を中断するためのAbortSignal．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
  private static async terminateTree(child: ChildProcess, signal: AbortSignal): Promise<void> {
    if (child.pid && process.platform === 'win32') {
      await new Promise<void>((resolve, reject) => {
        let killer: ChildProcess | undefined;
        let settled = false;
        let detail = '';
        const finish = (error?: Error) => {
          if (settled) { return; }
          settled = true;
          signal.removeEventListener('abort', abort);
          if (error) { reject(error); } else { resolve(); }
        };
        const abort = () => {
          if (settled) { return; }
          finish();
          try { killer?.kill(); } catch {}
        };
        const fallback = (error: unknown) => {
          if (settled) { return; }
          Process.writeOutput(`Process tree termination failed; trying direct-child termination: ${String(error)}\n`);
          try { Process.killChild(child); finish(); }
          catch (fallbackError) { finish(new Error(`${String(error)}; fallback failed: ${String(fallbackError)}`)); }
        };
        signal.addEventListener('abort', abort, { once: true });
        try {
          killer = spawn.spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true
          });
          killer.stderr?.on('data', data => { detail = (detail + String(data)).slice(-4096); });
          killer.on('error', fallback);
          killer.on('close', code => {
            if (code === 0) { finish(); }
            else { fallback(new Error(`taskkill.exe exited with code ${code}${detail.trim() ? `: ${detail.trim()}` : ''}`)); }
          });
        } catch (error) { fallback(error); }
      });
    } else {
      try {
        if (child.pid) { process.kill(-child.pid, 'SIGKILL'); }
        else { Process.killChild(child); }
      } catch (error) {
        if (!child.pid) { throw error; }
        try { Process.killChild(child); }
        catch (fallbackError) { throw new Error(`${String(error)}; fallback failed: ${String(fallbackError)}`); }
      }
    }
  }
}
