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
import StructureView from '../structure/StructureView';
import LaTeXDocumentSymbolProvider from '../structure/LaTeXDocumentSymbolProvider';
import { StructureNode } from '../structure/StructureTypes';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
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

async function edit(document: vscode.TextDocument, before: string, after: string, prefix = ''): Promise<void> {
  const offset = document.getText().indexOf(before);
  assert.ok(offset >= 0, `The document must contain ${before}`);
  const changes = new vscode.WorkspaceEdit();
  changes.replace(document.uri, new vscode.Range(document.positionAt(offset), document.positionAt(offset + before.length)), after);
  if (prefix) { changes.insert(document.uri, new vscode.Position(0, 0), prefix); }
  assert.ok(await vscode.workspace.applyEdit(changes));
}

/** Keep the real service and document; replace only the tree UI and its redraw clock. */
async function createView(service: StructureService) {
  const visibility = new vscode.EventEmitter<{ visible: boolean }>();
  const viewState = { title: '', description: undefined as string | undefined,
    message: undefined as string | undefined, selection: [], visible: true,
    onDidChangeVisibility: visibility.event, dispose() {} };
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const commands = new Map<string, () => unknown>();
  const preferences = new Map<string, unknown>();
  const filename = require.resolve('../structure/StructureView');
  const source = await fs.readFile(filename, 'utf8');
  const localRequire = createRequire(filename);
  const isolated = { exports: {} as { default: typeof StructureView } };
  const load = runInThisContext(`(function (exports, require, module, __filename, __dirname, setTimeout, clearTimeout) {\n${source}\n})`, { filename });
  load(isolated.exports, (id: string) => id === 'vscode' ? {
    TreeItem: vscode.TreeItem, EventEmitter: vscode.EventEmitter,
    TreeItemCollapsibleState: vscode.TreeItemCollapsibleState, ThemeIcon: vscode.ThemeIcon,
    ConfigurationTarget: vscode.ConfigurationTarget,
    window: { createTreeView: () => viewState, showErrorMessage: (message: string) => assert.fail(message) },
    workspace: { workspaceFolders: [], getConfiguration: vscode.workspace.getConfiguration,
      onDidChangeConfiguration: vscode.workspace.onDidChangeConfiguration },
    commands: { executeCommand: async () => undefined,
      registerCommand: (name: string, callback: () => unknown) => {
        commands.set(name, callback);
        return new vscode.Disposable(() => commands.delete(name));
      } }
  } : localRequire(id), isolated, filename, path.dirname(filename), (callback: () => void, delay: number) => {
    assert.strictEqual(delay, 100);
    const id = ++nextTimer;
    timers.set(id, callback);
    return id;
  }, (id: number) => timers.delete(id));
  const context = { workspaceState: {
    get: (key: string, fallback: unknown) => preferences.has(key) ? preferences.get(key) : fallback,
    update: async (key: string, value: unknown) => { preferences.set(key, value); }
  } } as unknown as vscode.ExtensionContext;
  const view = new isolated.exports.default(context, service);
  await service.current();
  await Promise.resolve();
  return {
    view,
    labels: () => view.getChildren().map(element => view.getTreeItem(element).label),
    flush() { const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) { callback(); } },
    setVisible(visible: boolean) { viewState.visible = visible; visibility.fire({ visible }); },
    async rebuild() { await commands.get('vscode-fortex.outline.toggleLabels')!(); },
    dispose() { view.dispose(); visibility.dispose(); }
  };
}

interface RebuildGate {
  started: ReturnType<typeof deferred>;
  release: ReturnType<typeof deferred>;
  fail: boolean;
}

