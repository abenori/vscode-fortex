import * as spawn from 'cross-spawn';
import * as vscode from 'vscode';
import type { ChildProcess } from 'child_process';
import Log from '../log';

interface RunningProcess {
  readonly child: ChildProcess;
  readonly closed: Promise<void>;
  stop(): void;
}

/** Executes external tools without interpreting their role in a build. */
export default class Process {
  private static readonly running = new Set<RunningProcess>();
  private static lifetime = 0;
  private active?: RunningProcess;
  private version = 0;

  /** Exposes the current child for inspection without transferring ownership. */
  public get process(): ChildProcess | undefined { return this.active?.child; }

  /** Stops tracked tools and waits until their streams and exit events have closed. */
  public static async killAll(): Promise<void> {
    Process.lifetime++;
    const running = [...Process.running];
    for (const entry of running) { entry.stop(); }
    await Promise.all(running.map(entry => entry.closed));
  }

  /** Cancels this instance, including a replacement command waiting to start. */
  public async kill(): Promise<void> {
    this.version++;
    await this.stopActive();
  }

  /** Stops the previous child before a replacement is allowed to launch. */
  private async stopActive(): Promise<void> {
    const entry = this.active;
    if (entry) { entry.stop(); await entry.closed; }
  }

  /** Runs one tool; cancellation rejects only after its child has actually closed. */
  public async execute(cmd: string, options: string[], dir: string | null, shell: boolean,
    token?: vscode.CancellationToken): Promise<number | null> {
    const version = ++this.version;
    const lifetime = Process.lifetime;
    await this.stopActive();
    if (version !== this.version || lifetime !== Process.lifetime || token?.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    Log.debug_log(`Executing process: ${cmd} ${options.join(' ')}${dir ? ` in directory ${dir}` : ''}`);
    return new Promise<number | null>((resolve, reject) => {
      const child = spawn.spawn(cmd, options, {
        stdio: ['ignore', 'pipe', 'pipe'], shell, cwd: dir || undefined,
        windowsHide: true, detached: process.platform !== 'win32'
      });
      let cancelled = false;
      let finished = false;
      let error: Error | undefined;
      let close!: () => void;
      const closed = new Promise<void>(done => { close = done; });
      const entry: RunningProcess = {
        child, closed,
        // Capture this child: a late event must never affect its replacement.
        stop: () => {
          if (finished || cancelled) { return; }
          cancelled = true;
          Process.terminateTree(child);
        }
      };
      this.active = entry;
      Process.running.add(entry);
      const cancellation = token?.onCancellationRequested(() => entry.stop());
      if (token?.isCancellationRequested) { entry.stop(); }
      child.stdout?.on('data', data => Process.writeOutput(data.toString()));
      child.stderr?.on('data', data => Process.writeOutput(data.toString()));
      child.on('error', value => { error = value; });
      child.on('close', code => {
        if (finished) { return; }
        finished = true;
        cancellation?.dispose();
        Process.running.delete(entry);
        if (this.active === entry) { this.active = undefined; }
        close();
        Process.writeOutput('\n');
        if (cancelled) { reject(new vscode.CancellationError()); }
        else if (error) { reject(error); }
        else { resolve(code); }
      });
    });
  }

  /** Keeps output-channel disposal from interrupting process cleanup during shutdown. */
  private static writeOutput(message: string): void {
    try { Log.process_message(message); } catch {}
  }

  /** Terminates only the launched process tree, using a private process group on POSIX. */
  private static terminateTree(child: ChildProcess): void {
    if (child.pid && process.platform === 'win32') {
      try {
        const killer = spawn.spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore', windowsHide: true
        });
        killer.on('error', () => { try { child.kill(); } catch {} });
        killer.on('close', code => { if (code !== 0) { try { child.kill(); } catch {} } });
      } catch { try { child.kill(); } catch {} }
    } else {
      try {
        if (child.pid) { process.kill(-child.pid, 'SIGKILL'); }
        else { child.kill(); }
      } catch { try { child.kill(); } catch {} }
    }
  }
}
