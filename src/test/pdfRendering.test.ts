import * as assert from 'assert';
import { runInNewContext, runInThisContext } from 'vm';
import * as fs from 'fs/promises';
import { createRequire } from 'module';
import * as path from 'path';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import * as vscode from 'vscode';
import InternalPDFViewer from '../compile/preview/InternalPDFViewer';

interface RenderingFixture {
  messages: { type: string; requestId?: number; message?: string }[];
  tasks: { fail(error: Error): void; complete(): void }[];
  load(requestId: number): Promise<void>;
  zoom(): Promise<void>;
  flush(): Promise<void>;
  blockNextLoad(): () => void;
}

/** Executes the real browser module with controlled PDF.js tasks, animation frames and load completion. */
async function withPageRendering(run: (fixture: RenderingFixture) => Promise<void>): Promise<void> {
  const extensionUri = vscode.Uri.parse('file:///pdf-render-errors');
  const viewer = new InternalPDFViewer({ extensionUri } as vscode.ExtensionContext);
  const webview = { cspSource: 'https://viewer.test', asWebviewUri: (uri: vscode.Uri) => uri } as vscode.Webview;
  const html = (viewer as unknown as { html(webview: vscode.Webview, root: vscode.Uri): string })
    .html(webview, vscode.Uri.joinPath(extensionUri, 'dist', 'vendor', 'pdfjs'));
  const script = html.match(/<script type="module"[^>]*>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const messages: RenderingFixture['messages'] = [];
  const tasks: RenderingFixture['tasks'] = [];
  const frames: (() => void)[] = [];
  const listeners = new Map<string, (event: { data: Record<string, unknown> }) => void>();
  const buttons = new Map<string, () => void>();
  let nextLoad: Promise<void> | undefined;
  /** Supplies only the DOM boundaries touched by the actual rendering code. */
  const element = (id?: string) => ({
    style: {}, dataset: {}, textContent: '', appendChild() {}, replaceChildren() {}, getContext() { return {}; },
    addEventListener: (type: string, callback: () => void) => { if (id) { buttons.set(`${id}:${type}`, callback); } }
  });
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 200 * scale }),
    /** Lets each test deliver completion or a late failure independently of cancellation requests. */
    render: () => {
      let fail!: (error: Error) => void;
      let complete!: () => void;
      const promise = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
      tasks.push({ fail, complete });
      return { promise, cancel() {} };
    }
  };
  const pdfjs = {
    GlobalWorkerOptions: {},
    PDFWorker: class {
      public readonly promise = Promise.resolve();
      /** Worker lifetime is independent of rendering failures in these checks. */
      public destroy(): void {}
    },
    /** Allows a newer load to remain pending while zoom still renders the previous document. */
    getDocument: () => {
      const pending = nextLoad; nextLoad = undefined;
      return { promise: (pending ?? Promise.resolve()).then(() => ({ numPages: 1, getPage: async () => page })),
        destroy: async () => {} };
    }
  };
  runInNewContext(transpileModule(script, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
  }).outputText, {
    exports: {}, require: () => pdfjs, Blob,
    URL: { createObjectURL: () => 'blob:render-worker', revokeObjectURL() {} },
    acquireVsCodeApi: () => ({ postMessage: (message: RenderingFixture['messages'][number]) => messages.push(message) }),
    document: { getElementById: element, createElement: () => element(), querySelectorAll: () => [],
      documentElement: { scrollHeight: 1000 } },
    addEventListener: (type: string, callback: (event: { data: Record<string, unknown> }) => void) => listeners.set(type, callback),
    window: { devicePixelRatio: 1 }, innerHeight: 500, innerWidth: 500, scrollY: 0, scrollTo() {},
    IntersectionObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (callback: () => void) => frames.push(callback), setTimeout, clearTimeout, performance
  }, { timeout: 1000 });
  const receive = listeners.get('message')!;
  receive({ data: { type: 'initializeWorker', data: new ArrayBuffer(0) } });
  /** Finishes queued promises before running the next frame, matching the browser's event ordering. */
  const flush = async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    for (const frame of frames.splice(0)) { frame(); }
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  try {
    await run({ messages, tasks, flush,
      load: async requestId => { receive({ data: { type: 'load', requestId, url: `https://viewer.test/${requestId}.pdf` } }); await flush(); },
      zoom: async () => { buttons.get('zoomIn:click')!(); await flush(); },
      /** Returns an explicit release for the next PDF.js document request. */
      blockNextLoad: () => { let release!: () => void; nextLoad = new Promise<void>(resolve => { release = resolve; }); return release; }
    });
  } finally { viewer.dispose(); }
}

