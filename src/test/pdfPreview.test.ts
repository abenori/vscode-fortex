import * as assert from 'assert';
import * as fs from 'fs/promises';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { runInThisContext } from 'vm';
import * as vscode from 'vscode';
import type PDFPreview from '../compile/preview/PDFPreview';
import LaTeXProject, { ProjectReadOptions } from '../project/LaTeXProject';
import Config from '../Config';
import * as Workspace from '../workspace';

const main = vscode.Uri.file(path.resolve('preview fixture', 'main document.tex'));
const pdf = vscode.Uri.file(path.resolve('preview fixture', 'main document.pdf'));
const child = vscode.Uri.joinPath(main, '..', 'chapters', 'child.tex');

function editor(uri: vscode.Uri) {
  return {
    document: { uri, languageId: 'latex' },
    selection: { active: { line: 5, character: 3 } },
    viewColumn: vscode.ViewColumn.One
  };
}

async function withPreview(run: (fixture: {
  preview: PDFPreview;
  state: {
    editor: ReturnType<typeof editor>;
    afterBuild: boolean;
    viewer: 'internal' | 'sumatra';
    focus: 'editor' | 'viewer';
    resolve(file: vscode.Uri | null, options?: ProjectReadOptions): Promise<vscode.Uri>;
  };
  calls: {
    resolve: (vscode.Uri | null)[];
    readers: (ProjectReadOptions['readSource'])[];
    open: [vscode.Uri, boolean][];
    forward: [vscode.Uri, vscode.Uri, number, number][];
    refresh: vscode.Uri[];
    sumatra: [string, string | undefined, number | undefined][];
  };
}) => Promise<void>): Promise<void> {
  const calls = {
    resolve: [] as (vscode.Uri | null)[],
    readers: [] as (ProjectReadOptions['readSource'])[],
    open: [] as [vscode.Uri, boolean][],
    forward: [] as [vscode.Uri, vscode.Uri, number, number][],
    refresh: [] as vscode.Uri[],
    sumatra: [] as [string, string | undefined, number | undefined][]
  };
  const state = {
    editor: editor(child), afterBuild: false,
    viewer: 'internal' as 'internal' | 'sumatra',
    focus: 'viewer' as 'editor' | 'viewer',
    resolve: async (_file: vscode.Uri | null, _options?: ProjectReadOptions): Promise<vscode.Uri> => main
  };
  const filename = require.resolve('../compile/preview/PDFPreview');
  const source = await fs.readFile(filename, 'utf8');
  const localRequire = createRequire(filename);
  const isolatedModule = { exports: {} as { default: typeof PDFPreview } };
  // Keep editor changes and viewer calls isolated from the real VS Code window.
  const load = runInThisContext(`(function (exports, require, module, __filename, __dirname) {\n${source}\n})`, { filename });
  load(isolatedModule.exports, (id: string) => {
    if (id === 'vscode') {
      return { Uri: vscode.Uri, CancellationError: vscode.CancellationError,
        window: { get activeTextEditor() { return state.editor; } } };
    }
    if (id === '../../Config') {
      return {
        pdfViewer: () => state.viewer,
        openPdfAfterBuild: () => state.afterBuild,
        syncTeXForwardSearchFocus: () => state.focus
      };
    }
    if (id === '../../project/LaTeXProject') {
      return {
        create: () => assert.fail('PDF preview must not collect a project file list'),
        resolveMainFile: async (file: vscode.Uri | null, options?: ProjectReadOptions) => {
          calls.resolve.push(file);
          calls.readers.push(options?.readSource);
          return state.resolve(file, options);
        }
      };
    }
    if (id === '../../workspace') { return { readFileText: Workspace.readFileText, uriKey: Workspace.uriKey }; }
    if (id === './InternalPDFViewer') {
      return class {
        async open(uri: vscode.Uri, preserveFocus: boolean) { calls.open.push([uri, preserveFocus]); }
        async forwardSearch(...args: [vscode.Uri, vscode.Uri, number, number]) { calls.forward.push(args); }
        async refresh(uri: vscode.Uri) { calls.refresh.push(uri); }
        dispose() {}
      };
    }
    if (id === './SumatraPDF') {
      return { open: async (...args: [string, string | undefined, number | undefined]) => { calls.sumatra.push(args); } };
    }
    if (id === '../../WorkspaceTrust') { return { assertWorkspaceTrusted() {} }; }
    return localRequire(id);
  }, isolatedModule, filename, path.dirname(filename));
  const preview = new isolatedModule.exports.default({} as vscode.ExtensionContext);
  try {
    await run({ preview, state, calls });
  } finally {
    preview.dispose();
  }
}

