import * as assert from 'assert';
import * as fs from 'fs/promises';
import { createRequire } from 'module';
import * as path from 'path';
import { runInThisContext } from 'vm';
import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import type Process from '../compile/Process';
import type { SpawnOptions } from 'child_process';

/** Models child events explicitly so cancellation can be checked before and after close. */
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  kills = 0;
  pid?: number;
  killResult = true;
  killError?: Error;
  /** Models accepted, refused and throwing signals without pretending that the child has exited. */
  kill(): boolean {
    this.kills++;
    if (this.killError) { throw this.killError; }
    return this.killResult;
  }
}

interface ProcessBoundary {
  platform: string;
  timers: Map<number, () => void>;
  groupSignals: number[];
  groupError?: Error;
  launches: { command: string; args: readonly string[]; options: SpawnOptions }[];
  spawnError?: Error;
}

/** Loads real process ownership with controllable OS signals, helper events and timeout callbacks. */
async function withProcess(run: (type: typeof Process, children: FakeChild[], boundary: ProcessBoundary) => Promise<void>): Promise<void> {
  const filename = require.resolve('../compile/Process');
  const localRequire = createRequire(filename);
  const source = await fs.readFile(filename, 'utf8');
  const moduleObject = { exports: {} as { default: typeof Process } };
  const children: FakeChild[] = [];
  const boundary: ProcessBoundary = { platform: process.platform, timers: new Map(), groupSignals: [], launches: [] };
  let nextTimer = 0;
  /** Captures stop deadlines so timeout tests never depend on wall-clock delays. */
  const setTimer = (callback: () => void) => { const id = ++nextTimer; boundary.timers.set(id, callback); return id; };
  const processBoundary = {
    get platform() { return boundary.platform; },
    /** Records only signals to the isolated process group under test. */
    kill: (pid: number) => {
      boundary.groupSignals.push(pid);
      if (boundary.groupError) { throw boundary.groupError; }
      return true;
    }
  };
  const load = runInThisContext(`(function(exports,require,module,__filename,__dirname,process,setTimeout,clearTimeout){\n${source}\n})`, { filename });
  load(moduleObject.exports, (id: string) => {
    if (id === 'cross-spawn') {
      return { spawn: (command: string, args: readonly string[], options: SpawnOptions) => {
        if (boundary.spawnError) { throw boundary.spawnError; }
        boundary.launches.push({ command, args, options });
        const child = new FakeChild(); children.push(child); return child;
      } };
    }
    if (id === '../log') { return { debug_log() {}, process_message() {} }; }
    return localRequire(id);
  }, moduleObject, filename, path.dirname(filename), processBoundary, setTimer, (id: number) => boundary.timers.delete(id));
  try { await run(moduleObject.exports.default, children, boundary); }
  finally { for (const child of children) { child.emit('close', null); } }
}

/** Lets an asynchronous launch or cancellation listener advance one event-loop turn. */
async function tick(): Promise<void> { await new Promise(resolve => setImmediate(resolve)); }