async function withSource(run: (test: {
  document: vscode.TextDocument;
  service: StructureService;
  symbols: LaTeXDocumentSymbolProvider;
  display: Awaited<ReturnType<typeof createView>>;
  holdRebuild(fail?: boolean): RebuildGate;
  releaseRebuild(): void;
}) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fortex-saved-projection-'));
  const uri = vscode.Uri.file(path.join(directory, 'main.tex'));
  const originalResolve = LaTeXProject.resolveMainFile;
  const originalTrigger = Config.compileTrigger;
  let gate: RebuildGate | undefined;
  let service: StructureService | undefined;
  let symbols: LaTeXDocumentSymbolProvider | undefined;
  let display: Awaited<ReturnType<typeof createView>> | undefined;
  const releaseRebuild = () => { gate?.release.resolve(); gate = undefined; };
  try {
    Config.compileTrigger = () => [];
    LaTeXProject.resolveMainFile = async () => {
      const current = gate;
      if (current) {
        current.started.resolve();
        await current.release.promise;
        if (current.fail) { throw new Error('Controlled project rebuild failure'); }
      }
      return uri;
    };
    await fs.writeFile(uri.fsPath, '\\documentclass{article}\n\\section{Original}\nBody\n\\section{Unseen}\n', 'utf8');
    const document = await vscode.workspace.openTextDocument(uri);
    assert.strictEqual(vscode.workspace.getConfiguration('vscode-fortex', uri).get('outline.followIncludes', true), true);
    service = new StructureService(false);
    symbols = new LaTeXDocumentSymbolProvider(service);
    await service.refresh(document);
    display = await createView(service);
    await run({ document, service, symbols, display,
      holdRebuild(fail = false) { return gate = { started: deferred(), release: deferred(), fail }; }, releaseRebuild });
  } finally {
    releaseRebuild();
    display?.dispose();
    symbols?.dispose();
    service?.dispose();
    LaTeXProject.resolveMainFile = originalResolve;
    Config.compileTrigger = originalTrigger;
    await fs.unlink(uri.fsPath);
    await fs.rmdir(directory);
  }
}

function assertProjectedHeading(service: StructureService, document: vscode.TextDocument, node: StructureNode, title: string): void {
  const projected = service.projectNode(node);
  const target = service.projectLocation(node.declarationRange);
  assert.strictEqual(projected.title, title);
  assert.deepStrictEqual(projected.declarationRange, target);
  assert.strictEqual(document.getText().slice(target.start, target.end), `\\section{${title}}`);
}

