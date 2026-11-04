import * as assert from 'assert';
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import { createRequire } from 'module';
import * as path from 'path';
import { runInThisContext } from 'vm';
import * as vscode from 'vscode';
import TexdocService, { parseTexdocOutput } from '../documentation/TexdocService';

function documentationPath(name = 'amsmath manual.pdf'): string {
  return path.resolve('texdoc-test', name);
}

function machineRow(filePath = documentationPath()): string {
  return `amsmath\t10.5\t${filePath}\ten\tUser guide`;
}

class TestProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

interface ProcessCall {
  executable: string;
  args: string[];
  options: { shell: boolean; windowsHide: boolean; stdio: string[] };
  child: TestProcess;
}

async function withMockTexdoc(run: (fixture: {
  service: TexdocService;
  calls: ProcessCall[];
  state: { trusted: boolean; executable: string };
  timeouts: Map<number, () => void>;
}) => Promise<void>): Promise<void> {
  const calls: ProcessCall[] = [];
  const state = { trusted: true, executable: 'C:\\TeX Live\\bin\\texdoc.exe' };
  const timeouts = new Map<number, () => void>();
  let nextTimeout = 0;
  const filename = require.resolve('../documentation/TexdocService');
  const source = await fs.readFile(filename, 'utf8');
  const localRequire = createRequire(filename);
  const isolatedModule = { exports: {} as { default: typeof TexdocService } };
  const load = runInThisContext(`(function (exports, require, module, __filename, __dirname, setTimeout, clearTimeout) {\n${source}\n})`, { filename });
  load(isolatedModule.exports, (id: string) => {
    if (id === 'cross-spawn') {
      return { spawn: (executable: string, args: string[], options: ProcessCall['options']) => {
        const child = new TestProcess();
        calls.push({ executable, args, options, child });
        return child;
      } };
    }
    if (id === '../Config') {
      return { texdocPath: () => state.executable };
    }
    if (id === '../WorkspaceTrust') {
      return { assertWorkspaceTrusted: () => {
        if (!state.trusted) {
          throw new Error('TeX documentation is disabled until this workspace is trusted.');
        }
      } };
    }
    return localRequire(id);
  }, isolatedModule, filename, path.dirname(filename), (callback: () => void) => {
    const id = ++nextTimeout;
    timeouts.set(id, callback);
    return id;
  }, (id: number) => { timeouts.delete(id); });
  const service = new isolatedModule.exports.default();
  try {
    await run({ service, calls, state, timeouts });
  } finally {
    service.dispose();
  }
}

