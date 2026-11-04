import * as assert from 'assert';
import * as vscode from 'vscode';
import StructureService from '../structure/StructureService';
import { StructureNode } from '../structure/StructureTypes';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Thenable<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve(promise), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), 10000);
    })]);
  } finally { clearTimeout(timer); }
}

interface ReadGate {
  started: ReturnType<typeof deferred<string>>;
  release: ReturnType<typeof deferred<void>>;
  source?: string;
}

/** Real VS Code saves use this provider; gates pause actual I/O, not the service. */
class GatedSourceProvider implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly events = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.events.event;
  bytes: Uint8Array;
  private timestamp = Date.now();
  writeGate?: ReadGate;
  readGate?: ReadGate;
  failReads = false;

  constructor(source: string) { this.bytes = Buffer.from(source); }
  watch(): vscode.Disposable { return new vscode.Disposable(() => {}); }
  stat(uri: vscode.Uri): vscode.FileStat {
    if (uri.path !== '/' && uri.path !== '/source.tex') { throw vscode.FileSystemError.FileNotFound(uri); }
    return { type: uri.path === '/' ? vscode.FileType.Directory : vscode.FileType.File,
      ctime: this.timestamp, mtime: this.timestamp, size: this.bytes.byteLength };
  }
  readDirectory(): [string, vscode.FileType][] { return [['source.tex', vscode.FileType.File]]; }
  async readFile(): Promise<Uint8Array> {
    if (this.failReads) { throw vscode.FileSystemError.Unavailable('Controlled saved-source read failure'); }
    const bytes = Uint8Array.from(this.bytes);
    const gate = this.readGate;
    const source = Buffer.from(bytes).toString('utf8');
    if (gate && (gate.source === undefined || gate.source === source)) {
      // VS Code and another StructureService can also read this provider. Hold
      // every copy of the targeted old snapshot, not merely the first caller.
      gate.source ??= source;
      gate.started.resolve(source);
      await gate.release.promise;
      if (this.readGate === gate) { this.readGate = undefined; }
    }
    return bytes;
  }
  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const bytes = Uint8Array.from(content);
    const gate = this.writeGate;
    if (gate) {
      this.writeGate = undefined;
      gate.started.resolve(Buffer.from(bytes).toString('utf8'));
      await gate.release.promise;
    }
    this.bytes = bytes;
    this.timestamp++;
    this.events.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }
  createDirectory(): void {}
  delete(): void { throw vscode.FileSystemError.NoPermissions(); }
  rename(): void { throw vscode.FileSystemError.NoPermissions(); }
  holdWrite(): ReadGate { return this.writeGate = { started: deferred<string>(), release: deferred<void>() }; }
  holdRead(source?: string): ReadGate { return this.readGate = { started: deferred<string>(), release: deferred<void>(), source }; }
  dispose(): void { this.events.dispose(); }
}

function headings(nodes: readonly StructureNode[]): StructureNode[] {
  return nodes.flatMap(node => [...(node.kind === 'section' ? [node] : []), ...headings(node.children)]);
}

async function replace(document: vscode.TextDocument, source: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), source);
  assert.ok(await vscode.workspace.applyEdit(edit));
}

let nextScheme = 0;
async function withSource(
  initial: string,
  run: (provider: GatedSourceProvider, document: vscode.TextDocument, service: StructureService) => Promise<void>
): Promise<void> {
  const provider = new GatedSourceProvider(initial);
  const registration = vscode.workspace.registerFileSystemProvider(`fortex-outline-race-${++nextScheme}`, provider,
    { isCaseSensitive: true });
  const uri = vscode.Uri.parse(`fortex-outline-race-${nextScheme}:/source.tex`);
  let service: StructureService | undefined;
  try {
    const document = await vscode.languages.setTextDocumentLanguage(await vscode.workspace.openTextDocument(uri), 'latex');
    service = new StructureService(false);
    await service.refresh(document);
    await run(provider, document, service);
  } finally {
    provider.writeGate?.release.resolve();
    provider.readGate?.release.resolve();
    service?.dispose();
    registration.dispose();
    provider.dispose();
  }
}

