import * as assert from 'assert';
import * as fs from 'fs/promises';
import { createRequire } from 'module';
import * as path from 'path';
import { runInThisContext } from 'vm';
import * as vscode from 'vscode';
import type BuildManager from '../compile/BuildManager';
import type { BuildContext, BuildRequest, BuildResult } from '../compile/BuildProtocol';

/** Holds simulated work open until a test releases its execution. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Bounds asynchronous checks without allowing a broken request to hang the test host. */
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Build did not settle')), 5000);
    })]);
  } finally { if (timer) { clearTimeout(timer); } }
}

/** Creates a generic result without referring to projects, compilers or PDF output. */
function succeeded(key?: vscode.Uri): BuildResult {
  return { outcome: 'succeeded', severity: 'info', message: 'Completed.',
    diagnostics: key ? { key, entries: [] } : undefined };
}

/** Supplies one source error for snapshot ownership and replacement checks. */
function failed(key: vscode.Uri, uri = key): BuildResult {
  return { outcome: 'failed', severity: 'error', message: 'Broken source', diagnostics: {
    key, entries: [[uri, [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), 'Source error')]]]
  } };
}

interface Fixture {
  manager: BuildManager;
  status: vscode.StatusBarItem;
  diagnostics: Map<string, readonly vscode.Diagnostic[]>;
  timers: Map<number, { callback(): void; delay: number }>;
  state: {
    runs: vscode.Uri[];
    clears: number;
    popups: number;
    stopCalls: number;
    errors: string[];
    trusted: boolean;
    choice?: string;
    stop(): Promise<void>;
    open(source: vscode.Uri): Promise<vscode.TextDocument>;
    execute(uri: vscode.Uri, context: BuildContext): Promise<BuildResult>;
  };
  uri(name: string): vscode.Uri;
  request(name: string, execute?: BuildRequest['execute']): BuildRequest;
  build(name?: string, origin?: 'manual' | 'save'): Promise<BuildResult | undefined>;
  tick(): Promise<void>;
  idle(): Promise<void>;
}

/** Loads the real generic manager with deterministic UI, output and timer boundaries. */
async function withManager(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const uri = (name: string) => vscode.Uri.file(path.resolve('build-control-fixture', name));
  const state: Fixture['state'] = {
    runs: [], clears: 0, popups: 0, stopCalls: 0, errors: [], trusted: true,
    stop: async () => {}, execute: async source => succeeded(source),
    open: async uri => ({ uri } as vscode.TextDocument)
  };
  const status = { text: '', show() {}, dispose() {} } as unknown as vscode.StatusBarItem;
  const diagnostics = new Map<string, readonly vscode.Diagnostic[]>();
  const timers = new Map<number, { callback(): void; delay: number }>();
  let nextTimer = 0;
  /** Captures timers so stale callbacks can be fired even after cancellation. */
  const setTimer = (callback: () => void, delay: number) => {
    const id = ++nextTimer; timers.set(id, { callback, delay }); return id;
  };
  /** Removes a timer from the set of currently scheduled notifications. */
  const clearTimer = (id: number) => { timers.delete(id); };
  const filename = require.resolve('../compile/BuildManager');
  const localRequire = createRequire(filename);
  const isolated = { exports: {} as { default: typeof BuildManager } };
  const source = await fs.readFile(filename, 'utf8');
  const load = runInThisContext('(function(exports,require,module,__filename,__dirname,setTimeout,clearTimeout){\n' + source + '\n})', { filename });
  load(isolated.exports, (id: string) => {
    if (id === 'vscode') {
      return {
        ...vscode, workspace: { get isTrusted() { return state.trusted; }, openTextDocument: (uri: vscode.Uri) => state.open(uri) },
        commands: { executeCommand: async () => {} },
        languages: { createDiagnosticCollection: () => ({
          clear: () => diagnostics.clear(),
          set: (entries: [vscode.Uri, readonly vscode.Diagnostic[]][]) => {
            for (const [file, values] of entries) { diagnostics.set(file.toString(), values); }
          },
          dispose: () => diagnostics.clear()
        }) },
        window: { createStatusBarItem: () => status,
          showTextDocument: async () => {}, showQuickPick: async () => ({ action: state.choice }),
          showErrorMessage: () => { state.popups++; }, showWarningMessage: () => { state.popups++; } }
      };
    }
    if (id === './Process') { return { killAll: () => { state.stopCalls++; return state.stop(); } }; }
    if (id === '../log') {
      return { clear_process_message: () => { state.clears++; }, error: (message: string) => state.errors.push(message), show() {} };
    }
    return localRequire(id);
  }, isolated, filename, path.dirname(filename), setTimer, clearTimer);
  const manager = new isolated.exports.default();
  /** Creates an inert request and records execution only when its slot is acquired. */
  const request = (name: string, execute?: BuildRequest['execute']): BuildRequest => ({
    source: uri(name), label: 'Example build',
    execute: context => {
      state.runs.push(uri(name));
      return execute ? execute(context) : state.execute(uri(name), context);
    }
  });
  const fixture: Fixture = {
    manager, status, diagnostics, timers, state, uri, request,
    build: (name = 'main.tex', origin = 'manual') => manager.requestBuild(request(name), origin),
    tick: () => new Promise(resolve => setImmediate(resolve)),
    /** Waits for all queued work, independently of transient status timers. */
    idle: () => bounded((async () => {
      while ((manager as unknown as { active?: unknown }).active) { await new Promise(resolve => setImmediate(resolve)); }
    })())
  };
  try { await run(fixture); assert.strictEqual(state.popups, 0); }
  finally { await manager.shutdown(); }
}

