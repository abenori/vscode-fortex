import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createRequire } from 'module';
import { runInThisContext } from 'vm';
import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import type KpsewhichResolver from '../project/KpsewhichResolver';

/** Supplies controllable existence notifications without observing the real filesystem. */
class LookupWatcher {
  readonly created = new vscode.EventEmitter<vscode.Uri>();
  readonly deleted = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidCreate = this.created.event;
  readonly onDidDelete = this.deleted.event;
  disposed = false;
  /** Records the directory watched by the resolver. */
  constructor(readonly pattern: vscode.RelativePattern) {}
  /** Releases all notification subscriptions. */
  dispose(): void { this.disposed = true; this.created.dispose(); this.deleted.dispose(); }
}

/** Loads one isolated static resolver with deterministic subprocesses and VS Code events. */
async function withResolver(run: (environment: {
  Resolver: typeof KpsewhichResolver;
  watchers: LookupWatcher[];
  calls: { command: string; args: string[]; cwd: string }[];
  results: Map<string, string | undefined>;
  configuration: vscode.EventEmitter<vscode.ConfigurationChangeEvent>;
  state: { trusted: boolean; executable: string; hold: boolean; kills: number };
  finish: () => void;
}) => Promise<void>): Promise<void> {
  const watchers: LookupWatcher[] = [];
  const calls: { command: string; args: string[]; cwd: string }[] = [];
  const results = new Map<string, string | undefined>();
  const configuration = new vscode.EventEmitter<vscode.ConfigurationChangeEvent>();
  const state = { trusted: true, executable: 'kpsewhich', hold: false, kills: 0 };
  const pending: (() => void)[] = [];
  const filename = require.resolve('../project/KpsewhichResolver');
  const source = await fs.readFile(filename, 'utf8');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const fakeVscode = {
    Uri: vscode.Uri, RelativePattern: vscode.RelativePattern, Disposable: vscode.Disposable,
    workspace: {
      get isTrusted() { return state.trusted; },
      onDidChangeConfiguration: configuration.event,
      /** Keeps directory watches observable and confirms content changes are ignored. */
      createFileSystemWatcher: (pattern: vscode.RelativePattern, _create: boolean, change: boolean) => {
        assert.strictEqual(change, true);
        const watcher = new LookupWatcher(pattern);
        watchers.push(watcher);
        return watcher;
      }
    }
  };
  const dependencies: Record<string, unknown> = {
    vscode: fakeVscode,
    '../Config': { kpsewhichPath: () => state.executable },
    '../workspace': { uriKey: (uri: vscode.Uri) => uri.toString() },
    'cross-spawn': {
      /** Emits the same positional output as kpsewhich, including blank misses. */
      spawn: (command: string, args: string[], options: { cwd: string; shell: boolean }) => {
        assert.strictEqual(options.shell, false);
        calls.push({ command, args, cwd: options.cwd });
        let closed = false;
        const child = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(),
          /** Confirms termination through close, allowing pending callers to settle. */
          kill: () => { state.kills++; finish(); return true; }
        });
        /** Completes one held subprocess without allowing a second close. */
        const finish = () => {
          if (closed) { return; }
          closed = true;
          child.stdout.emit('data', Buffer.from(args.filter(arg => !arg.startsWith('--')).map(name =>
            results.has(name) ? results.get(name) ?? '' : path.join(options.cwd, name)).join('\r\n') + '\r\n'));
          child.emit('close', 0);
        };
        if (state.hold) { pending.push(finish); } else { queueMicrotask(finish); }
        return child;
      }
    }
  };
  const load = runInThisContext(`(function(exports, require, module) {\n${source}\n})`, { filename });
  load(module.exports, (id: string) => Object.hasOwn(dependencies, id) ? dependencies[id] : localRequire(id), module);
  const Resolver = (module.exports as { default: typeof KpsewhichResolver }).default;
  try { await run({ Resolver, watchers, calls, results, configuration, state, finish: () => pending.splice(0).forEach(done => done()) }); }
  finally { Resolver.dispose(); configuration.dispose(); }
}

const main = vscode.Uri.file(path.join(os.tmpdir(), 'fortex-kpse-cache', 'main.tex'));