async function withDiskProject(
  files: Record<string, string>,
  run: (uri: (name: string) => vscode.Uri) => Promise<void>
): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fortex-preview-disk-'));
  const uri = (name: string) => vscode.Uri.file(path.join(directory, name));
  const originalOrder = Config.mainFileOrder;
  const originalTrigger = Config.compileTrigger;
  Config.mainFileOrder = () => ['magic', 'guess', 'current'];
  // Real saves exercise persisted source without starting a build in the host.
  Config.compileTrigger = () => [];
  try {
    for (const [name, source] of Object.entries(files)) {
      await fs.writeFile(uri(name).fsPath, source, 'utf8');
    }
    await run(uri);
  } finally {
    Config.mainFileOrder = originalOrder;
    Config.compileTrigger = originalTrigger;
    const target = path.resolve(directory);
    assert.strictEqual(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('fortex-preview-disk-'));
    await fs.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

async function replaceBuffer(document: vscode.TextDocument, source: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), source);
  assert.ok(await vscode.workspace.applyEdit(edit));
}

suite('PDF preview routing', () => {
  test('opens the main PDF using only main-file resolution', async () => {
    await withPreview(async ({ preview, calls }) => {
      await preview.viewCurrent('internal');
      assert.deepStrictEqual(calls.resolve, [child]);
      assert.deepStrictEqual(calls.readers, [Workspace.readFileText]);
      assert.deepStrictEqual(calls.open.map(([uri, focus]) => [uri.fsPath, focus]), [[pdf.fsPath, false]]);
      assert.strictEqual(calls.forward.length, 0);
    });
  });

  test('uses the saved main directive and sees its next saved change', async () => {
    await withDiskProject({
      'child.tex': '%#main a.tex\nChild body.\n',
      'a.tex': '\\documentclass{article}\n\\input{child}\n',
      'b.tex': '\\documentclass{book}\n\\input{child}\n'
    }, async uri => {
      const document = await vscode.workspace.openTextDocument(uri('child.tex'));
      await replaceBuffer(document, '%#main b.tex\nUnsaved child body.\n');
      assert.ok(document.isDirty);
      await withPreview(async ({ preview, state, calls }) => {
        state.editor = editor(document.uri);
        state.resolve = (file, options) => LaTeXProject.resolveMainFile(file, options);
        await preview.viewCurrent('internal');
        assert.strictEqual(calls.open[0][0].fsPath, uri('a.pdf').fsPath,
          'An unsaved %#main must not select a different PDF');
        assert.ok(await document.save());
        assert.match(await fs.readFile(document.uri.fsPath, 'utf8'), /^%#main b\.tex/);
        await preview.viewCurrent('internal');
        assert.strictEqual(calls.open[1][0].fsPath, uri('b.pdf').fsPath,
          'A new request must read the newly saved directive');
      });
    });
  });

  test('ignores unsaved candidate classes and direct or nested input edits during main discovery', async () => {
    const candidate = '\\documentclass{article}\n\\input{middle}\n';
    await withDiskProject({
      'a.tex': candidate,
      'b.tex': '\\documentclass{book}\n\\include{child}\n',
      'middle.tex': '\\input{child}\n',
      'child.tex': 'Child body.\n'
    }, async uri => {
      Config.mainFileOrder = () => ['guess', 'current'];
      const first = await vscode.workspace.openTextDocument(uri('a.tex'));
      const middle = await vscode.workspace.openTextDocument(uri('middle.tex'));
      await withPreview(async ({ preview, state, calls }) => {
        state.editor = editor(uri('child.tex'));
        state.resolve = (file, options) => LaTeXProject.resolveMainFile(file, options);
        await replaceBuffer(first, '\\input{middle}\n');
        await preview.viewCurrent('internal');
        await replaceBuffer(first, '\\documentclass{article}\n\\include{missing}\n');
        await preview.viewCurrent('internal');
        await replaceBuffer(first, candidate);
        await replaceBuffer(middle, '\\input{missing}\n');
        assert.ok(middle.isDirty);
        await preview.viewCurrent('internal');
        assert.deepStrictEqual(calls.open.map(([target]) => target.fsPath), [uri('a.pdf').fsPath, uri('a.pdf').fsPath, uri('a.pdf').fsPath]);
        assert.ok(await middle.save());
        await preview.viewCurrent('internal');
        assert.strictEqual(calls.open[3][0].fsPath, uri('b.pdf').fsPath,
          'A saved include change must affect subsequent parent discovery');
      });
    });
  });

  test('propagates main-discovery errors and cancellation without opening a viewer', async () => {
    for (const error of [new Error('Unable to read saved source'), new vscode.CancellationError()]) {
      await withPreview(async ({ preview, state, calls }) => {
        state.resolve = async (_file, options) => {
          assert.strictEqual(options?.readSource, Workspace.readFileText);
          throw error;
        };
        await assert.rejects(preview.viewCurrent('internal', true), candidate => candidate === error);
        assert.strictEqual(calls.open.length, 0);
        assert.strictEqual(calls.forward.length, 0);
        assert.strictEqual(calls.sumatra.length, 0);
      });
    }
  });

  for (const viewer of ['internal', 'sumatra'] as const) {
    test(`preserves the original SyncTeX source while resolving the main for ${viewer}`, async () => {
      await withPreview(async ({ preview, state, calls }) => {
        state.focus = viewer === 'internal' ? 'editor' : 'viewer';
        state.resolve = async file => {
          assert.strictEqual(file, child);
          await Promise.resolve();
          state.editor = editor(vscode.Uri.joinPath(main, '..', 'other.tex'));
          return main;
        };
        await preview.viewCurrent(viewer, true);
        assert.deepStrictEqual(calls.resolve, [child]);
        if (viewer === 'internal') {
          assert.deepStrictEqual(calls.open.map(([uri, focus]) => [uri.fsPath, focus]), [[pdf.fsPath, true]]);
          assert.deepStrictEqual(calls.forward.map(([target, source, line, column]) =>
            [target.fsPath, source.fsPath, line, column]), [[pdf.fsPath, child.fsPath, 6, 4]]);
          assert.strictEqual(calls.sumatra.length, 0);
        } else {
          assert.deepStrictEqual(calls.sumatra, [[pdf.fsPath, child.fsPath, 6]]);
          assert.strictEqual(calls.open.length, 0);
        }
      });
    });
  }

  test('refreshes or opens the built main without resolving or collecting again', async () => {
    await withPreview(async ({ preview, state, calls }) => {
      const pdfs = [pdf];
      await preview.onBuildComplete(pdfs);
      assert.deepStrictEqual(calls.refresh.map(uri => uri.fsPath), [pdf.fsPath]);
      assert.strictEqual(calls.open.length, 0);
      state.afterBuild = true;
      await preview.onBuildComplete(pdfs);
      assert.deepStrictEqual(calls.open.map(([uri, focus]) => [uri.fsPath, focus]), [[pdf.fsPath, false]]);
      state.viewer = 'sumatra';
      await preview.onBuildComplete(pdfs);
      assert.deepStrictEqual(calls.sumatra, [[pdf.fsPath, undefined, undefined]]);
      assert.strictEqual(calls.resolve.length, 0);
    });
  });
});