suite('TeX documentation lookup', () => {
  test('parses tab-separated metadata, spaces in paths, CRLF, and original order', () => {
    const first = documentationPath();
    const second = documentationPath('日本語 guide.pdf');
    const entries = parseTexdocOutput(`${machineRow(first)}\r\namsmath\t20\t${second}\tja\t日本語の説明\r\n`);
    assert.deepStrictEqual(entries, [
      { query: 'amsmath', score: 10.5, filePath: first, language: 'en', description: 'User guide' },
      { query: 'amsmath', score: 20, filePath: second, language: 'ja', description: '日本語の説明' }
    ]);
  });

  test('accepts absent optional metadata and ignores future columns', () => {
    const entries = parseTexdocOutput(`amsmath\t0\t${documentationPath()}\n${machineRow()}\tfuture column\n`);
    assert.strictEqual(entries[0].language, undefined);
    assert.strictEqual(entries[0].description, undefined);
    assert.strictEqual(entries[1].description, 'User guide');
    assert.deepStrictEqual(parseTexdocOutput('\r\n'), []);
  });

  test('reports malformed machine output rather than silently reporting no matches', () => {
    for (const output of ['amsmath 10 manual.pdf', 'amsmath\tnan\t/doc.pdf', 'amsmath\t1\trelative.pdf']) {
      assert.throws(() => parseTexdocOutput(output), /invalid documentation list at line 1/);
    }
  });

  test('passes executable and search arguments separately and returns parsed matches', async () => {
    await withMockTexdoc(async ({ service, calls, state, timeouts }) => {
      const result = service.list('  --help & amsmath  ');
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].executable, state.executable);
      assert.deepStrictEqual(calls[0].args, ['--list', '--machine', '--', '--help & amsmath']);
      assert.deepStrictEqual(calls[0].options, {
        shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
      });
      calls[0].child.stdout.emit('data', Buffer.from(machineRow()));
      calls[0].child.emit('close', 0, null);
      assert.strictEqual((await result)[0].filePath, documentationPath());
      assert.strictEqual(timeouts.size, 0);
    });
  });

  test('recognizes the no-documentation exit code and includes stderr for failures', async () => {
    await withMockTexdoc(async ({ service, calls }) => {
      const missing = service.list('missing');
      calls[0].child.emit('close', 3, null);
      assert.deepStrictEqual(await missing, []);
      const failed = service.list('amsmath');
      const rejection = assert.rejects(failed, /exit code 1.*configuration failed/);
      calls[1].child.stderr.emit('data', Buffer.from('configuration failed'));
      calls[1].child.emit('close', 1, null);
      await rejection;
    });
  });

  test('provides a setting hint when the executable is missing', async () => {
    await withMockTexdoc(async ({ service, calls }) => {
      const result = service.list('amsmath');
      const rejection = assert.rejects(result, /Cannot find texdoc.*vscode-fortex.texdoc.path/);
      calls[0].child.emit('error', Object.assign(new Error('missing executable'), { code: 'ENOENT' }));
      await rejection;
    });
  });

  test('treats viewer exit code 3 and process signals as failures', async () => {
    await withMockTexdoc(async ({ service, calls }) => {
      const viewing = service.open(documentationPath());
      const viewingRejection = assert.rejects(viewing, /exit code 3/);
      calls[0].child.emit('close', 3, null);
      await viewingRejection;
      const search = service.list('amsmath');
      const searchRejection = assert.rejects(search, /signal SIGTERM/);
      calls[1].child.emit('close', null, 'SIGTERM');
      await searchRejection;
    });
  });

  test('refuses execution in Restricted Mode and validates process inputs', async () => {
    await withMockTexdoc(async ({ service, calls, state }) => {
      state.trusted = false;
      await assert.rejects(service.list('amsmath'), /workspace is trusted/);
      await assert.rejects(service.open(documentationPath()), /workspace is trusted/);
      state.trusted = true;
      await assert.rejects(service.list('  '), /single line/);
      await assert.rejects(service.list('amsmath\n'), /single line/);
      await assert.rejects(service.open('relative.pdf'), /absolute/);
      assert.strictEqual(calls.length, 0);
    });
  });

  test('cancels an active search and ignores late process completion', async () => {
    await withMockTexdoc(async ({ service, calls, timeouts }) => {
      const cancellation = new vscode.CancellationTokenSource();
      try {
        const result = service.list('amsmath', cancellation.token);
        const rejection = assert.rejects(result, vscode.CancellationError);
        cancellation.cancel();
        await rejection;
        assert.strictEqual(calls[0].child.killed, true);
        assert.strictEqual(timeouts.size, 0);
        calls[0].child.emit('close', 0, null);
        await assert.rejects(service.list('amsmath', cancellation.token), vscode.CancellationError);
        assert.strictEqual(calls.length, 1);
      } finally {
        cancellation.dispose();
      }
    });
  });

  test('stops searches that exceed the deadline or output limit', async () => {
    await withMockTexdoc(async ({ service, calls, timeouts }) => {
      const slow = service.list('amsmath');
      const slowRejection = assert.rejects(slow, /timed out/);
      for (const callback of timeouts.values()) {
        callback();
      }
      await slowRejection;
      assert.strictEqual(calls[0].child.killed, true);
      const large = service.list('amsmath');
      const largeRejection = assert.rejects(large, /too much output/);
      calls[1].child.stdout.emit('data', Buffer.alloc(2 * 1024 * 1024 + 1));
      await largeRejection;
      assert.strictEqual(calls[1].child.killed, true);
    });
  });

  test('opens exactly the selected absolute path without a search deadline', async () => {
    await withMockTexdoc(async ({ service, calls, timeouts }) => {
      const result = service.open(documentationPath());
      assert.deepStrictEqual(calls[0].args, ['--nointeract', '--just-view', documentationPath()]);
      assert.strictEqual(timeouts.size, 0);
      calls[0].child.emit('close', 0, null);
      await result;
    });
  });

  test('disposal cancels all active processes and prevents later execution', async () => {
    await withMockTexdoc(async ({ service, calls }) => {
      const search = service.list('amsmath');
      const viewing = service.open(documentationPath());
      const searchRejection = assert.rejects(search, vscode.CancellationError);
      const viewingRejection = assert.rejects(viewing, vscode.CancellationError);
      service.dispose();
      await Promise.all([searchRejection, viewingRejection]);
      assert.ok(calls.every(call => call.child.killed));
      await assert.rejects(service.list('amsmath'), vscode.CancellationError);
      assert.strictEqual(calls.length, 2);
    });
  });
});