suite('Shared Kpsewhich resolver', () => {
  test('batches mixed extensions, shares concurrent subsets and separates program contexts', async () => {
    await withResolver(async ({ Resolver, calls }) => {
      const first = Resolver.resolve(main, ['one.bib', 'two.bib', 'plain.bst'], 'upbibtex');
      const second = Resolver.resolve(main, ['two.bib'], 'upbibtex');
      const [all, subset] = await Promise.all([first, second]);
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0].args, ['--progname=upbibtex', 'one.bib', 'two.bib', 'plain.bst']);
      assert.strictEqual(all[1], subset[0]);
      await Resolver.resolve(main, ['two.bib', 'three.bib'], 'upbibtex');
      assert.deepStrictEqual(calls[1].args, ['--progname=upbibtex', 'three.bib']);
      await Resolver.resolve(main, ['two.bib'], 'bibtex');
      assert.strictEqual(calls.length, 3);
      await Resolver.resolve(main, ['two.bib'], 'C:\\TeX Programs\\UPBIBTEX.EXE');
      assert.strictEqual(calls.length, 3);
    });
  });

  test('invalidates only affected names and watches a local candidate ahead of a tree result', async () => {
    await withResolver(async ({ Resolver, calls, watchers, results }) => {
      results.set('one.bib', path.join(os.tmpdir(), 'fortex-texmf', 'one.bib'));
      await Resolver.resolve(main, ['one.bib', 'two.bib']);
      const local = watchers.find(watcher => watcher.pattern.baseUri.fsPath === path.dirname(main.fsPath))!;
      assert.strictEqual(local.pattern.pattern, '*');
      local.created.fire(vscode.Uri.file(path.join(path.dirname(main.fsPath), 'neighbor.bib')));
      await Resolver.resolve(main, ['one.bib', 'two.bib']);
      assert.strictEqual(calls.length, 1);
      local.created.fire(vscode.Uri.file(path.join(path.dirname(main.fsPath), 'one.bib')));
      await Resolver.resolve(main, ['one.bib', 'two.bib']);
      assert.deepStrictEqual(calls[1].args.slice(1), ['one.bib']);
      const tree = watchers.find(watcher => !watcher.disposed && watcher.pattern.baseUri.fsPath.endsWith('fortex-texmf'))!;
      tree.deleted.fire(vscode.Uri.file(results.get('one.bib')!));
      await Resolver.resolve(main, ['one.bib']);
      assert.strictEqual(calls.length, 3);
    });
  });

  test('preserves positional misses in CRLF output and caches them until candidate creation', async () => {
    await withResolver(async ({ Resolver, calls, watchers, results }) => {
      results.set('missing.bib', undefined);
      const files = await Resolver.resolve(main, ['one.bib', 'missing.bib', 'plain.bst']);
      assert.ok(files[0]); assert.strictEqual(files[1], undefined); assert.ok(files[2]);
      await Resolver.resolve(main, ['missing.bib']);
      assert.strictEqual(calls.length, 1);
      results.delete('missing.bib');
      watchers[0].created.fire(vscode.Uri.file(path.join(path.dirname(main.fsPath), 'missing.bib')));
      assert.ok((await Resolver.resolve(main, ['missing.bib']))[0]);
      assert.strictEqual(calls.length, 2);
    });
  });

  test('owns configuration invalidation and does not restore a cleared in-flight entry', async () => {
    await withResolver(async ({ Resolver, calls, watchers, configuration, state, finish }) => {
      state.hold = true;
      const first = Resolver.resolve(main, ['one.bib']);
      await Promise.resolve();
      configuration.fire({ affectsConfiguration: name => name === 'vscode-fortex.kpsewhich.path' });
      assert.ok(watchers.every(watcher => watcher.disposed));
      finish(); await first;
      state.hold = false;
      await Resolver.resolve(main, ['one.bib']);
      assert.strictEqual(calls.length, 2);
      assert.strictEqual(watchers.filter(watcher => !watcher.disposed).length, 1);
    });
  });

  test('disposes processes and watches, and cancels helpers not yet started', async () => {
    await withResolver(async ({ Resolver, calls, watchers, state }) => {
      state.hold = true;
      const pending = Resolver.resolve(main, ['one.bib']);
      await Promise.resolve();
      Resolver.dispose(); await pending;
      assert.strictEqual(state.kills, 1);
      assert.ok(watchers.every(watcher => watcher.disposed));
      const queued = Resolver.resolve(main, ['two.bib']);
      Resolver.dispose(); await queued;
      assert.strictEqual(calls.length, 1);
    });
  });

  test('does not spawn helpers for untrusted or non-file sources', async () => {
    await withResolver(async ({ Resolver, calls, state }) => {
      state.trusted = false;
      assert.deepStrictEqual(await Resolver.resolve(main, ['one.bib']), [undefined]);
      state.trusted = true;
      await Resolver.resolve(vscode.Uri.parse('untitled:main.tex'), ['one.bib']);
      assert.strictEqual(calls.length, 0);
    });
  });

  test('passes explicit dictionary search paths and separates their cached results', async () => {
    await withResolver(async ({ Resolver, calls }) => {
      await Resolver.resolve(main, ['reading.dic'], 'upmendex', '$INDEXDICTIONARY');
      await Resolver.resolve(main, ['reading.dic'], 'upmendex', '$INDEXDICTIONARY');
      assert.deepStrictEqual(calls[0].args, ['--progname=upmendex', '--path=$INDEXDICTIONARY', 'reading.dic']);
      assert.strictEqual(calls.length, 1);
      await Resolver.resolve(main, ['reading.dic'], 'upmendex', '/another/location');
      assert.strictEqual(calls.length, 2);
      await Resolver.resolve(main, ['reading.dic'], 'upmendex');
      assert.strictEqual(calls.length, 3);
      await Resolver.resolve(main, ['reading.dic'], 'upmendex', '');
      assert.deepStrictEqual(calls[3].args, ['--progname=upmendex', '--path=', 'reading.dic']);
    });
  });
});