suite('Saved outline I/O boundaries', function () {
  this.timeout(30000);

  test('uses bytes actually written when a body edit arrives during save and waits for the source read', async () => {
    const saved = '\\section{Saved heading}\nBody.\n';
    await withSource('\\section{Initial heading}\nBody.\n', async (provider, document, service) => {
      await replace(document, saved);
      const gate = provider.holdWrite();
      const pendingSave = document.save();
      try {
        assert.strictEqual(await bounded(gate.started.promise, 'the actual save write'), saved);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, new vscode.Position(0, 0), '😀 concurrent body\r\n');
        assert.ok(await vscode.workspace.applyEdit(edit));
        gate.release.resolve();
        await bounded(pendingSave, 'save with a concurrent edit');
        const local = await service.getDocumentHeadings(document);
        const snapshot = (await service.current())!;
        assert.strictEqual(Buffer.from(provider.bytes).toString('utf8'), saved);
        assert.deepStrictEqual(headings(snapshot.roots).map(node => node.title), ['Saved heading']);
        assert.deepStrictEqual(local.map(node => node.title), ['Saved heading']);
        assert.strictEqual(document.getText().slice(local[0].declarationRange.start, local[0].declarationRange.end), '\\section{Saved heading}');
        assert.notStrictEqual(document.getText(), saved, 'The actual disk snapshot remains separate from the live buffer');
        assert.deepStrictEqual(service.projectLocation(headings(snapshot.roots)[0].declarationRange), local[0].declarationRange);
      } finally { gate.release.resolve(); await pendingSave; }
    });
  });

  test('keeps the saved project baseline and a navigable heading when a newer title is edited during save', async () => {
    const saved = '\\section{Saved heading}\n';
    const unsaved = '\\section{Not yet saved heading}\n';
    await withSource('\\section{Initial}\n', async (provider, document, service) => {
      await replace(document, saved);
      const gate = provider.holdWrite();
      const pendingSave = document.save();
      try {
        await bounded(gate.started.promise, 'the earlier saved heading write');
        await replace(document, unsaved);
        gate.release.resolve();
        await bounded(pendingSave, 'save of the earlier heading');
        const snapshot = (await service.current())!;
        assert.strictEqual(Buffer.from(provider.bytes).toString('utf8'), saved);
        assert.deepStrictEqual(headings(snapshot.roots).map(node => node.title), ['Saved heading']);
        assert.strictEqual((await service.getDocumentHeadings(document)).length, 1, 'A title edit must not remove the saved heading');
        const target = service.projectLocation(headings(snapshot.roots)[0].declarationRange);
        assert.strictEqual(document.getText().slice(target.start, target.end), unsaved.trimEnd());
        await bounded(document.save(), 'the subsequent save of the newer heading');
        assert.deepStrictEqual((await service.getDocumentHeadings(document)).map(node => node.title), ['Not yet saved heading']);
        const latest = (await service.current())!;
        assert.deepStrictEqual(service.projectLocation(headings(latest.roots)[0].declarationRange), headings(latest.roots)[0].declarationRange);
      } finally { gate.release.resolve(); await pendingSave; }
    });
  });

  test('keeps the published live title when a later title edit arrives during the actual save write', async () => {
    const saved = '\\section{Saved heading}\n';
    const newestTitle = 'Not yet saved heading';
    await withSource('\\section{Initial}\n', async (provider, document, service) => {
      const originalNode = headings(service.snapshot!.roots)[0];
      const rename = async (before: string, after: string) => {
        const offset = document.getText().indexOf(before);
        assert.ok(offset >= 0);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(document.positionAt(offset), document.positionAt(offset + before.length)), after);
        assert.ok(await vscode.workspace.applyEdit(edit));
      };
      await rename('Initial', 'Saved heading');
      assert.strictEqual(service.projectNode(originalNode).title, 'Saved heading');
      const gate = provider.holdWrite();
      const pendingSave = document.save();
      let subscription: vscode.Disposable | undefined;
      try {
        assert.strictEqual(await bounded(gate.started.promise, 'the captured heading write'), saved);
        await rename('Saved heading', newestTitle);
        assert.strictEqual(service.projectNode(originalNode).title, newestTitle);
        const observed = deferred<{ oldTree: boolean; title: string; targetText: string }>();
        subscription = service.onDidChangeLiveSources(uri => {
          if (uri.toString() !== document.uri.toString() || Buffer.from(provider.bytes).toString('utf8') !== saved) { return; }
          // This notification follows the source commit but precedes the new
          // project-tree publication. Do not wait for current() before sampling.
          const projected = service.projectNode(originalNode);
          const target = service.projectLocation(originalNode.declarationRange);
          observed.resolve({ oldTree: headings(service.snapshot!.roots)[0] === originalNode,
            title: projected.title, targetText: document.getText().slice(target.start, target.end) });
        });
        gate.release.resolve();
        await bounded(pendingSave, 'the earlier heading save');
        assert.deepStrictEqual(await bounded(observed.promise, 'the source-commit live notification'), {
          oldTree: true, title: newestTitle, targetText: `\\section{${newestTitle}}`
        });
        const snapshot = (await service.current())!;
        const node = headings(snapshot.roots)[0];
        assert.strictEqual(node.title, 'Saved heading', 'The project hierarchy records the actual saved bytes');
        assert.strictEqual(service.projectNode(node).title, newestTitle);
        const target = service.projectLocation(node.declarationRange);
        assert.deepStrictEqual(service.projectNode(node).declarationRange, target);
        assert.strictEqual(document.getText().slice(target.start, target.end), `\\section{${newestTitle}}`);
        assert.strictEqual((await service.getDocumentHeadings(document))[0].title, newestTitle);
      } finally {
        subscription?.dispose();
        gate.release.resolve();
        await pendingSave;
      }
    });
  });

  test('rejects a saved-source read that completes after a newer save has already published', async () => {
    await withSource('\\section{Initial}\n', async (provider, document, service) => {
      await replace(document, '\\section{First save}\n');
      const gate = provider.holdRead('\\section{First save}\n');
      const firstSave = document.save();
      try {
        assert.strictEqual(await bounded(gate.started.promise, 'the first saved-source read'), '\\section{First save}\n');
        await bounded(firstSave, 'the first disk save');
        let waiterSettled = false;
        const waitingForSource = service.getDocumentHeadings(document).then(nodes => { waiterSettled = true; return nodes; });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.strictEqual(waiterSettled, false, 'The tested service must actually be waiting for the blocked old snapshot');
        await replace(document, '\\section{Second save}\n');
        await bounded(document.save(), 'the newer disk save');
        assert.deepStrictEqual((await bounded(waitingForSource, 'the waiter to follow the newer save')).map(node => node.title), ['Second save']);
        assert.deepStrictEqual((await service.getDocumentHeadings(document)).map(node => node.title), ['Second save']);
        gate.release.resolve();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.deepStrictEqual((await service.getDocumentHeadings(document)).map(node => node.title), ['Second save']);
        assert.deepStrictEqual(headings((await service.current())!.roots).map(node => node.title), ['Second save']);
      } finally { gate.release.resolve(); await firstSave; }
    });
  });

  test('retains the previous project tree and reports a saved-source read failure', async () => {
    await withSource('\\section{Retained}\n', async (provider, document, service) => {
      const roots = service.snapshot!.roots;
      await replace(document, '\\section{Saved but unreadable}\n');
      provider.failReads = true;
      await bounded(document.save(), 'a save whose subsequent source read fails');
      const snapshot = (await service.current())!;
      assert.strictEqual(snapshot.roots, roots);
      assert.match(snapshot.message ?? '', /Unable to update LaTeX structure/);
      assert.strictEqual(service.projectLocation(headings(snapshot.roots)[0].declarationRange).start,
        (await service.getDocumentHeadings(document))[0].declarationRange.start);
      provider.failReads = false;
    });
  });
});
