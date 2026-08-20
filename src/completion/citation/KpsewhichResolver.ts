import * as path from 'path';
import * as ChildProcess from 'child_process';
import * as spawn from 'cross-spawn';
import * as vscode from 'vscode';
import Config from '../../Config';

const lookupTimeoutMilliseconds = 5000;

/** Resolves bibliography names through the same Kpathsea search used by TeX. */
export default class KpsewhichResolver implements vscode.Disposable {
  private readonly cache = new Map<string, Promise<readonly (vscode.Uri | undefined)[]>>();
  private readonly processes = new Set<ChildProcess.ChildProcess>();

  public resolve(texUri: vscode.Uri, references: readonly string[]): Promise<readonly (vscode.Uri | undefined)[]> {
    // Citation completion itself remains available in Restricted Mode, but it
    // must not start kpsewhich automatically. The caller can still fall back to
    // bibliography paths resolved directly from the project directory.
    if (!vscode.workspace.isTrusted || texUri.scheme !== 'file' || references.length === 0) {
      return Promise.resolve(references.map(() => undefined));
    }

    const cwd = path.dirname(texUri.fsPath);
    const executable = Config.kpsewhichPath().trim() || 'kpsewhich';
    const cacheKey = JSON.stringify([executable, cwd, references]);
    let lookup = this.cache.get(cacheKey);
    if (!lookup) {
      lookup = this.run(executable, cwd, references);
      this.cache.set(cacheKey, lookup);
    }
    return lookup;
  }

  public clear(): void {
    this.cache.clear();
  }

  public dispose(): void {
    this.cache.clear();
    for (const process of this.processes) {
      process.kill();
    }
    this.processes.clear();
  }

  private run(executable: string, cwd: string, references: readonly string[]): Promise<readonly (vscode.Uri | undefined)[]> {
    // kpsewhich emits one output line per argument, including blank lines for
    // misses. Preserve positional correspondence with the requested references.
    return new Promise((resolve) => {
      const child = spawn.spawn(executable, ['--format=bib', ...references], {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      this.processes.add(child);

      const output: Buffer[] = [];
      let settled = false;
      const finish = (result: readonly (vscode.Uri | undefined)[]) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        this.processes.delete(child);
        resolve(result);
      };
      const timeout = setTimeout(() => {
        child.kill();
        finish(references.map(() => undefined));
      }, lookupTimeoutMilliseconds);

      child.stdout?.on('data', (chunk: Buffer) => output.push(chunk));
      child.once('error', () => finish(references.map(() => undefined)));
      child.once('close', () => {
        const paths = parseKpsewhichOutput(Buffer.concat(output).toString('utf8'), references.length);
        finish(paths.map((result) => result ? vscode.Uri.file(path.resolve(cwd, result)) : undefined));
      });
    });
  }
}

export function parseKpsewhichOutput(output: string, expectedResults: number): (string | undefined)[] {
  // Remove only the final process newline; internal blank lines represent files
  // that Kpathsea could not resolve and must remain in the result array.
  const lines = output.replace(/\r/g, '').split('\n');
  if (lines.length > expectedResults && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return Array.from({ length: expectedResults }, (_, index) => lines[index]?.trim() || undefined);
}
