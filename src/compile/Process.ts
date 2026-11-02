import * as spawn from 'cross-spawn';
import * as vscode from 'vscode';
import type { ChildProcess } from 'child_process';
import Log from '../log';

/** Owns one external-tool execution, including cancellation, termination retries and close confirmation. */
export default class Process {
  private static readonly stopTimeoutMilliseconds = 5000;
  private static readonly running = new Set<Process>();
  private readonly args: readonly string[];
  private child?: ChildProcess;
  private started = false;
  private finished = false;
  private cancelled = false;
  private stopping?: Promise<void>;
  private readonly closed: Promise<void>;
  private resolveClosed!: () => void;

  /** Stores an immutable command snapshot without starting or registering a process. */
  public constructor(private readonly command: string, args: readonly string[], private readonly directory: string | null) {
    this.args = [...args];
    this.closed = new Promise<void>(resolve => { this.resolveClosed = resolve; });
  }

  /** Requests tracked tools to stop, reporting failure while retaining any tools that have not closed. */
  public static async killAll(): Promise<void> {
    const running = [...Process.running];
    await Promise.all(running.map(entry => entry.kill()));
  }

  /** Prevents an unstarted launch, shares an active stop and permits retries until the child has closed. */
  public kill(): Promise<void> {
    if (this.finished) { return Promise.resolve(); }
    this.cancelled = true;
    if (!this.child) { return Promise.resolve(); }
    if (this.stopping) { return this.stopping; }
    this.stopping = Process.stopAndWait(this.child, this.closed).finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  /** Starts exactly once; launched executions settle only after close, even when a stop attempt fails. */
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
      /** Handles cancellation-listener failures without rejecting the execution before actual close. */
      const requestStop = () => {
        void this.kill().catch(error => {
          if (!this.finished) { Process.writeOutput(`Unable to stop process: ${String(error)}\n`); }
        });
      };
      cancellation = token?.onCancellationRequested(requestStop);
      if (token?.isCancellationRequested) { requestStop(); }
    });
  }

  /** Keeps output-channel disposal from interrupting process cleanup during shutdown. */
  private static writeOutput(message: string): void {
    try { Log.process_message(message); } catch {}
  }

  /** Bounds termination and close confirmation, cleaning up the taskkill helper after each attempt. */
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

  /** Sends a direct fallback signal and reports a refused request instead of silently waiting forever. */
  private static killChild(child: ChildProcess): void {
    if (!child.kill() && typeof child.exitCode !== 'number' && typeof child.signalCode !== 'string') {
      throw new Error('The process rejected the termination request.');
    }
  }

  /** Terminates the launched tree, returning OS errors and observing abort only for the helper process. */
  private static async terminateTree(child: ChildProcess, signal: AbortSignal): Promise<void> {
    if (child.pid && process.platform === 'win32') {
      await new Promise<void>((resolve, reject) => {
        let killer: ChildProcess | undefined;
        let settled = false;
        let detail = '';
        /** Settles the helper once; later error/close events must not launch another fallback. */
        const finish = (error?: Error) => {
          if (settled) { return; }
          settled = true;
          signal.removeEventListener('abort', abort);
          if (error) { reject(error); } else { resolve(); }
        };
        /** Stops only the taskkill helper when the enclosing stop attempt has already finished. */
        const abort = () => {
          if (settled) { return; }
          finish();
          try { killer?.kill(); } catch {}
        };
        /** Tries the existing direct-child fallback and preserves both failure explanations. */
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