suite('Saved structure live projection', function () {
  this.timeout(30000);

  test('keeps display identities across a real save that shifts heading offsets', async () => {
    await withSource(async ({ document, service, display }) => {
      const originalNode = service.snapshot!.roots[0];
      const originalIds = display.view.getChildren().map(element => display.view.getTreeItem(element).id);
      assert.ok(originalIds.every(Boolean));
      await edit(document, 'Body', 'Edited body', '% inserted before headings\n');
      display.flush();
      assert.ok(await document.save());
      await bounded(service.current(), 'the saved hierarchy with shifted offsets');
      assert.notStrictEqual(service.snapshot!.roots[0].id, originalNode.id,
        'The actual save must replace the source-offset-based node identity');
      assert.deepStrictEqual(display.view.getChildren().map(element => display.view.getTreeItem(element).id), originalIds,
        'Stable display identities let VS Code retain the existing expansion state');
    });
  });

  test('keeps titles and navigation current while a saved project rebuild waits', async () => {
    await withSource(async ({ document, service, symbols, display, holdRebuild, releaseRebuild }) => {
      const root = service.snapshot!.roots[0];
      assert.deepStrictEqual(display.labels(), ['Original', 'Unseen']);
      await edit(document, 'Original', 'Renamed', '% prefix 😀\r\n');
      display.flush();
      assert.deepStrictEqual(display.labels(), ['Renamed', 'Unseen']);
      const gate = holdRebuild();
      assert.ok(await document.save());
      await bounded(gate.started.promise, 'the saved project rebuild');
      display.flush();
      assert.strictEqual(service.snapshot!.roots[0], root);
      assert.deepStrictEqual(display.labels(), ['Renamed', 'Unseen']);
      assertProjectedHeading(service, document, root, 'Renamed');
      assert.strictEqual((await symbols.provideDocumentSymbols(document))[0].name, 'Renamed');

      await edit(document, 'Renamed', 'Newest', '% more prefix\n');
      display.flush();
      assert.deepStrictEqual(display.labels(), ['Newest', 'Unseen']);
      assertProjectedHeading(service, document, root, 'Newest');
      assert.strictEqual((await symbols.provideDocumentSymbols(document))[0].name, 'Newest');
      releaseRebuild();
      await bounded(service.current(), 'publishing the rebuilt tree');
      assert.strictEqual(service.snapshot!.roots[0].title, 'Renamed', 'The saved hierarchy uses the bytes actually saved');
      assert.deepStrictEqual(display.labels(), ['Newest', 'Unseen']);
      assertProjectedHeading(service, document, service.snapshot!.roots[0], 'Newest');
      assert.deepStrictEqual(service.projectLocation(root.declarationRange), root.declarationRange,
        'A replaced tree no longer retains its old projection baseline');
    });
  });

  test('retains the live baseline after rebuild failure and keeps following edits and redraws', async () => {
    await withSource(async ({ document, service, display, holdRebuild, releaseRebuild }) => {
      const roots = service.snapshot!.roots;
      assert.deepStrictEqual(display.labels(), ['Original', 'Unseen']);
      await edit(document, 'Original', 'Renamed');
      display.flush();
      const gate = holdRebuild(true);
      assert.ok(await document.save());
      await bounded(gate.started.promise, 'the failing project rebuild');
      releaseRebuild();
      await bounded(service.current(), 'the failed tree update');
      assert.strictEqual(service.snapshot!.roots, roots);
      assert.match(service.snapshot!.message ?? '', /Controlled project rebuild failure/);
      await display.rebuild();
      assert.deepStrictEqual(display.labels(), ['Renamed', 'Unseen']);
      await edit(document, 'Renamed', 'Continuing', '% after failure\n');
      display.flush();
      assert.deepStrictEqual(display.labels(), ['Continuing', 'Unseen']);
      assertProjectedHeading(service, document, roots[0], 'Continuing');
      await service.refresh(document);
      assert.deepStrictEqual(display.labels(), ['Continuing', 'Unseen']);
      assertProjectedHeading(service, document, service.snapshot!.roots[0], 'Continuing');
    });
  });

  test('projects never-rendered headings after repeated saves while the tree is hidden', async () => {
    await withSource(async ({ document, service, symbols, display, holdRebuild, releaseRebuild }) => {
      const roots = service.snapshot!.roots;
      display.setVisible(false);
      await edit(document, 'Original', 'First saved');
      await edit(document, 'Unseen', 'First unseen');
      const gate = holdRebuild();
      assert.ok(await document.save());
      await bounded(gate.started.promise, 'the first saved project rebuild');
      await edit(document, 'First saved', 'Second saved', '% shifted\n');
      await edit(document, 'First unseen', 'Second unseen');
      assert.ok(await document.save());
      assert.deepStrictEqual((await symbols.provideDocumentSymbols(document)).map(symbol => symbol.name), ['Second saved', 'Second unseen']);
      assert.strictEqual(service.snapshot!.roots, roots);
      display.setVisible(true);
      assert.deepStrictEqual(display.labels(), ['Second saved', 'Second unseen']);
      await display.rebuild();
      assert.deepStrictEqual(display.labels(), ['Second saved', 'Second unseen']);
      assertProjectedHeading(service, document, roots[1], 'Second unseen');
      releaseRebuild();
      await bounded(service.current(), 'the latest saved tree');
      assert.deepStrictEqual(display.labels(), ['Second saved', 'Second unseen']);
      assertProjectedHeading(service, document, service.snapshot!.roots[1], 'Second unseen');
    });
  });
});