suite('PDF rendering configuration', () => {
  test('fetches Japanese CMaps in the webview for initial loads and reloads', async () => {
    const extensionUri = vscode.Uri.parse('file:///pdf-preview-test');
    const pdfjsRoot = vscode.Uri.joinPath(extensionUri, 'dist', 'vendor', 'pdfjs');
    const webview = {
      cspSource: 'https://pdf-assets.test',
      asWebviewUri: (uri: vscode.Uri) => vscode.Uri.parse(`https://pdf-assets.test${uri.path}`)
    } as vscode.Webview;
    const viewer = new InternalPDFViewer({ extensionUri } as vscode.ExtensionContext);
    const html = (viewer as unknown as {
      html(webview: vscode.Webview, root: vscode.Uri): string;
    }).html(webview, pdfjsRoot);
    const moduleScript = html.match(/<script type="module"[^>]*>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(moduleScript, 'The viewer must have an executable module');

    type DocumentOptions = { useWorkerFetch?: boolean; cMapUrl?: string; cMapPacked?: boolean; worker?: unknown };
    type MessageHandler = (event: { data: Record<string, unknown> }) => void;
    const listeners = new Map<string, MessageHandler>();
    const messages: Array<{ type: string }> = [];
    let documentRequested: ((options: DocumentOptions) => void) | undefined;
    let destroyedDocuments = 0;
    const pdfjs = {
      GlobalWorkerOptions: { workerSrc: '' },
      PDFWorker: class {
        public readonly promise = Promise.resolve();
        public destroy(): void {}
      },
      getDocument: (options: DocumentOptions) => {
        documentRequested?.(options);
        return {
          // Stop at the PDF.js boundary: actual glyph rendering is an integration check.
          promise: new Promise<never>(() => {}),
          destroy: async () => { destroyedDocuments++; }
        };
      }
    };
    const script = transpileModule(moduleScript, {
      compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    runInNewContext(script, {
      exports: {},
      require: (uri: string) => {
        assert.strictEqual(uri, webview.asWebviewUri(vscode.Uri.joinPath(pdfjsRoot, 'pdf.min.mjs')).toString());
        return pdfjs;
      },
      Blob,
      URL: { createObjectURL: () => 'blob:pdf-worker-fixture' },
      acquireVsCodeApi: () => ({ postMessage: (message: { type: string }) => messages.push(message) }),
      document: {
        getElementById: () => ({ style: {}, textContent: '', addEventListener: () => {} })
      },
      addEventListener: (type: string, handler: MessageHandler) => listeners.set(type, handler)
    }, { timeout: 1000 });

    assert.ok(messages.some(message => message.type === 'ready'));
    const receive = listeners.get('message');
    assert.ok(receive);
    receive({ data: { type: 'initializeWorker', data: new ArrayBuffer(0) } });
    const requestDocument = () => new Promise<DocumentOptions>(resolve => {
      documentRequested = resolve;
      receive({ data: { type: 'load', url: 'https://pdf-assets.test/japanese.pdf' } });
    });

    const initial = await requestDocument();
    const reloaded = await requestDocument();
    for (const options of [initial, reloaded]) {
      // The default lets the Blob worker fetch CMaps itself, which can time out
      // and silently replace Japanese fonts with PDF.js's ErrorFont.
      assert.strictEqual(options.useWorkerFetch, false);
      assert.strictEqual(options.cMapPacked, true);
      assert.strictEqual(options.cMapUrl,
        webview.asWebviewUri(vscode.Uri.joinPath(pdfjsRoot, 'cmaps')).toString() + '/');
      assert.ok(options.worker);
    }
    assert.strictEqual(reloaded.worker, initial.worker);
    assert.strictEqual(destroyedDocuments, 1);
  });
  test('routes current automatic refresh errors and ignores obsolete browser replies', async () => {
    const filename = require.resolve('../compile/preview/InternalPDFViewer');
    const localRequire = createRequire(filename);
    const source = await fs.readFile(filename, 'utf8');
    const moduleObject = { exports: {} as { default: typeof InternalPDFViewer } };
    const pdf = vscode.Uri.file(path.resolve('viewer-report.pdf'));
    const posted: { type: string; requestId?: number }[] = [];
    const notices: (string | undefined)[] = [];
    let popupCount = 0;
    let failRead = false;
    let receive: (message: { type: string; requestId?: number; message?: string }) => Promise<void> = async () => {};
    const webview = {
      cspSource: 'https://viewer.test', html: '',
      asWebviewUri: (uri: vscode.Uri) => uri,
      onDidReceiveMessage: (listener: typeof receive) => { receive = listener; return { dispose() {} }; },
      postMessage: async (message: { type: string; requestId?: number }) => { posted.push(message); return true; }
    };
    const panel = { webview, reveal() {}, dispose() {}, onDidDispose: () => ({ dispose() {} }) };
    const load = runInThisContext(`(function(exports,require,module,__filename,__dirname){\n${source}\n})`, { filename });
    load(moduleObject.exports, (id: string) => {
      if (id === 'vscode') {
        return {
          Uri: vscode.Uri, ViewColumn: vscode.ViewColumn,
          workspace: { fs: {
            stat: async () => ({ size: 4, mtime: 1 }),
            readFile: async () => { if (failRead) { throw new Error('Read failed'); } return Buffer.from('data'); }
          } },
          window: { createWebviewPanel: () => panel, showErrorMessage: async () => { popupCount++; } }
        };
      }
      if (id === '../../WorkspaceTrust') { return { assertWorkspaceTrusted() {} }; }
      if (id === './PDFWorkerSource') {
        return class {
          /** Supplies a worker payload without touching packaged assets. */
          async read() { return new Uint8Array(); }
        };
      }
      if (id === '../../workspace') { return { uriKey: (uri: vscode.Uri) => uri.toString() }; }
      return localRequire(id);
    }, moduleObject, filename, path.dirname(filename));
    const viewer = new moduleObject.exports.default({
      extensionUri: vscode.Uri.file(path.resolve('.')), subscriptions: []
    } as unknown as vscode.ExtensionContext);
    try {
      await viewer.open(pdf, false, value => notices.push(value));
      await receive({ type: 'ready' });
      const first = posted.filter(message => message.type === 'load').at(-1)!.requestId;
      await viewer.refresh(pdf, value => notices.push(value));
      const second = posted.filter(message => message.type === 'load').at(-1)!.requestId;
      assert.notStrictEqual(first, second);
      await receive({ type: 'error', requestId: first, message: 'Obsolete' });
      assert.strictEqual(notices.length, 0);
      await receive({ type: 'error', requestId: second, message: 'Current failure' });
      await receive({ type: 'loaded', requestId: second });
      assert.deepStrictEqual(notices, ['Current failure', undefined]);
      assert.strictEqual(popupCount, 0);
      failRead = true;
      await viewer.refresh(pdf, value => notices.push(value));
      assert.strictEqual(notices.at(-1), 'Read failed');
      assert.strictEqual(popupCount, 0);
      failRead = false;
      await viewer.open(pdf, true);
      const manual = posted.filter(message => message.type === 'load').at(-1)!.requestId;
      await receive({ type: 'error', requestId: manual, message: 'Explicit viewer error' });
      assert.strictEqual(popupCount, 1);
    } finally { viewer.dispose(); }
  });

  test('tags page rendering failures with the owning PDF load on initial display and refresh', async () => {
    await withPageRendering(async f => {
      await f.load(41);
      f.tasks[0].fail(new Error('Initial page failure')); await f.flush();
      assert.strictEqual(f.messages.filter(message => message.type === 'error').at(-1)?.requestId, 41);
      await f.load(42);
      f.tasks[1].fail(new Error('Refreshed page failure')); await f.flush();
      const errors = f.messages.filter(message => message.type === 'error');
      assert.deepStrictEqual(errors.map(message => message.requestId), [41, 42]);
      assert.strictEqual(errors[1].message, 'Refreshed page failure');
    });
  });

  test('ignores old PDF and zoom failures as well as explicit PDF.js rendering cancellation', async () => {
    await withPageRendering(async f => {
      await f.load(1); await f.load(2);
      f.tasks[0].fail(new Error('Old PDF failure'));
      f.tasks[1].fail(Object.assign(new Error('Cancelled'), { name: 'RenderingCancelledException' }));
      await f.flush();
      assert.strictEqual(f.messages.filter(message => message.type === 'error').length, 0);
      await f.load(3); await f.zoom();
      f.tasks[2].fail(new Error('Old zoom failure')); await f.flush();
      assert.strictEqual(f.messages.filter(message => message.type === 'error').length, 0);
      f.tasks[3].fail(new Error('Current zoom failure')); await f.flush();
      const errors = f.messages.filter(message => message.type === 'error');
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(errors[0].requestId, 3);
      assert.strictEqual(errors[0].message, 'Current zoom failure');
    });
  });

  test('keeps the previous PDF identity when zooming while a newer document is loading', async () => {
    await withPageRendering(async f => {
      await f.load(10); f.tasks[0].complete(); await f.flush();
      const release = f.blockNextLoad();
      await f.load(11); await f.zoom();
      f.tasks[1].fail(new Error('Previous PDF during reload')); await f.flush();
      assert.strictEqual(f.messages.filter(message => message.type === 'error').at(-1)?.requestId, 10);
      release(); await f.flush();
      f.tasks[2].fail(new Error('New PDF failure')); await f.flush();
      assert.strictEqual(f.messages.filter(message => message.type === 'error').at(-1)?.requestId, 11);
    });
  });
});
