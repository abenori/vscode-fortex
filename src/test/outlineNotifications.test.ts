import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { runInThisContext } from 'vm';
import * as vscode from 'vscode';
import Config from '../Config';
import LaTeXProject from '../project/LaTeXProject';
import StructureService from '../structure/StructureService';
import LaTeXDocumentSymbolProvider, { registerDocumentSymbols } from '../structure/LaTeXDocumentSymbolProvider';
import { StructureSnapshot } from '../structure/StructureTypes';

async function edit(document: vscode.TextDocument, start: number, end: number, text: string): Promise<void> {
  const change = new vscode.WorkspaceEdit();
  change.replace(document.uri, new vscode.Range(document.positionAt(start), document.positionAt(end)), text);
  assert.ok(await vscode.workspace.applyEdit(change));
}

async function withSource(
  body: string,
  run: (document: vscode.TextDocument, service: StructureService, provider: LaTeXDocumentSymbolProvider) => Promise<void>
): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fortex-outline-notifications-'));
  const uri = vscode.Uri.file(path.join(directory, 'main.tex'));
  const service = new StructureService(false);
  const provider = new LaTeXDocumentSymbolProvider(service);
  const originalTrigger = Config.compileTrigger;
  Config.compileTrigger = () => [];
  try {
    await fs.writeFile(uri.fsPath, `\\documentclass{article}\n${body}`, 'utf8');
    const document = await vscode.workspace.openTextDocument(uri);
    await service.refresh(document);
    await provider.provideDocumentSymbols(document);
    await run(document, service, provider);
  } finally {
    provider.dispose();
    service.dispose();
    Config.compileTrigger = originalTrigger;
    assert.strictEqual(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('fortex-outline-notifications-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

async function save(document: vscode.TextDocument, service: StructureService): Promise<void> {
  assert.ok(await document.save());
  await service.current();
}

suite('Native Outline change notifications', function () {
  this.timeout(30000);

  test('does not invalidate native symbols when a dirty document saves the original bytes', async () => {
    await withSource('\\section{Stable}\nBody\n', async (document, service, provider) => {
      const original = document.getText();
      let notifications = 0;
      let projectPublications = 0;
      const subscriptions = vscode.Disposable.from(
        service.onDidChangeDocumentSymbols(() => { notifications++; }),
        service.onDidChange(() => { projectPublications++; })
      );
      try {
        await edit(document, original.length, original.length, 'Temporary body');
        await provider.provideDocumentSymbols(document);
        await edit(document, original.length, document.getText().length, '');
        assert.strictEqual(document.getText(), original);
        assert.ok(document.isDirty, 'The original bytes must be written through the actual save path');
        const beforeSave = await provider.provideDocumentSymbols(document);
        assert.strictEqual(notifications, 0, 'Typing must not invalidate the native provider');
        await save(document, service);
        assert.strictEqual(notifications, 0, 'Repeated saved bytes do not change the effective symbols');
        assert.strictEqual(projectPublications, 0, 'An unchanged source save does not rebuild the project tree');
        assert.strictEqual(await provider.provideDocumentSymbols(document), beforeSave,
          'An unchanged native result retains its converted symbols');
      } finally { subscriptions.dispose(); }
    });
  });

  test('keeps already projected symbol positions when saving body edits', async () => {
    await withSource('\\section{Stable}\nBody\n\\subsection{Nested}\nTail\n', async (document, service, provider) => {
      let notifications = 0;
      const subscription = service.onDidChangeDocumentSymbols(() => { notifications++; });
      try {
        await edit(document, 0, 0, '前文 😀\r\n');
        await edit(document, document.getText().length, document.getText().length, 'More body\n');
        const beforeSave = await provider.provideDocumentSymbols(document);
        assert.strictEqual(document.getText(beforeSave[0].selectionRange), '\\section{Stable}');
        assert.strictEqual(document.getText(beforeSave[0].children[0].selectionRange), '\\subsection{Nested}');
        await save(document, service);
        assert.strictEqual(notifications, 0, 'The save does not change the current projected symbols');
        assert.deepStrictEqual(await provider.provideDocumentSymbols(document), beforeSave);
      } finally { subscription.dispose(); }
    });
  });

  test('notifies once for a newly saved heading while title edits are already reflected live', async () => {
    await withSource('\\section{Before}\nBody\n\\section{Retained}\n', async (document, service, provider) => {
      const notified: vscode.Uri[] = [];
      let projectPublications = 0;
      const subscriptions = vscode.Disposable.from(
        service.onDidChangeDocumentSymbols(uri => { notified.push(uri); }),
        service.onDidChange(() => { projectPublications++; })
      );
      try {
        const offset = document.getText().indexOf('Before');
        await edit(document, offset, offset + 'Before'.length, 'After');
        await edit(document, document.getText().length, document.getText().length, '\\section{New heading}\n');
        assert.deepStrictEqual((await provider.provideDocumentSymbols(document)).map(symbol => symbol.name), ['After', 'Retained']);
        assert.strictEqual(notified.length, 0);
        await save(document, service);
        assert.deepStrictEqual((await provider.provideDocumentSymbols(document)).map(symbol => symbol.name), ['After', 'Retained', 'New heading']);
        assert.deepStrictEqual(notified.map(uri => uri.toString()), [document.uri.toString()]);
        assert.ok(projectPublications >= 1, 'The project tree is still published independently');
        const savedPublications = projectPublications;
        const internals = service as unknown as {
          refreshSource(uri: vscode.Uri, document: vscode.TextDocument): Promise<void>;
        };
        // A filesystem notification can arrive after didSave has already
        // published. Exercise the shared source-update path for those bytes.
        await internals.refreshSource(document.uri, document);
        await service.current();
        assert.strictEqual(projectPublications, savedPublications,
          'A delayed notification for the same saved bytes must not rebuild the project');
        assert.strictEqual(notified.length, 1, 'The duplicate source notification does not invalidate native symbols');
        await service.refresh(document);
        assert.strictEqual(notified.length, 1, 'A project-only refresh must not invalidate native symbols');
      } finally { subscriptions.dispose(); }
    });
  });

  test('keeps title edits and restoration visible without save-triggered invalidation', async () => {
    await withSource('\\section{Original}\nBody\n', async (document, service, provider) => {
      const original = document.getText();
      let notifications = 0;
      const subscription = service.onDidChangeDocumentSymbols(() => { notifications++; });
      try {
        const offset = original.indexOf('Original');
        await edit(document, offset, offset + 'Original'.length, 'Temporary');
        assert.deepStrictEqual((await provider.provideDocumentSymbols(document)).map(symbol => symbol.name), ['Temporary']);
        await edit(document, offset, offset + 'Temporary'.length, 'Original');
        assert.strictEqual(document.getText(), original);
        assert.ok(document.isDirty);
        assert.deepStrictEqual((await provider.provideDocumentSymbols(document)).map(symbol => symbol.name), ['Original']);
        assert.strictEqual(notifications, 0);
        await save(document, service);
        assert.deepStrictEqual((await provider.provideDocumentSymbols(document)).map(symbol => symbol.name), ['Original']);
        assert.strictEqual(notifications, 0, 'Saving unchanged bytes does not invalidate an already restored title');
      } finally { subscription.dispose(); }
    });
  });

  test('retries a failed project refresh on a same-byte save without invalidating native symbols', async () => {
    await withSource('\\section{Retained}\nBody\n', async (document, service, provider) => {
      const originalResolver = LaTeXProject.resolveMainFile;
      const original = document.getText();
      const initialRoots = service.snapshot!.roots;
      let fail = true;
      let discoveries = 0;
      let notifications = 0;
      const subscription = service.onDidChangeDocumentSymbols(() => { notifications++; });
      LaTeXProject.resolveMainFile = async () => {
        discoveries++;
        if (fail) { throw new Error('Controlled project discovery failure'); }
        return document.uri;
      };
      try {
        await service.refresh(document);
        assert.strictEqual(service.snapshot!.roots, initialRoots);
        assert.match(service.snapshot!.message ?? '', /Controlled project discovery failure/);
        fail = false;
        await edit(document, original.length, original.length, 'Temporary body');
        await edit(document, original.length, document.getText().length, '');
        assert.ok(document.isDirty);
        await save(document, service);
        assert.strictEqual(discoveries, 2, 'The unchanged source save retries the failed project operation');
        assert.strictEqual(service.snapshot!.message, undefined);
        assert.deepStrictEqual((await provider.provideDocumentSymbols(document)).map(symbol => symbol.name), ['Retained']);
        assert.strictEqual(notifications, 0, 'Recovery of the project view does not change local native symbols');
      } finally {
        LaTeXProject.resolveMainFile = originalResolver;
        subscription.dispose();
      }
    });
  });

  test('registers native symbols only for native-output notifications', async () => {
    const changed = new vscode.EventEmitter<StructureSnapshot | undefined>();
    const documentSymbolsChanged = new vscode.EventEmitter<vscode.Uri>();
    let registrations = 0;
    let removals = 0;
    const service = {
      onDidChange: changed.event,
      onDidChangeDocumentSymbols: documentSymbolsChanged.event
    } as unknown as StructureService;
    const filename = require.resolve('../structure/LaTeXDocumentSymbolProvider');
    const source = await fs.readFile(filename, 'utf8');
    const localRequire = createRequire(filename);
    const isolatedModule = { exports: {} as { registerDocumentSymbols: typeof registerDocumentSymbols } };
    const load = runInThisContext(`(function (exports, require, module, __filename, __dirname) {\n${source}\n})`, { filename });
    load(isolatedModule.exports, (id: string) => id === 'vscode' ? {
      Disposable: vscode.Disposable,
      languages: {
        registerDocumentSymbolProvider: () => {
          registrations++;
          return new vscode.Disposable(() => { removals++; });
        }
      }
    } : localRequire(id), isolatedModule, filename, path.dirname(filename));
    const registration = isolatedModule.exports.registerDocumentSymbols(service);
    try {
      assert.strictEqual(registrations, 1);
      changed.fire(undefined);
      assert.strictEqual(registrations, 1, 'Project snapshots do not affect the local symbol provider');
      documentSymbolsChanged.fire(vscode.Uri.file('/native-symbols.tex'));
      assert.strictEqual(registrations, 2, 'A native output change explicitly invalidates VS Code symbols');
      assert.strictEqual(removals, 1);
    } finally {
      registration.dispose();
      changed.dispose();
      documentSymbolsChanged.dispose();
    }
    assert.strictEqual(removals, registrations);
  });
});