suite('Build child-process lifetime', () => {
  test('returns the exit code only on close', async () => {
    await withProcess(async (Type, children) => {
      const runner = new Type('tool', [], null);
      let settled = false;
      const result = runner.execute().then(code => { settled = true; return code; });
      await tick();
      children[0].emit('exit', 0);
      await tick(); assert.strictEqual(settled, false);
      children[0].emit('close', 0);
      assert.strictEqual(await result, 0);
      await runner.kill();
    });
  });

  test('stops one instance independently and ignores its late events when stopping all remaining instances', async () => {
    await withProcess(async (Type, children) => {
      const firstTool = new Type('first', [], null);
      const secondTool = new Type('second', [], null);
      const first = firstTool.execute().catch(error => error);
      const second = secondTool.execute().catch(error => error);
      assert.strictEqual(children.length, 2);
      assert.deepStrictEqual(children.map(child => child.kills), [0, 0]);
      const stoppingFirst = firstTool.kill();
      assert.deepStrictEqual(children.map(child => child.kills), [1, 0]);
      children[0].emit('close', null);
      await stoppingFirst;
      assert.ok(await first instanceof vscode.CancellationError);
      children[0].emit('close', null);
      await firstTool.kill();
      assert.deepStrictEqual(children.map(child => child.kills), [1, 0]);
      const stopping = Type.killAll();
      assert.strictEqual(children[1].kills, 1);
      children[1].emit('close', null);
      await stopping;
      assert.ok(await second instanceof vscode.CancellationError);
    });
  });

  test('stores constructor arguments without launching and fixes shell execution to false', async () => {
    await withProcess(async (Type, children, boundary) => {
      const args = ['--original'];
      const runner = new Type('engine', args, 'working-directory');
      args.push('--later');
      assert.strictEqual(children.length, 0);
      await Type.killAll();
      const execution = runner.execute();
      assert.strictEqual(children.length, 1);
      const launch = boundary.launches[0];
      assert.strictEqual(launch.command, 'engine');
      assert.deepStrictEqual(launch.args, ['--original']);
      assert.strictEqual(launch.options.cwd, 'working-directory');
      assert.strictEqual(launch.options.shell, false);
      children[0].emit('close', 0); await execution;
    });
  });

  test('registers launches immediately so killAll reaches every active instance before yielding', async () => {
    await withProcess(async (Type, children) => {
      const first = new Type('first', [], null).execute().catch(error => error);
      const second = new Type('second', [], null).execute().catch(error => error);
      const stopping = Type.killAll();
      assert.deepStrictEqual(children.map(child => child.kills), [1, 1]);
      children[0].emit('close', null); children[1].emit('close', null);
      await stopping;
      assert.ok(await first instanceof vscode.CancellationError);
      assert.ok(await second instanceof vscode.CancellationError);
    });
  });

  test('rejects a second execution before and after close without stopping or replacing the first child', async () => {
    await withProcess(async (Type, children) => {
      const runner = new Type('tool', [], null);
      const execution = runner.execute();
      await assert.rejects(runner.execute(), /only be executed once/);
      assert.strictEqual(children.length, 1);
      assert.strictEqual(children[0].kills, 0);
      children[0].emit('close', 0); assert.strictEqual(await execution, 0);
      await assert.rejects(runner.execute(), /only be executed once/);
      await runner.kill(); await Type.killAll();
      assert.strictEqual(children.length, 1);
      assert.strictEqual(children[0].kills, 0);
    });
  });

  test('prevents launch after an individual kill issued before execution', async () => {
    await withProcess(async (Type, children) => {
      const runner = new Type('tool', [], null);
      await runner.kill(); await runner.kill();
      await assert.rejects(runner.execute(), vscode.CancellationError);
      await assert.rejects(runner.execute(), /only be executed once/);
      await Type.killAll();
      assert.strictEqual(children.length, 0);
    });
  });

  test('does not register a process when spawning throws synchronously', async () => {
    await withProcess(async (Type, children, boundary) => {
      const runner = new Type('tool', [], null);
      boundary.spawnError = new Error('Cannot spawn');
      await assert.rejects(runner.execute(), /Cannot spawn/);
      await runner.kill(); await Type.killAll();
      assert.strictEqual(children.length, 0);
    });
  });

  test('waits for close on cancellation and rejects rather than treating it as a tool error', async () => {
    await withProcess(async (Type, children) => {
      const source = new vscode.CancellationTokenSource();
      try {
        let settled = false;
        const result = new Type('tool', [], null).execute(source.token).catch(error => { settled = true; return error; });
        await tick(); source.cancel(); await tick();
        assert.strictEqual(children[0].kills, 1);
        assert.strictEqual(settled, false);
        children[0].emit('close', null);
        assert.ok(await result instanceof vscode.CancellationError);
      } finally { source.dispose(); }
    });
  });

  test('does not spawn an already cancelled request', async () => {
    await withProcess(async (Type, children) => {
      const source = new vscode.CancellationTokenSource(); source.cancel();
      try {
        await assert.rejects(new Type('tool', [], null).execute(source.token), vscode.CancellationError);
        assert.strictEqual(children.length, 0);
      } finally { source.dispose(); }
    });
  });

  test('retains a launch error until close and releases global tracking afterward', async () => {
    await withProcess(async (Type, children) => {
      let settled = false;
      const error = new Error('Executable unavailable');
      const result = new Type('missing', [], null).execute().catch(value => { settled = true; return value; });
      await tick(); children[0].emit('error', error); await tick();
      assert.strictEqual(settled, false);
      children[0].emit('close', -1);
      assert.strictEqual(await result, error);
      await Type.killAll(); assert.strictEqual(children[0].kills, 0);
    });
  });

  test('retains a refused process and retries termination without settling its execution early', async () => {
    await withProcess(async (Type, children) => {
      const runner = new Type('tool', [], null); let settled = false;
      const execution = runner.execute().catch(error => { settled = true; return error; });
      await tick();
      children[0].killResult = false;
      await assert.rejects(runner.kill(), /rejected the termination request/);
      assert.strictEqual(settled, false);
      await assert.rejects(Type.killAll(), /rejected the termination request/);
      assert.strictEqual(children[0].kills, 2);
      children[0].killResult = true;
      const retry = runner.kill();
      assert.strictEqual(children[0].kills, 3);
      children[0].emit('close', null); await retry;
      assert.ok(await execution instanceof vscode.CancellationError);
      await runner.kill();
    });
  });

  test('reports thrown signal errors and allows retry after a cancellation-listener failure', async () => {
    await withProcess(async (Type, children) => {
      const runner = new Type('tool', [], null); const cancellation = new vscode.CancellationTokenSource();
      const execution = runner.execute(cancellation.token).catch(error => error);
      try {
        await tick(); children[0].killError = new Error('Permission denied');
        cancellation.cancel(); await tick();
        await assert.rejects(runner.kill(), /Permission denied/);
        children[0].killError = undefined;
        const retry = runner.kill(); children[0].emit('close', null); await retry;
        assert.ok(await execution instanceof vscode.CancellationError);
      } finally { cancellation.dispose(); }
    });
  });

  test('shares in-flight termination and retains ownership after its close deadline expires', async () => {
    await withProcess(async (Type, children, boundary) => {
      const runner = new Type('tool', [], null); let settled = false;
      const execution = runner.execute().catch(error => { settled = true; return error; });
      await tick();
      const stopping = runner.kill(); const duplicate = runner.kill();
      assert.strictEqual(children[0].kills, 1);
      const rejected = Promise.all([
        assert.rejects(stopping, /not confirmed within 5 seconds/),
        assert.rejects(duplicate, /not confirmed within 5 seconds/)
      ]);
      [...boundary.timers.values()][0](); await rejected;
      assert.strictEqual(settled, false);
      assert.strictEqual(boundary.timers.size, 0);
      const retry = runner.kill();
      assert.strictEqual(children[0].kills, 2);
      children[0].emit('close', null); await retry;
      assert.ok(await execution instanceof vscode.CancellationError);
    });
  });

  test('reports Windows taskkill and fallback failures and can repeat the tree request', async () => {
    await withProcess(async (Type, children, boundary) => {
      boundary.platform = 'win32';
      const runner = new Type('tool', [], null);
      const execution = runner.execute().catch(error => error);
      await tick(); children[0].pid = 1234; children[0].killResult = false;
      const stopping = runner.kill();
      const rejected = assert.rejects(stopping, /taskkill.exe exited with code 1: Access denied; fallback failed/);
      children[1].stderr.emit('data', Buffer.from('Access denied'));
      children[1].emit('close', 1); await rejected;
      const retry = runner.kill();
      assert.strictEqual(children.length, 3);
      children[2].emit('close', 0); children[0].emit('close', null); await retry;
      assert.ok(await execution instanceof vscode.CancellationError);
    });
  });

  test('attempts the Windows direct-child fallback once when the helper emits error and close', async () => {
    await withProcess(async (Type, children, boundary) => {
      boundary.platform = 'win32';
      const runner = new Type('tool', [], null);
      const execution = runner.execute().catch(error => error);
      await tick(); children[0].pid = 1234;
      const stopping = runner.kill();
      children[1].emit('error', new Error('taskkill unavailable'));
      children[1].emit('close', 1);
      assert.strictEqual(children[0].kills, 1);
      children[0].emit('close', null); await stopping;
      assert.ok(await execution instanceof vscode.CancellationError);
    });
  });

  test('cleans up a stalled Windows helper without letting its late events signal the target', async () => {
    await withProcess(async (Type, children, boundary) => {
      boundary.platform = 'win32';
      const runner = new Type('tool', [], null);
      const execution = runner.execute().catch(error => error);
      await tick(); children[0].pid = 1234;
      const stopping = runner.kill();
      const rejected = assert.rejects(stopping, /not confirmed within 5 seconds/);
      [...boundary.timers.values()][0](); await rejected;
      assert.strictEqual(children[1].kills, 1);
      children[1].emit('error', new Error('Late helper error')); children[1].emit('close', 1);
      assert.strictEqual(children[0].kills, 0);
      const retry = runner.kill();
      children[2].emit('close', 0); children[0].emit('close', null); await retry;
      assert.ok(await execution instanceof vscode.CancellationError);
    });
  });

  test('signals the private POSIX group and exposes group plus fallback failure', async () => {
    await withProcess(async (Type, children, boundary) => {
      boundary.platform = 'linux';
      const runner = new Type('tool', [], null);
      const execution = runner.execute().catch(error => error);
      await tick(); children[0].pid = 4321; children[0].killResult = false;
      boundary.groupError = new Error('Group signal denied');
      await assert.rejects(runner.kill(), /Group signal denied; fallback failed/);
      assert.deepStrictEqual(boundary.groupSignals, [-4321]);
      boundary.groupError = undefined;
      const retry = runner.kill(); children[0].emit('close', null); await retry;
      assert.deepStrictEqual(boundary.groupSignals, [-4321, -4321]);
      assert.ok(await execution instanceof vscode.CancellationError);
    });
  });
});