suite('Generic build monitoring', () => {
  test('rebuilds the selected request even if a newer result arrives while its source is opening', async () => {
    await withManager(async f => {
      await f.build('selected.tex');
      const opened = deferred(); const release = deferred();
      f.state.choice = 'rebuild';
      f.state.open = async uri => { opened.resolve(); await release.promise; return { uri } as vscode.TextDocument; };
      const rebuilding = f.manager.showActions();
      await opened.promise;
      await f.build('newer.tex');
      release.resolve(); await rebuilding;
      assert.deepStrictEqual(f.state.runs.map(file => path.basename(file.fsPath)), ['selected.tex', 'newer.tex', 'selected.tex']);
    });
  });

  test('reserves execution before invoking the producer and refuses a second manual request', async () => {
    await withManager(async f => {
      const gate = deferred();
      f.state.execute = async () => { await gate.promise; return succeeded(); };
      const first = f.build();
      assert.match(f.status.text, /Example build: Processing/);
      assert.strictEqual(await f.build('other.tex'), undefined);
      assert.strictEqual(f.state.runs.length, 1);
      assert.match(f.status.text, /already running/);
      gate.resolve(); await bounded(first);
      assert.strictEqual(f.state.clears, 1);
    });
  });

  test('keeps different request files queued even when they report the same build target', async () => {
    await withManager(async f => {
      const gate = deferred();
      f.state.execute = async (_source, context) => {
        context.reportProgress('Building shared target…', f.uri('main.tex'));
        if (f.state.runs.length === 1) { await gate.promise; }
        return succeeded(f.uri('main.tex'));
      };
      const first = f.build('busy.tex');
      await f.build('main.tex', 'save');
      await f.build('sub.tex', 'save');
      await f.build('main.tex', 'save');
      assert.match(f.status.text, /Update waiting/);
      gate.resolve(); await first; await f.idle();
      assert.deepStrictEqual(f.state.runs.map(file => path.basename(file.fsPath)), ['busy.tex', 'main.tex', 'sub.tex']);
      assert.strictEqual(f.state.clears, 3);
    });
  });

  test('replaces a queued request with its latest execution callback without changing its position', async () => {
    await withManager(async f => {
      const gate = deferred(); const seen: number[] = [];
      const first = f.manager.requestBuild(f.request('busy.tex', async () => { await gate.promise; return succeeded(); }));
      for (const revision of [1, 2, 3]) {
        await f.manager.requestBuild(f.request('main.tex', async () => { seen.push(revision); return succeeded(); }), 'save');
      }
      gate.resolve(); await first; await f.idle();
      assert.deepStrictEqual(seen, [3]);
    });
  });

  test('replaces Problems only after completion and clears failures with an empty snapshot', async () => {
    await withManager(async f => {
      f.state.execute = async uri => failed(uri);
      await f.build();
      assert.strictEqual(f.status.backgroundColor?.id, 'statusBarItem.errorBackground');
      assert.ok(f.diagnostics.get(f.uri('main.tex').toString())?.[0].source?.includes(f.uri('main.tex').fsPath));
      const gate = deferred();
      f.state.execute = async uri => { await gate.promise; return succeeded(uri); };
      const retry = f.build();
      assert.strictEqual(f.status.backgroundColor, undefined);
      assert.strictEqual(f.diagnostics.size, 1);
      gate.resolve(); await retry;
      assert.strictEqual(f.diagnostics.size, 0);
      assert.match(f.status.text, /Succeeded/);
      [...f.timers.values()].find(timer => timer.delay === 3000)!.callback();
      assert.doesNotMatch(f.status.text, /Succeeded|Failed/);
    });
  });

  test('updates the diagnostic key independently of the request source and retains other keys', async () => {
    await withManager(async f => {
      const shared = f.uri('included.tex');
      f.state.execute = async () => failed(f.uri('a.tex'), shared);
      await f.build('a-child.tex');
      f.state.execute = async () => failed(f.uri('b.tex'), shared);
      await f.build('b-child.tex');
      assert.strictEqual(f.diagnostics.get(shared.toString())?.length, 2);
      f.state.execute = async () => succeeded(f.uri('a.tex'));
      await f.build('another-a-child.tex');
      const remaining = f.diagnostics.get(shared.toString())!;
      assert.strictEqual(remaining.length, 1);
      assert.ok(remaining[0].source?.includes(f.uri('b.tex').fsPath));
    });
  });

  test('publishes Problems from warning completions and replaces only their completed diagnostic group', async () => {
    await withManager(async f => {
      f.state.execute = async uri => ({ ...failed(uri), outcome: 'succeeded', severity: 'warning',
        message: 'Completed with helper failures.' });
      await f.build('a.tex');
      assert.match(f.status.text, /Completed with warnings/);
      assert.strictEqual(f.diagnostics.get(f.uri('a.tex').toString())?.[0].severity, vscode.DiagnosticSeverity.Error);
      f.state.execute = async uri => succeeded(uri);
      await f.build('b.tex');
      assert.strictEqual(f.diagnostics.size, 1);
      f.state.execute = async () => ({ outcome: 'cancelled', severity: 'info', message: 'Cancelled.' });
      await f.build('a.tex');
      assert.strictEqual(f.diagnostics.size, 1);
      f.state.execute = async uri => succeeded(uri);
      await f.build('a.tex');
      assert.strictEqual(f.diagnostics.size, 0);
    });
  });

  test('preserves Problems when no key is known and replaces them on a failed run with an empty snapshot', async () => {
    await withManager(async f => {
      f.state.execute = async source => failed(source); await f.build();
      f.state.execute = async () => { throw new Error('Discovery failed'); }; await f.build();
      assert.strictEqual(f.diagnostics.size, 1);
      f.state.execute = async source => ({ outcome: 'failed', severity: 'error', message: 'Launch failed',
        diagnostics: { key: source, entries: [] } });
      await f.build(); assert.strictEqual(f.diagnostics.size, 0);
    });
  });

  test('stops active work, discards queued saves, and rejects new saves until cancellation settles', async () => {
    await withManager(async f => {
      const gate = deferred(); let token: vscode.CancellationToken | undefined;
      f.state.execute = async (_source, context) => { token = context.token; await gate.promise; return succeeded(); };
      const first = f.build(); await f.build('other.tex', 'save');
      let stopped = false;
      const stopping = f.manager.stop().then(() => { stopped = true; });
      await f.tick(); assert.strictEqual(token?.isCancellationRequested, true); assert.strictEqual(stopped, false);
      await f.build('third.tex', 'save'); assert.match(f.status.text, /Stopping/);
      gate.resolve(); await stopping; await first; await f.idle();
      assert.strictEqual(f.state.runs.length, 1);
    });
  });

  test('keeps Problems on cancellation without restoring the previous status result', async () => {
    await withManager(async f => {
      f.state.execute = async source => failed(source); await f.build();
      f.state.execute = async source => ({ outcome: 'cancelled', severity: 'info', message: 'Cancelled.',
        diagnostics: { key: source, entries: [] } });
      await f.build(); assert.match(f.status.text, /Cancelled/); assert.strictEqual(f.diagnostics.size, 1);
      [...f.timers.values()].find(timer => timer.delay === 3000)!.callback();
      assert.doesNotMatch(f.status.text, /Failed|Cancelled/);
      assert.strictEqual(f.status.backgroundColor, undefined);
    });
  });

  test('ignores old progress, notices and timers when a newer execution owns the display', async () => {
    await withManager(async f => {
      let oldContext!: BuildContext;
      f.state.execute = async (_source, context) => { oldContext = context; return succeeded(); };
      await f.build();
      const oldTimer = [...f.timers.values()].find(timer => timer.delay === 3000)!.callback;
      oldContext.reportNotice({ severity: 'warning', message: 'Preview failed' });
      oldTimer(); assert.match(f.status.text, /warnings/);
      const gate = deferred(); f.state.execute = async () => { await gate.promise; return succeeded(); };
      const next = f.build('new.tex');
      oldContext.reportProgress('Obsolete progress'); oldContext.reportNotice({ severity: 'error', message: 'Obsolete error' });
      oldTimer(); assert.match(f.status.text, /sync~spin/); assert.doesNotMatch(f.status.text, /Obsolete/);
      gate.resolve(); await next;
      oldContext.reportNotice({ severity: 'error', message: 'Obsolete error' });
      assert.match(f.status.text, /Succeeded/);
    });
  });

  test('does not revive an expired success on empty notices or after a brief hint disappears', async () => {
    await withManager(async f => {
      let context!: BuildContext;
      f.state.execute = async (_source, value) => { context = value; return succeeded(); };
      await f.build();
      const [id, expiry] = [...f.timers].find(([, timer]) => timer.delay === 3000)!;
      context.reportNotice(undefined);
      assert.strictEqual(f.timers.get(id), expiry);
      f.state.trusted = false;
      await f.build();
      assert.strictEqual([...f.timers.values()].filter(timer => timer.delay === 3000).length, 1);
      expiry.callback();
      assert.match(f.status.text, /not trusted/);
      [...f.timers.values()].find(timer => timer.delay === 5000)!.callback();
      assert.doesNotMatch(f.status.text, /Succeeded|not trusted/);
      context.reportNotice(undefined);
      assert.doesNotMatch(f.status.text, /Succeeded/);
    });
  });

  test('retains a late warning while the original success expires and clears it without reviving success', async () => {
    await withManager(async f => {
      let context!: BuildContext;
      f.state.execute = async (_source, value) => { context = value; return succeeded(); };
      await f.build();
      const expiry = [...f.timers.values()].find(timer => timer.delay === 3000)!;
      context.reportNotice({ severity: 'warning', message: 'Preview failed' });
      context.reportNotice({ severity: 'warning', message: 'Preview failed' });
      expiry.callback();
      assert.match(f.status.text, /warnings/);
      context.reportNotice(undefined);
      assert.doesNotMatch(f.status.text, /warnings|Succeeded/);
      context.reportNotice({ severity: 'warning', message: 'Another preview failure' });
      assert.match(f.status.text, /warnings/);
      context.reportNotice(undefined);
      assert.doesNotMatch(f.status.text, /warnings|Succeeded/);
    });
  });

  test('reports stop failure, keeps the build locked, and permits a successful retry', async () => {
    await withManager(async f => {
      const gate = deferred();
      f.state.execute = async () => { await gate.promise; return succeeded(); };
      const first = f.build();
      try {
        f.state.stop = async () => { throw new Error('Permission denied'); };
        await f.manager.stop();
        assert.match(f.status.text, /Stop not confirmed/);
        assert.strictEqual(f.status.backgroundColor?.id, 'statusBarItem.errorBackground');
        assert.ok(f.state.errors.some(message => message.includes('Permission denied')));
        await f.build('manual.tex'); await f.build('saved.tex', 'save');
        assert.match(f.status.text, /Stop not confirmed/);
        assert.strictEqual(f.state.runs.length, 1);
        f.state.stop = async () => { gate.resolve(); };
        await f.manager.stop(); await first;
        assert.strictEqual(f.state.stopCalls, 2);
        assert.match(f.status.text, /Cancelled/);
        assert.strictEqual(f.status.backgroundColor, undefined);
        await f.build('after.tex');
        assert.strictEqual(f.state.runs.length, 2);
      } finally { gate.resolve(); await first; f.state.stop = async () => {}; }
    });
  });

  test('coalesces pending stops and reports a timeout without releasing the build lock', async () => {
    await withManager(async f => {
      const work = deferred(); const termination = deferred();
      f.state.execute = async () => { await work.promise; return succeeded(); };
      f.state.stop = () => termination.promise;
      const first = f.build();
      try {
        const stopping = f.manager.stop(); const duplicate = f.manager.stop();
        assert.strictEqual(f.state.stopCalls, 1);
        [...f.timers.values()].find(timer => timer.delay === 5000)!.callback();
        await stopping; await duplicate;
        assert.match(f.status.text, /Stop not confirmed/);
        assert.ok(f.state.errors.some(message => message.includes('5 seconds')));
        await f.build('other.tex', 'save');
        assert.strictEqual(f.state.runs.length, 1);
        f.state.stop = async () => { work.resolve(); };
        await f.manager.stop(); await first;
        termination.resolve(); await f.tick();
        assert.match(f.status.text, /Cancelled/);
      } finally { termination.resolve(); work.resolve(); await first; f.state.stop = async () => {}; }
    });
  });

  test('requests process shutdown before waiting for a producer blocked on termination', async () => {
    await withManager(async f => {
      const gate = deferred();
      f.state.execute = async () => { await gate.promise; return succeeded(); };
      const first = f.build();
      f.state.stop = async () => { gate.resolve(); };
      try {
        await bounded(f.manager.shutdown()); await first;
        assert.strictEqual(f.state.stopCalls, 1);
      } finally { gate.resolve(); await first; }
    });
  });

  test('logs shutdown failure and returns without falsely completing the producer', async () => {
    await withManager(async f => {
      const gate = deferred(); let settled = false;
      f.state.execute = async () => { await gate.promise; return succeeded(); };
      const first = f.build().then(result => { settled = true; return result; });
      f.state.stop = async () => { throw new Error('Cannot terminate'); };
      try {
        await bounded(f.manager.shutdown());
        assert.strictEqual(settled, false);
        assert.ok(f.state.errors.some(message => message.includes('shutdown') && message.includes('Cannot terminate')));
      } finally { gate.resolve(); await first; f.state.stop = async () => {}; }
    });
  });
});
