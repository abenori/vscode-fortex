import * as ChildProcess from 'child_process';
import * as path from 'path';
import * as spawn from 'cross-spawn';
import * as vscode from 'vscode';
import Config from '../Config';
import { assertWorkspaceTrusted } from '../WorkspaceTrust';

const searchTimeoutMilliseconds = 15000;
const maximumOutputBytes = 2 * 1024 * 1024;

export interface TexdocEntry {
  query: string;
  score: number;
  filePath: string;
  language?: string;
  description?: string;
}

/** Parses texdoc's tab-separated machine format without changing its ranking. */
export function parseTexdocOutput(output: string): TexdocEntry[] {
  const entries: TexdocEntry[] = [];
  for (const [index, line] of output.split(/\r?\n/).entries()) {
    if (!line.trim()) {
      continue;
    }
    const [query, rawScore, filePath, language, description] = line.split('\t');
    if (!query?.trim() || !rawScore?.trim() || !Number.isFinite(Number(rawScore)) ||
      !filePath || !path.isAbsolute(filePath) || /[\0\r\n]/.test(filePath)) {
      throw new Error(`texdoc returned an invalid documentation list at line ${index + 1}. Check that vscode-fortex.texdoc.path points to TeX Live's texdoc.`);
    }
    // Only the first three columns are required. Metadata may be absent, and
    // later texdoc versions may append further columns.
    entries.push({
      query,
      score: Number(rawScore),
      filePath,
      language: language || undefined,
      description: description || undefined
    });
  }
  return entries;
}

/** Runs TeX Live's texdoc for lookup and lets its configuration choose a viewer. */
export default class TexdocService implements vscode.Disposable {
  private readonly processes = new Map<ChildProcess.ChildProcess, () => void>();
  private disposed = false;

  public async list(query: string, token?: vscode.CancellationToken): Promise<TexdocEntry[]> {
    if (!query.trim() || /[\0\r\n]/.test(query)) {
      throw new Error('Enter a documentation name on a single line.');
    }
    query = query.trim();
    const output = await this.run(['--list', '--machine', '--', query], true, token);
    return parseTexdocOutput(output);
  }

  public async open(filePath: string): Promise<void> {
    if (!path.isAbsolute(filePath) || /[\0\r\n]/.test(filePath)) {
      throw new Error('texdoc requires an absolute documentation file path.');
    }
    await this.run(['--nointeract', '--just-view', filePath], false);
  }

  public dispose(): void {
    this.disposed = true;
    for (const cancel of this.processes.values()) {
      cancel();
    }
    this.processes.clear();
  }

  private run(args: string[], searching: boolean, token?: vscode.CancellationToken): Promise<string> {
    assertWorkspaceTrusted('TeX documentation');
    if (this.disposed || token?.isCancellationRequested) {
      return Promise.reject(new vscode.CancellationError());
    }
    const executable = Config.texdocPath().trim() || 'texdoc';
    return new Promise((resolve, reject) => {
      let child: ChildProcess.ChildProcess;
      try {
        child = spawn.spawn(executable, args, {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (error) {
        reject(startError(error, executable));
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      let cancellation: vscode.Disposable | undefined;
      const finish = (error?: Error, output = '') => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        cancellation?.dispose();
        this.processes.delete(child);
        child.stdout?.removeListener('data', collectStdout);
        child.stderr?.removeListener('data', collectStderr);
        if (error) {
          reject(error);
        } else {
          resolve(output);
        }
      };
      const terminate = (error: Error) => {
        if (settled) {
          return;
        }
        finish(error);
        child.kill();
      };
      const collect = (buffers: Buffer[], chunk: Buffer | string) => {
        if (settled) {
          return;
        }
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += buffer.length;
        if (outputBytes > maximumOutputBytes) {
          terminate(new Error('texdoc returned too much output. Try a more specific documentation name.'));
          return;
        }
        buffers.push(buffer);
      };
      const collectStdout = (chunk: Buffer | string) => collect(stdout, chunk);
      const collectStderr = (chunk: Buffer | string) => collect(stderr, chunk);
      const cancel = () => terminate(new vscode.CancellationError());
      this.processes.set(child, cancel);
      child.stdout?.on('data', collectStdout);
      child.stderr?.on('data', collectStderr);
      child.once('error', (error) => finish(startError(error, executable)));
      child.once('close', (code, signal) => {
        if (code === 0) {
          finish(undefined, Buffer.concat(stdout).toString('utf8'));
        } else if (searching && code === 3) {
          // TeX Live reserves exit code 3 for a search with no documentation.
          finish();
        } else {
          const detail = Buffer.concat(stderr).toString('utf8').trim().slice(0, 2000);
          const reason = signal ? `signal ${signal}` : `exit code ${code}`;
          finish(new Error(`texdoc failed (${reason})${detail ? `: ${detail}` : '.'}`));
        }
      });
      // Viewing can wait for the external application to close, so only searches
      // have a deadline. Both operations can still be stopped on deactivation.
      if (searching) {
        timeout = setTimeout(() => {
          terminate(new Error('texdoc documentation search timed out after 15 seconds.'));
        }, searchTimeoutMilliseconds);
      }
      cancellation = token?.onCancellationRequested(cancel);
      if (settled) {
        cancellation?.dispose();
      } else if (token?.isCancellationRequested) {
        cancel();
      }
    });
  }
}

function startError(error: unknown, executable: string): Error {
  if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
    return new Error(`Cannot find texdoc (${executable}). Install TeX Live or set vscode-fortex.texdoc.path to its texdoc executable.`);
  }
  return new Error(`Cannot start texdoc (${executable}): ${error instanceof Error ? error.message : String(error)}`);
}
