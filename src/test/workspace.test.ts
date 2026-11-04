import * as assert from 'assert';
import * as fs from 'fs/promises';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { runInThisContext } from 'vm';
import * as vscode from 'vscode';
import * as Workspace from '../workspace';

type WorkspaceModule = typeof import('../workspace');

function buffer(uri: vscode.Uri, text: string, isClosed = false): vscode.TextDocument {
  return { uri, isClosed, getText: () => text } as unknown as vscode.TextDocument;
}

async function withMockReader(
  documents: vscode.TextDocument[],
  read: (uri: vscode.Uri) => Promise<Uint8Array>,
  run: (reader: WorkspaceModule, reads: vscode.Uri[]) => Promise<void>
): Promise<void> {
  const reads: vscode.Uri[] = [];
  const fakeVscode = {
    workspace: {
      textDocuments: documents,
      fs: { readFile: async (uri: vscode.Uri) => { reads.push(uri); return read(uri); } }
    }
  };
  // Keep the shared entry point, reader and URI policy on the same facade without changing VS Code's
  // frozen workspace API or replacing the extension host's global module cache.
  const filename = require.resolve('../workspace');
  const filenames = [filename, require.resolve('../workspace/DocumentText'), require.resolve('../workspace/UriIdentity')];
  const sources = new Map(await Promise.all(filenames.map(async file => [file, await fs.readFile(file, 'utf8')] as const)));
  const modules = new Map<string, { exports: unknown }>();
  const loadModule = (file: string): unknown => {
    const existing = modules.get(file);
    if (existing) { return existing.exports; }
    const isolatedModule = { exports: {} };
    modules.set(file, isolatedModule);
    const localRequire = createRequire(file);
    const load = runInThisContext(`(function (exports, require, module, __filename, __dirname) {\n${sources.get(file)}\n})`, { filename: file });
    load(isolatedModule.exports, (id: string) => {
      if (id === 'vscode') { return fakeVscode; }
      const dependency = localRequire.resolve(id);
      return sources.has(dependency) ? loadModule(dependency) : localRequire(id);
    }, isolatedModule, file, path.dirname(file));
    return isolatedModule.exports;
  };
  await run(loadModule(filename) as WorkspaceModule, reads);
}

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fortex-document-text-'));
  try {
    await run(directory);
  } finally {
    assert.strictEqual(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('fortex-document-text-'));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function replaceDocument(document: vscode.TextDocument, text: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
  assert.ok(await vscode.workspace.applyEdit(edit));
}

suite('Workspace URI identity and document text', () => {
  test('normalizes local dot segments and folds local path case only on Windows', () => {
    const directory = path.join(os.tmpdir(), 'Fortex-Uri-Identity');
    const direct = vscode.Uri.file(`${directory}${path.sep}Main.tex`);
    const dotted = vscode.Uri.file(`${directory}${path.sep}chapters${path.sep}..${path.sep}Main.tex`);
    const otherCase = direct.with({ path: direct.path.replace('Main.tex', 'main.tex') });
    assert.strictEqual(Workspace.uriKey(dotted), Workspace.uriKey(direct));
    if (process.platform === 'win32') {
      assert.strictEqual(Workspace.uriKey(otherCase), Workspace.uriKey(direct));
    } else {
      assert.notStrictEqual(Workspace.uriKey(otherCase), Workspace.uriKey(direct));
    }
  });

  test('preserves case and URI components for remote and untitled resources', () => {
    const remote = vscode.Uri.parse('vscode-remote://ssh-remote+Host/Project/Main.tex?Mode=One#PartA');
    assert.strictEqual(Workspace.uriKey(remote), remote.toString());
    for (const different of [
      remote.with({ path: '/project/main.tex' }),
      remote.with({ query: 'mode=one' }),
      remote.with({ fragment: 'parta' })
    ]) {
      assert.notStrictEqual(Workspace.uriKey(different), Workspace.uriKey(remote));
    }
    const untitled = vscode.Uri.parse('untitled:Draft.tex');
    assert.strictEqual(Workspace.uriKey(untitled), untitled.toString());
    assert.notStrictEqual(Workspace.uriKey(untitled), Workspace.uriKey(vscode.Uri.parse('untitled:draft.tex')));
  });

  test('ignores closed documents and prefers an open buffer without reading the source', async () => {
    const uri = vscode.Uri.parse('vscode-remote://test/Project/Main.tex');
    const closed = buffer(uri, 'Closed contents', true);
    const open = buffer(uri, 'Unsaved contents');
    await withMockReader([closed, open], async () => assert.fail('An open buffer must avoid a source read'), async (Workspace, reads) => {
      assert.strictEqual(Workspace.findOpenDocument(uri), open);
      assert.strictEqual(await Workspace.readDocumentText(uri), 'Unsaved contents');
      assert.deepStrictEqual(reads, []);
    });
  });

  test('uses the same local alias and remote case policy when finding open documents', async () => {
    const local = vscode.Uri.file(path.join(os.tmpdir(), 'Fortex-Document-Lookup', 'Main.tex'));
    const localAlias = local.with({ path: local.path.replace('Main.tex', 'main.tex') });
    const remote = vscode.Uri.parse('vscode-remote://test/Project/Main.tex');
    const remoteAlias = remote.with({ path: '/project/main.tex' });
    const localDocument = buffer(local, 'Local buffer');
    const remoteDocument = buffer(remote, 'Remote buffer');
    await withMockReader([localDocument, remoteDocument], async () => Buffer.from('Source contents'), async (Workspace, reads) => {
      assert.strictEqual(Workspace.findOpenDocument(localAlias), process.platform === 'win32' ? localDocument : undefined);
      assert.strictEqual(await Workspace.readDocumentText(localAlias), process.platform === 'win32' ? 'Local buffer' : 'Source contents');
      assert.strictEqual(Workspace.findOpenDocument(remote), remoteDocument);
      assert.strictEqual(Workspace.findOpenDocument(remoteAlias), undefined);
      assert.strictEqual(await Workspace.readDocumentText(remoteAlias), 'Source contents');
      assert.strictEqual(reads.at(-1)?.toString(), remoteAlias.toString());
    });
  });

  test('falls back to UTF-8 source text when only closed buffers exist', async () => {
    const uri = vscode.Uri.parse('vscode-remote://test/source.tex');
    const text = '日本語 😀\r\n\\section{Source}\r\n';
    await withMockReader([buffer(uri, 'Stale closed contents', true)], async () => Buffer.from(text, 'utf8'), async (Workspace, reads) => {
      assert.strictEqual(Workspace.findOpenDocument(uri), undefined);
      assert.strictEqual(await Workspace.readDocumentText(uri), text);
      assert.deepStrictEqual(reads.map(read => read.toString()), [uri.toString()]);
    });
  });

  test('propagates source read failures to the caller', async () => {
    const uri = vscode.Uri.parse('vscode-remote://test/unavailable.tex');
    const failure = new Error('The remote source is unavailable');
    await withMockReader([], async () => { throw failure; }, async (Workspace, reads) => {
      await assert.rejects(Workspace.readDocumentText(uri), error => error === failure);
      assert.deepStrictEqual(reads.map(read => read.toString()), [uri.toString()]);
    });
  });

  test('reads saved UTF-8 text on each request even when an editor buffer is open', async () => {
    const uri = vscode.Uri.parse('vscode-remote://test/Project/Saved.tex');
    const open = buffer(uri, 'Unsaved contents');
    open.getText = () => assert.fail('Saved source reads must never inspect the editor buffer');
    let saved = '保存済み 😀\r\n\\section{First}';
    await withMockReader([open], async () => Buffer.from(saved, 'utf8'), async (Workspace, reads) => {
      assert.strictEqual(await Workspace.readFileText(uri), saved);
      saved = '\\section{Saved again}';
      assert.strictEqual(await Workspace.readFileText(uri), saved);
      assert.deepStrictEqual(reads.map(read => read.toString()), [uri.toString(), uri.toString()]);
    });
  });

  test('propagates saved source failures instead of falling back to an open buffer', async () => {
    const uri = vscode.Uri.parse('vscode-remote://test/deleted.tex');
    const failure = new Error('Saved source no longer exists');
    await withMockReader([buffer(uri, 'An unsaved buffer still exists')], async () => { throw failure; }, async (Workspace) => {
      await assert.rejects(Workspace.readFileText(uri), error => error === failure);
    });
  });

  test('reads real files and preserves unsaved and empty editor contents over saved text', async () => {
    await withTempDirectory(async directory => {
      const uri = vscode.Uri.file(path.join(directory, 'source.tex'));
      const saved = 'Saved 日本語 😀\r\n\\section{Saved}';
      await fs.writeFile(uri.fsPath, saved, 'utf8');
      assert.strictEqual(Workspace.findOpenDocument(uri), undefined);
      assert.strictEqual(await Workspace.readDocumentText(uri), saved);
      const document = await vscode.workspace.openTextDocument(uri);
      assert.strictEqual(Workspace.findOpenDocument(uri), document);
      const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
      const unsaved = `\\section{Unsaved}${eol}本文`;
      await replaceDocument(document, unsaved);
      assert.ok(document.isDirty);
      assert.strictEqual(document.getText(), unsaved);
      assert.strictEqual(await Workspace.readDocumentText(uri), document.getText());
      assert.strictEqual(await Workspace.readFileText(uri), saved);
      await replaceDocument(document, '');
      assert.strictEqual(await Workspace.readDocumentText(uri), '');
      assert.strictEqual(await Workspace.readFileText(uri), saved);
      assert.strictEqual(await fs.readFile(uri.fsPath, 'utf8'), saved);
      await assert.rejects(Workspace.readDocumentText(vscode.Uri.file(path.join(directory, 'missing.tex'))));
    });
  });
});
