import * as path from 'path';
import * as ChildProcess from 'child_process';
import * as spawn from 'cross-spawn';
import * as vscode from 'vscode';
import Config from '../Config';
import { uriKey } from '../workspace';

interface Lookup {
  readonly promise: Promise<vscode.Uri | undefined>;
  readonly paths: Set<string>;
}

interface DirectoryWatch {
  readonly disposable: vscode.Disposable;
  readonly files: Map<string, Set<string>>;
}

/** Returns the executable name used for backend selection and Kpathsea's program context. */
export function programName(command: string): string {
  return path.posix.basename(command.replace(/\\/g, '/')).replace(/\.(exe|com|cmd|bat)$/i, '').toLowerCase();
}

/** Shares Kpathsea lookups, existence watches and lifecycle across all consumers. */
export default class KpsewhichResolver {
  private static readonly cache = new Map<string, Lookup>();
  private static readonly watches = new Map<string, DirectoryWatch>();
  private static readonly processes = new Set<ChildProcess.ChildProcess>();
  private static configuration?: vscode.Disposable;
  private static generation = 0;

  /** Registers configuration invalidation once, including when first used outside activation. */
  public static initialize(): void {
    this.configuration ??= vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('vscode-fortex.kpsewhich.path')) { this.clear(); }
    });
  }

  /** Reuses per-name promises and batches all uncached names into a single process. */
  public static resolve(texUri: vscode.Uri, references: readonly string[], program = 'bibtex'):
    Promise<readonly (vscode.Uri | undefined)[]> {
    if (!vscode.workspace.isTrusted || texUri.scheme !== 'file' || references.length === 0) {
      return Promise.resolve(references.map(() => undefined));
    }
    this.initialize();
    const cwd = path.dirname(texUri.fsPath);
    const executable = Config.kpsewhichPath().trim() || 'kpsewhich';
    const context = programName(program);
    const keyFor = (name: string) => JSON.stringify([executable, cwd, context, name]);
    const missing = [...new Set(references)].filter(name => !this.cache.has(keyFor(name)));
    if (missing.length) {
      // Start after registering every promise/watch, so concurrent callers share the batch.
      const generation = this.generation;
      const batch = Promise.resolve().then(() => generation === this.generation
        ? this.run(executable, cwd, missing, context) : missing.map(() => undefined));
      missing.forEach((name, index) => {
        const key = keyFor(name);
        const entry: Lookup = { paths: new Set(), promise: batch.then(results => {
          const result = results[index];
          if (result && this.cache.get(key) === entry) { this.watch(key, result); }
          return result;
        }) };
        this.cache.set(key, entry);
        this.watch(key, vscode.Uri.file(path.resolve(cwd, name)));
      });
    }
    return Promise.all(references.map(name => this.cache.get(keyFor(name))!.promise));
  }

  /** Discards lookup results and their watches without starting any new search. */
  public static clear(): void {
    this.generation++;
    this.cache.clear();
    for (const watch of this.watches.values()) { watch.disposable.dispose(); }
    this.watches.clear();
  }

  /** Releases global listeners, existence watches and outstanding helper processes. */
  public static dispose(): void {
    this.configuration?.dispose();
    this.configuration = undefined;
    this.clear();
    for (const child of this.processes) { child.kill(); }
  }

  /** Shares nonrecursive parent watches and associates exact paths with affected lookup keys. */
  private static watch(key: string, uri: vscode.Uri): void {
    const entry = this.cache.get(key);
    if (!entry) { return; }
    const fileKey = uriKey(uri);
    if (entry.paths.has(fileKey)) { return; }
    const directory = vscode.Uri.joinPath(uri, '..');
    const directoryKey = uriKey(directory);
    let watch = this.watches.get(directoryKey);
    if (!watch) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(directory, '*'), false, true, false);
      const files = new Map<string, Set<string>>();
      const changed = (changedUri: vscode.Uri) => {
        for (const affected of [...(files.get(uriKey(changedUri)) ?? [])]) { this.remove(affected); }
      };
      watch = { files, disposable: vscode.Disposable.from(watcher,
        watcher.onDidCreate(changed), watcher.onDidDelete(changed)) };
      this.watches.set(directoryKey, watch);
    }
    const keys = watch.files.get(fileKey) ?? new Set<string>();
    keys.add(key);
    watch.files.set(fileKey, keys);
    entry.paths.add(fileKey);
  }

  /** Removes one result and releases directory watchers once no cached result uses them. */
  private static remove(key: string): void {
    const entry = this.cache.get(key);
    if (!entry) { return; }
    this.cache.delete(key);
    for (const [directory, watch] of this.watches) {
      for (const file of entry.paths) {
        const keys = watch.files.get(file);
        keys?.delete(key);
        if (keys?.size === 0) { watch.files.delete(file); }
      }
      if (watch.files.size === 0) {
        watch.disposable.dispose();
        this.watches.delete(directory);
      }
    }
  }

  /** Runs suffix-aware searches for both .bib and .bst while retaining positional misses. */
  private static run(executable: string, cwd: string, references: readonly string[], program: string):
    Promise<readonly (vscode.Uri | undefined)[]> {
    return new Promise(resolve => {
      const child = spawn.spawn(executable, [`--progname=${program}`, ...references], {
        cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
      });
      this.processes.add(child);
      const output: Buffer[] = [];
      let settled = false;
      /** Settles a helper exactly once and releases its timeout/process registration. */
      const finish = (result: readonly (vscode.Uri | undefined)[]) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timeout);
        this.processes.delete(child);
        resolve(result);
      };
      const timeout = setTimeout(() => {
        child.kill();
        finish(references.map(() => undefined));
      }, 5000);
      child.stdout?.on('data', (chunk: Buffer) => output.push(chunk));
      child.once('error', () => finish(references.map(() => undefined)));
      child.once('close', () => finish(this.parseOutput(Buffer.concat(output).toString('utf8'), references.length)
        .map(result => result ? vscode.Uri.file(path.resolve(cwd, result)) : undefined)));
    });
  }

  /** Preserves empty output lines, which represent unresolved arguments in a batch. */
  private static parseOutput(output: string, expectedResults: number): (string | undefined)[] {
    const lines = output.replace(/\r/g, '').split('\n');
    if (lines.length > expectedResults && lines[lines.length - 1] === '') { lines.pop(); }
    return Array.from({ length: expectedResults }, (_, index) => lines[index]?.trim() || undefined);
  }
}
