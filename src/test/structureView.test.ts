import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { runInThisContext } from 'vm';
import StructureView, { filterStructure, StructureFilterOptions } from '../structure/StructureView';
import { StructureKind, StructureNode, StructureSnapshot } from '../structure/StructureTypes';
import LaTeXDocumentSymbolProvider, { registerDocumentSymbols } from '../structure/LaTeXDocumentSymbolProvider';
import StructureService from '../structure/StructureService';
import Config from '../Config';

async function changeDocument(document: vscode.TextDocument, changes: { start: number; end: number; text: string }[]): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  for (const change of changes) {
    edit.replace(document.uri, new vscode.Range(document.positionAt(change.start), document.positionAt(change.end)), change.text);
  }
  assert.ok(await vscode.workspace.applyEdit(edit));
}

function flattenSymbols(symbols: readonly vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
  return symbols.flatMap(symbol => [symbol, ...flattenSymbols(symbol.children)]);
}

suite('Structure view filtering', () => {
  const uri = vscode.Uri.file('/structure-filter.tex');
  const options: StructureFilterOptions = {
    visibleKinds: ['section', 'theorem', 'figure', 'table', 'label'], equations: 'labeled', labeledOnly: false
  };
  const node = (id: string, kind: StructureKind, children: StructureNode[] = [], labeled = false): StructureNode => ({
    id, kind, title: id, constructName: kind,
    declarationRange: { uri, start: 0, end: 1 }, extentEnd: { uri, start: 10, end: 10 },
    labels: labeled ? [{ key: `label:${id}`, location: { uri, start: 2, end: 3 } }] : [], children
  });

  test('promotes visible children of hidden categories in source order', () => {
    const first = node('first', 'figure');
    const nested = node('nested', 'table');
    const last = node('last', 'figure');
    const source = [node('heading', 'section', [first, node('hidden', 'theorem', [nested]), last])];
    const filtered = filterStructure(source, { ...options, visibleKinds: ['section', 'figure', 'table'] });
    assert.deepStrictEqual(filtered[0].children.map(item => item.id), ['first', 'nested', 'last']);
    assert.deepStrictEqual(source[0].children.map(item => item.id), ['first', 'hidden', 'last']);
    assert.strictEqual(filtered[0].children[1].declarationRange, nested.declarationRange);
  });

  test('equation visibility independently supports all, labeled, and hidden', () => {
    const source = [node('plain', 'equation'), node('labeled', 'equation', [], true), node('figure', 'figure')];
    assert.deepStrictEqual(filterStructure(source, options).map(item => item.id), ['labeled', 'figure']);
    assert.deepStrictEqual(filterStructure(source, { ...options, equations: 'all' }).map(item => item.id), ['plain', 'labeled', 'figure']);
    assert.deepStrictEqual(filterStructure(source, { ...options, equations: 'hidden' }).map(item => item.id), ['figure']);
  });

  test('labeled-only preserves heading ancestors and removes unrelated unlabeled branches', () => {
    const labeled = node('labeled theorem', 'theorem', [], true);
    const source = [node('parent heading', 'section', [node('child heading', 'section', [labeled]),
      node('unrelated heading', 'section', [node('unlabeled figure', 'figure')])]), node('empty heading', 'section')];
    const filtered = filterStructure(source, { ...options, labeledOnly: true });
    assert.deepStrictEqual(filtered.map(item => item.id), ['parent heading']);
    assert.deepStrictEqual(filtered[0].children.map(item => item.id), ['child heading']);
    assert.strictEqual(filtered[0].children[0].children[0].id, 'labeled theorem');
  });

  test('promotes labeled descendants through unlabeled non-heading parents', () => {
    const source = [node('heading', 'section', [node('unlabeled theorem', 'theorem', [node('labeled equation', 'equation', [], true)])])];
    const filtered = filterStructure(source, { ...options, labeledOnly: true });
    assert.deepStrictEqual(filtered[0].children.map(item => item.id), ['labeled equation']);
  });

  test('hiding headings preserves their visible descendants and original label metadata', () => {
    const theorem = node('theorem', 'theorem', [], true);
    const source = [node('heading', 'section', [theorem])];
    const filtered = filterStructure(source, { ...options, visibleKinds: ['theorem'] });
    assert.deepStrictEqual(filtered.map(item => item.id), ['theorem']);
    assert.strictEqual(filtered[0].labels, theorem.labels);
    assert.strictEqual(source[0].children[0], theorem);
  });

  test('keeps unresolved inclusion information visible with every category disabled', () => {
    const source = [node('heading', 'section', [node('missing include', 'issue')])];
    const filtered = filterStructure(source, { visibleKinds: [], equations: 'hidden', labeledOnly: true });
    assert.deepStrictEqual(filtered.map(item => item.id), ['missing include']);
  });
});

suite('Local LaTeX Outline', () => {
  const providers: LaTeXDocumentSymbolProvider[] = [];
  const provider = () => {
    const value = new LaTeXDocumentSymbolProvider();
    providers.push(value);
    return value;
  };
  teardown(() => { for (const value of providers.splice(0)) { value.dispose(); } });
  test('shows headings only and maps full extents and declarations with original offsets', async () => {
    const source = '前文 😀\r\n\\section{First}\r\nText\r\n\\begin{theorem}\\label{thm:first}Text\\end{theorem}\r\n'
      + '\\subsection*{Child}\r\nMore\r\n\\section{Second}';
    const document = await vscode.workspace.openTextDocument({ language: 'latex', content: source });
    const symbols = await provider().provideDocumentSymbols(document);
    assert.deepStrictEqual(symbols.map(symbol => symbol.name), ['First', 'Second']);
    assert.deepStrictEqual(symbols[0].children.map(symbol => symbol.name), ['Child']);
    assert.deepStrictEqual(symbols[0].range, new vscode.Range(
      document.positionAt(source.indexOf('\\section{First}')),
      document.positionAt(source.indexOf('\\section{Second}'))
    ));
    assert.strictEqual(document.getText(symbols[0].selectionRange), '\\section{First}');
    assert.strictEqual(document.getText(symbols[0].children[0].selectionRange), '\\subsection*{Child}');
    assert.ok(symbols[0].range.contains(symbols[0].children[0].range));
    assert.deepStrictEqual(symbols[1].range.end, document.positionAt(source.length));
  });

  test('retains saved headings and maps body edits across CRLF, UTF-16, columns and multiple cursors', async () => {
    const source = '前文 😀 \\section{First}\r\nbody \\subsection{Child}\r\nMore\r\n\\section{Second}\r\nTail';
    const document = await vscode.workspace.openTextDocument({ language: 'latex', content: source });
    const symbolsProvider = provider();
    const previous = await symbolsProvider.provideDocumentSymbols(document);
    const unchanged = JSON.stringify(previous);
    await changeDocument(document, [
      { start: 0, end: 0, text: '追記😀 ' },
      { start: source.indexOf('body') + 2, end: source.indexOf('body') + 2, text: '\r\n挿入😀' },
      { start: source.length, end: source.length, text: '\r\nEnd😀' }
    ]);
    assert.ok(document.isDirty);
    const symbols = await symbolsProvider.provideDocumentSymbols(document);
    assert.deepStrictEqual(symbols.map(symbol => symbol.name), ['First', 'Second']);
    assert.deepStrictEqual(symbols[0].children.map(symbol => symbol.name), ['Child']);
    const current = document.getText();
    for (const symbol of flattenSymbols(symbols)) {
      const declaration = symbol.name === 'Child' ? '\\subsection{Child}' : `\\section{${symbol.name}}`;
      const start = current.indexOf(declaration);
      assert.deepStrictEqual(symbol.selectionRange, new vscode.Range(document.positionAt(start), document.positionAt(start + declaration.length)));
      assert.strictEqual(document.getText(symbol.selectionRange), declaration);
      assert.strictEqual(symbol.detail, symbol.name === 'Child' ? '\\subsection' : '\\section');
      assert.ok(symbol.range.contains(symbol.selectionRange));
    }
    assert.deepStrictEqual(symbols[0].range.end, document.positionAt(current.indexOf('\\section{Second}')));
    assert.deepStrictEqual(symbols[1].range.end, document.positionAt(current.length));
    assert.ok(symbols[0].range.contains(symbols[0].children[0].range));
    assert.strictEqual(JSON.stringify(previous), unchanged, 'A new projection must not mutate a response already returned to VS Code');
    assert.strictEqual(await symbolsProvider.provideDocumentSymbols(document), symbols);
  });

  test('renames an existing heading without removing it or its hierarchy and withholds new headings until save', async () => {
    const source = '\\section{Parent}\n\\subsection{Child}\nbody\n\\section{Sibling}\n';
    const document = await vscode.workspace.openTextDocument({ language: 'latex', content: source });
    const symbolsProvider = provider();
    const previous = await symbolsProvider.provideDocumentSymbols(document);
    const unchanged = JSON.stringify(previous);
    await changeDocument(document, [
      { start: source.indexOf('Parent'), end: source.indexOf('Parent') + 'Parent'.length, text: 'Renamed' },
      { start: source.length, end: source.length, text: '\\subsection{Unsaved child}' }
    ]);
    const symbols = await symbolsProvider.provideDocumentSymbols(document);
    assert.deepStrictEqual(symbols.map(symbol => symbol.name), ['Renamed', 'Sibling']);
    assert.deepStrictEqual(symbols[0].children.map(symbol => symbol.name), ['Child']);
    assert.ok(flattenSymbols(symbols).every(symbol => !/Waiting for save/.test(symbol.detail)));
    assert.strictEqual(document.getText(symbols[0].selectionRange), '\\section{Renamed}');
    assert.strictEqual(JSON.stringify(previous), unchanged);
  });

  test('reuses a local projection for the same document version and preserves the prior tree', async () => {
    const source = 'body \\section{Saved}\ntext';
    const document = await vscode.workspace.openTextDocument({ language: 'latex', content: source });
    const service = new StructureService(false);
    const symbolsProvider = new LaTeXDocumentSymbolProvider(service);
    try {
      const previous = await service.getDocumentHeadings(document);
      assert.strictEqual(await service.getDocumentHeadings(document), previous);
      const oldSymbols = await symbolsProvider.provideDocumentSymbols(document);
      assert.strictEqual(await symbolsProvider.provideDocumentSymbols(document), oldSymbols);
      const unchanged = JSON.stringify(previous);
      await changeDocument(document, [{ start: 0, end: 0, text: '追加😀\n' }]);
      const projected = await service.getDocumentHeadings(document);
      assert.strictEqual(await service.getDocumentHeadings(document), projected);
      const symbols = await symbolsProvider.provideDocumentSymbols(document);
      assert.notStrictEqual(symbols, oldSymbols);
      assert.strictEqual(await symbolsProvider.provideDocumentSymbols(document), symbols);
      assert.notStrictEqual(projected, previous);
      assert.strictEqual(JSON.stringify(previous), unchanged);
    } finally { symbolsProvider.dispose(); service.dispose(); }
  });

  test('returns an empty list for a genuine document without headings', async () => {
    const document = await vscode.workspace.openTextDocument({ language: 'latex', content: 'Body text. \\label{standalone}' });
    assert.deepStrictEqual(await provider().provideDocumentSymbols(document), []);
  });

  test('does not read a document after the request has already been canceled', async () => {
    const cancellation = new vscode.CancellationTokenSource();
    cancellation.cancel();
    try {
      const document = { getText: () => assert.fail('Canceled requests must not read the document') } as unknown as vscode.TextDocument;
      await assert.rejects(provider().provideDocumentSymbols(document, cancellation.token), error => error instanceof vscode.CancellationError);
    } finally {
      cancellation.dispose();
    }
  });

  test('updates existing native titles live and adds new symbols on save without per-edit provider invalidation', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fortex-native-outline-'));
    const uri = vscode.Uri.file(path.join(directory, 'outline.tex'));
    const service = new StructureService(false);
    const registration = registerDocumentSymbols(service);
    let invalidations = 0;
    const subscription = service.onDidChangeDocumentSymbols(() => { invalidations++; });
    const originalTrigger = Config.compileTrigger;
    Config.compileTrigger = () => [];
    try {
      await fs.writeFile(uri.fsPath, '\\section{Native before}\nBody\n\\section{Native retained}\nTail', 'utf8');
      const document = await vscode.workspace.openTextDocument(uri);
      // The execute command may select the extension's global provider. Register
      // this source with the helper service independently of provider ordering.
      await service.getDocumentHeadings(document);
      const symbols = () => vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider', uri
      );
      const previous = await symbols();
      assert.ok(previous?.some(symbol => symbol.name === 'Native before'));
      const unchanged = JSON.stringify(previous);
      await changeDocument(document, [{ start: 0, end: 0, text: 'Prefix😀\n' }]);
      assert.strictEqual(invalidations, 0, 'Typing must not invalidate symbol registrations');
      const bodyEdited = await symbols();
      assert.ok(bodyEdited?.some(symbol => symbol.name === 'Native before' && symbol.detail === '\\section'));
      const source = document.getText();
      await changeDocument(document, [
        { start: source.indexOf('Native before'), end: source.indexOf('Native before') + 'Native before'.length, text: 'Native after' },
        { start: source.length, end: source.length, text: '\n\\subsection{Native new}' }
      ]);
      const declarationEdited = await symbols();
      assert.ok(declarationEdited?.some(symbol => symbol.name === 'Native after'));
      assert.ok(!declarationEdited?.some(symbol => symbol.name === 'Native before'));
      assert.ok(declarationEdited?.some(symbol => symbol.name === 'Native retained'));
      assert.ok(!flattenSymbols(declarationEdited ?? []).some(symbol => symbol.name === 'Native new'));
      assert.strictEqual(invalidations, 0, 'Editing a declaration must not unregister the provider');
      let saveSubscription: vscode.Disposable | undefined;
      let saveTimeout: ReturnType<typeof setTimeout> | undefined;
      const savedNotification = new Promise<void>((resolve, reject) => {
        saveSubscription = service.onDidChangeDocumentSymbols(() => resolve());
        saveTimeout = setTimeout(() => reject(new Error('The helper service did not publish its saved source')), 5000);
      });
      try {
        await Promise.all([document.save().then(saved => { assert.ok(saved); }), savedNotification]);
      } finally {
        saveSubscription?.dispose();
        clearTimeout(saveTimeout);
      }
      const saved = await symbols();
      assert.strictEqual(invalidations, 1, 'The changed local symbols must invalidate their provider exactly once');
      assert.ok(saved?.some(symbol => symbol.name === 'Native after'));
      assert.ok(flattenSymbols(saved ?? []).some(symbol => symbol.name === 'Native new'));
      assert.ok(flattenSymbols(saved ?? []).every(symbol => !/Waiting for save/.test(symbol.detail)));
      assert.strictEqual(JSON.stringify(previous), unchanged);
    } finally {
      Config.compileTrigger = originalTrigger;
      subscription.dispose();
      registration.dispose();
      service.dispose();
      assert.strictEqual(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('fortex-native-outline-'));
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  test('does not publish symbols when canceled while preparing a response', async () => {
    const document = await vscode.workspace.openTextDocument({ language: 'latex', content: '\\section{Canceled}' });
    const cancellation = new vscode.CancellationTokenSource();
    try {
      const pending = provider().provideDocumentSymbols(document, cancellation.token);
      cancellation.cancel();
      await assert.rejects(pending, error => error instanceof vscode.CancellationError);
    } finally {
      cancellation.dispose();
    }
  });

  test('cancels a superseded response without retrying or publishing an empty replacement', async () => {
    const document = await vscode.workspace.openTextDocument({ language: 'latex', content: '\\section{Saved}' });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const service = {
      getDocumentHeadings: async () => { calls++; await gate; return []; }
    } as unknown as StructureService;
    const symbolsProvider = new LaTeXDocumentSymbolProvider(service);
    try {
      const pending = symbolsProvider.provideDocumentSymbols(document);
      await changeDocument(document, [{ start: 0, end: 0, text: 'body\n' }]);
      release();
      await assert.rejects(pending, error => error instanceof vscode.CancellationError);
      assert.strictEqual(calls, 1, 'The provider must leave the next request to VS Code instead of retrying');
    } finally { release(); symbolsProvider.dispose(); }
  });

  test('exposes local headings through VS Code after extension activation', async function () {
    this.timeout(10000);
    const extension = vscode.extensions.all.find(candidate => candidate.packageJSON.name === 'vscode-fortex');
    assert.ok(extension, 'fortex must be loaded in the extension test host');
    await extension.activate();
    const document = await vscode.workspace.openTextDocument({
      language: 'latex', content: '\\section{Outline integration}\n\\subsection{Nested heading}'
    });
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider', document.uri
    );
    assert.ok(symbols);
    const section = symbols.find(symbol => symbol.name === 'Outline integration');
    assert.ok(section, 'The standard symbol command must expose LaTeX headings');
    assert.strictEqual(section.children[0].name, 'Nested heading');
    assert.strictEqual(document.getText(section.selectionRange), '\\section{Outline integration}');
  });
});

suite('Structure view live display', () => {
  async function harness(options: { child?: boolean; labels?: boolean } = {}) {
    const uri = vscode.Uri.file('/structure-status.tex');
    const childUri = vscode.Uri.file('/structure-child.tex');
    const root: StructureNode = {
      id: 'saved', kind: 'section', constructName: options.child ? 'chapter' : 'section', title: 'Retained heading',
      declarationRange: { uri, start: 0, end: 20 }, extentEnd: { uri, start: 30, end: 30 }, labels: [], children: []
    };
    const child: StructureNode = {
      id: 'child', kind: 'section', constructName: 'section', title: 'Included section', level: 2,
      declarationRange: { uri: childUri, start: 0, end: 24 }, extentEnd: { uri: childUri, start: 40, end: 40 }, labels: [], children: []
    };
    if (options.child) { root.level = 1; root.children.push(child); }
    if (options.labels) {
      root.labels.push({ key: 'sec:abc', location: { uri: childUri, start: 0, end: 15 } });
    }
    const state: { snapshot: StructureSnapshot } = {
      snapshot: { main: uri, followIncludes: !!options.child || !!options.labels, roots: [root],
        labels: options.labels ? [{ label: root.labels[0], node: root, inclusionCount: 1, duplicate: false }] : [] }
    };
    const changed = new vscode.EventEmitter<StructureSnapshot | undefined>();
    const liveChanged = new vscode.EventEmitter<vscode.Uri>();
    const visibilityChanged = new vscode.EventEmitter<{ visible: boolean }>();
    const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'Before\nRetained heading\nAfter\n' });
    let liveTitle = root.title;
    let liveLine = 2;
    let target = { start: 0, end: 20 };
    let projected = 0;
    const projectionsByFile = new Map<string, number>();
    const linesByFile = new Map<string, number>();
    let opens = 0;
    let selection: vscode.Range | undefined;
    const service = {
      get snapshot() { return state.snapshot; },
      onDidChange: changed.event,
      onDidChangeLiveSources: liveChanged.event,
      current: async () => state.snapshot,
      projectNode: (node: StructureNode, projectExtentEnd?: boolean) => {
        assert.strictEqual(projectExtentEnd, false, 'Displaying a title must not update an include endpoint in another file');
        projected++;
        const key = node.declarationRange.uri.toString();
        projectionsByFile.set(key, (projectionsByFile.get(key) ?? 0) + 1);
        return { ...node, title: key === uri.toString() ? liveTitle : node.title };
      },
      projectLocation: (location: StructureNode['declarationRange']) => {
        assert.ok(opens > 0, 'Projection must use the version after opening the document');
        assert.strictEqual(location, root.declarationRange, 'Only original saved offsets may be projected');
        return { ...location, ...target };
      },
      lineNumber: (location: StructureNode['declarationRange']) => {
        const key = location.uri.toString();
        linesByFile.set(key, (linesByFile.get(key) ?? 0) + 1);
        return liveLine;
      }
    } as unknown as StructureService;
    const viewState = {
      title: '', description: undefined as string | undefined,
      message: undefined as string | undefined, selection: [], visible: true,
      onDidChangeVisibility: visibilityChanged.event, dispose() {}
    };
    const callbacks = new Map<string, (element?: unknown) => unknown>();
    const preferences = new Map<string, unknown>();
    const information: string[] = [];
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    const filename = require.resolve('../structure/StructureView');
    const source = await fs.readFile(filename, 'utf8');
    const localRequire = createRequire(filename);
    const isolatedModule = { exports: {} as { default: typeof StructureView } };
    const load = runInThisContext(`(function (exports, require, module, __filename, __dirname, setTimeout, clearTimeout) {\n${source}\n})`, { filename });
    load(isolatedModule.exports, (id: string) => id === 'vscode' ? {
      TreeItem: vscode.TreeItem,
      EventEmitter: vscode.EventEmitter,
      TreeItemCollapsibleState: vscode.TreeItemCollapsibleState,
      ThemeIcon: vscode.ThemeIcon,
      ConfigurationTarget: vscode.ConfigurationTarget,
      Range: vscode.Range,
      TextEditorRevealType: vscode.TextEditorRevealType,
      window: {
        createTreeView: () => viewState,
        showTextDocument: async (_document: vscode.TextDocument, options: { selection: vscode.Range }) => {
          assert.strictEqual(_document, document);
          selection = options.selection;
          return { revealRange() {} };
        },
        showInformationMessage: async (message: string) => { information.push(message); return undefined; },
        showErrorMessage: async (message: string) => { assert.fail(message); }
      },
      workspace: {
        workspaceFolders: [],
        onDidChangeConfiguration: vscode.workspace.onDidChangeConfiguration,
        getConfiguration: () => ({ get: (key: string, fallback: unknown) => options.labels && key === 'outline.viewMode' ? 'labels' : fallback }),
        openTextDocument: async () => { opens++; return document; }
      },
      commands: {
        executeCommand: async () => undefined,
        registerCommand: (name: string, callback: (element?: unknown) => unknown) => {
          callbacks.set(name, callback);
          return new vscode.Disposable(() => callbacks.delete(name));
        }
      }
    } : localRequire(id), isolatedModule, filename, path.dirname(filename),
    (callback: () => void, delay: number) => {
      assert.strictEqual(delay, 100);
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    }, (id: number) => timers.delete(id));
    const context = { workspaceState: {
      get: (key: string, fallback: unknown) => preferences.has(key) ? preferences.get(key) : fallback,
      update: async (key: string, value: unknown) => { preferences.set(key, value); }
    } } as unknown as vscode.ExtensionContext;
    const view = new isolatedModule.exports.default(context, service);
    await Promise.resolve();
    return {
      uri, childUri, root, child, state, changed, liveChanged, visibilityChanged, viewState, callbacks, information,
      view, timers, document, projectionsByFile, linesByFile,
      get projected() { return projected; }, get opens() { return opens; }, get selection() { return selection; },
      setTitle(title: string) { liveTitle = title; },
      setLine(line: number) { liveLine = line; },
      setTarget(start: number, end: number) { target = { start, end }; },
      setSetting(name: string, value: unknown) { preferences.set(`outline.${name}`, value); },
      flush() { const pending = [...timers.values()]; timers.clear(); for (const callback of pending) { callback(); } },
      dispose() { view.dispose(); changed.dispose(); liveChanged.dispose(); visibilityChanged.dispose(); }
    };
  }

  test('initially collapses parents and leaves childless items without a disclosure control', async () => {
    const test = await harness({ child: true });
    try {
      const parent = test.view.getChildren()[0];
      const child = test.view.getChildren(parent)[0];
      assert.strictEqual(test.view.getTreeItem(parent).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
      assert.strictEqual(test.view.getTreeItem(child).collapsibleState, vscode.TreeItemCollapsibleState.None);
    } finally { test.dispose(); }
  });

  test('retains display identities when saved offsets and include order change or a different heading is inserted', async () => {
    const test = await harness({ child: true });
    try {
      const parent = test.view.getChildren()[0];
      const originalId = test.view.getTreeItem(parent).id;
      const childId = test.view.getTreeItem(test.view.getChildren(parent)[0]).id;
      assert.ok(originalId);
      assert.ok(childId);
      const shiftedChild = { ...test.child, id: 'new-occurrence:100:section',
        declarationRange: { ...test.child.declarationRange, start: 100, end: 124 } };
      const shiftedParent = { ...test.root, id: 'new-occurrence:200:section',
        declarationRange: { ...test.root.declarationRange, start: 200, end: 220 }, children: [shiftedChild] };
      const inserted = { ...test.root, id: 'new-heading', title: 'Earlier heading', children: [] };
      test.state.snapshot = { ...test.state.snapshot, roots: [inserted, shiftedParent] };
      test.changed.fire(test.state.snapshot);
      const rebuilt = test.view.getChildren()[1];
      assert.strictEqual(test.view.getTreeItem(rebuilt).id, originalId,
        'VS Code can restore expansion when the same heading retains its display identity');
      assert.strictEqual(test.view.getTreeItem(test.view.getChildren(rebuilt)[0]).id, childId);
      assert.notStrictEqual(test.view.getTreeItem(test.view.getChildren()[0]).id, originalId);
    } finally { test.dispose(); }
  });

  test('keeps repeated-include identities distinct and stable through filtering and label mode', async () => {
    const test = await harness({ child: true });
    try {
      const first = { ...test.child, id: 'first-include' };
      const second = { ...test.child, id: 'second-include', labels: [
        { key: 'sec:second', location: test.child.declarationRange }
      ] };
      const third = { ...test.child, id: 'same-name-later',
        declarationRange: { ...test.child.declarationRange, start: 80, end: 104 } };
      test.state.snapshot = { ...test.state.snapshot, roots: [{ ...test.root, children: [first, second, third] }] };
      test.changed.fire(test.state.snapshot);
      const parent = test.view.getChildren()[0];
      const ids = test.view.getChildren(parent).map(element => test.view.getTreeItem(element).id);
      assert.ok(ids.every(Boolean));
      assert.strictEqual(new Set(ids).size, 3, 'Same-named headings and repeated includes need distinct identities');

      test.setSetting('labeledOnly', true);
      test.changed.fire(test.state.snapshot);
      const visible = test.view.getChildren(test.view.getChildren()[0]);
      assert.strictEqual(visible.length, 1);
      assert.strictEqual(test.view.getTreeItem(visible[0]).id, ids[1],
        'Filtering an earlier identical heading must not renumber the remaining one');
      await test.callbacks.get('vscode-fortex.outline.toggleMode')?.();
      assert.deepStrictEqual(test.view.getChildren(), []);
      await test.callbacks.get('vscode-fortex.outline.toggleMode')?.();
      const restored = test.view.getChildren(test.view.getChildren()[0])[0];
      assert.strictEqual(test.view.getTreeItem(restored).id, ids[1]);
    } finally { test.dispose(); }
  });

  test('does not reuse expansion identities across different main documents', async () => {
    const test = await harness({ child: true });
    try {
      const id = test.view.getTreeItem(test.view.getChildren()[0]).id;
      assert.ok(id);
      test.state.snapshot = { ...test.state.snapshot, main: vscode.Uri.file('/different-main.tex') };
      test.changed.fire(test.state.snapshot);
      assert.notStrictEqual(test.view.getTreeItem(test.view.getChildren()[0]).id, id);
    } finally { test.dispose(); }
  });

  test('keeps refresh errors and permits projected navigation regardless of saved-text validity', async () => {
    const test = await harness();
    try {
      test.state.snapshot = { ...test.state.snapshot, message: 'Unable to read LaTeX structure: permission denied' };
      test.changed.fire(test.state.snapshot);
      assert.match(test.viewState.message ?? '', /Unable to read LaTeX structure: permission denied/);
      assert.doesNotMatch(test.viewState.message ?? '', /Waiting for save/);
      assert.doesNotMatch(test.viewState.description ?? '', /Waiting for save/);
      const roots = test.view.getChildren();
      assert.strictEqual(roots.length, 1);
      assert.strictEqual((await test.view.getTreeItem(roots[0])).label, 'Retained heading');
      test.setTarget(7, 23);
      await test.callbacks.get('vscode-fortex.outline.open')?.(roots[0]);
      assert.strictEqual(test.opens, 1);
      assert.deepStrictEqual(test.selection, new vscode.Range(test.document.positionAt(7), test.document.positionAt(23)));
      test.setTarget(10000, 20000);
      await test.callbacks.get('vscode-fortex.outline.open')?.(roots[0]);
      assert.strictEqual(test.opens, 2, 'Approximate and out-of-date offsets still allow a jump');
      assert.deepStrictEqual(test.selection?.start, test.document.positionAt(test.document.getText().length));
      assert.deepStrictEqual(test.information, []);
    } finally { test.dispose(); }
  });

  test('coalesces visible edits into one redraw and preserves tree wrappers and saved nodes', async () => {
    const test = await harness();
    const roots = test.view.getChildren();
    await test.view.getTreeItem(roots[0]);
    const baselineProjections = test.projected;
    const baselineLineCalls = test.linesByFile.get(test.uri.toString());
    let redraws = 0;
    const subscription = test.view.onDidChangeTreeData(() => { redraws++; });
    try {
      test.setTitle('Live renamed heading');
      test.liveChanged.fire(test.uri);
      test.liveChanged.fire(test.uri);
      test.liveChanged.fire(vscode.Uri.file('/unrelated.tex'));
      assert.strictEqual(test.timers.size, 1, 'A burst must not reset or multiply the pending redraw');
      assert.strictEqual(test.projected, baselineProjections, 'Input notifications must not parse/project headings');
      assert.strictEqual(redraws, 0);
      test.flush();
      assert.strictEqual(redraws, 1);
      assert.strictEqual(test.view.getChildren(), roots);
      assert.strictEqual((await test.view.getTreeItem(roots[0])).label, 'Live renamed heading');
      assert.strictEqual((await test.view.getTreeItem(roots[0])).description, 'structure-status.tex:2');
      assert.strictEqual(test.linesByFile.get(test.uri.toString()), baselineLineCalls,
        'A name-only redraw reuses its displayed source line');
      assert.strictEqual(test.root.title, 'Retained heading');
      assert.strictEqual(test.state.snapshot.roots[0], test.root);
    } finally { subscription.dispose(); test.dispose(); }
  });

  test('defers hidden edits until visible and cancels pending redraws on dispose', async () => {
    const test = await harness();
    const roots = test.view.getChildren();
    await test.view.getTreeItem(roots[0]);
    let redraws = 0;
    const subscription = test.view.onDidChangeTreeData(() => { redraws++; });
    try {
      test.setTitle('Changed while hidden');
      test.liveChanged.fire(test.uri);
      assert.strictEqual(test.timers.size, 1);
      test.viewState.visible = false;
      test.visibilityChanged.fire({ visible: false });
      assert.strictEqual(test.timers.size, 0);
      test.liveChanged.fire(test.uri);
      assert.strictEqual(test.timers.size, 0);
      assert.strictEqual(redraws, 0);
      test.viewState.visible = true;
      test.visibilityChanged.fire({ visible: true });
      assert.strictEqual(redraws, 1);
      assert.strictEqual(test.view.getChildren(), roots);
      test.liveChanged.fire(test.uri);
      assert.strictEqual(test.timers.size, 1);
      test.view.dispose();
      assert.strictEqual(test.timers.size, 0);
      test.liveChanged.fire(test.uri);
      test.flush();
      assert.strictEqual(redraws, 1);
    } finally { subscription.dispose(); test.dispose(); }
  });

  test('retains displayed data and suppresses redraws for body and line-only changes', async () => {
    const test = await harness();
    const root = test.view.getChildren()[0];
    const original = await test.view.getTreeItem(root);
    const originalLineCalls = test.linesByFile.get(test.uri.toString());
    let redraws = 0;
    const subscription = test.view.onDidChangeTreeData(() => { redraws++; });
    try {
      test.setLine(100);
      test.liveChanged.fire(test.uri);
      test.flush();
      assert.strictEqual(redraws, 0, 'Moving source positions alone does not redraw the tree');
      assert.strictEqual(await test.view.getTreeItem(root), original, 'The displayed line and description remain reusable');
      assert.strictEqual(test.linesByFile.get(test.uri.toString()), originalLineCalls,
        'Body edits must not trigger another line-number calculation');
      assert.strictEqual(original.description, 'structure-status.tex:2');
      test.viewState.visible = false;
      test.visibilityChanged.fire({ visible: false });
      test.liveChanged.fire(test.uri);
      test.viewState.visible = true;
      test.visibilityChanged.fire({ visible: true });
      test.flush();
      assert.strictEqual(redraws, 0, 'Showing an unchanged heading must not emit a redundant redraw');
      test.changed.fire(test.state.snapshot);
      const rebuilt = await test.view.getTreeItem(test.view.getChildren()[0]);
      assert.notStrictEqual(rebuilt, original);
      assert.strictEqual(rebuilt.description, 'structure-status.tex:100', 'A full saved-tree update refreshes the displayed line');
    } finally { subscription.dispose(); test.dispose(); }
  });

  test('reuses an unchanged included section item while its chapter name changes', async () => {
    const test = await harness({ child: true });
    const roots = test.view.getChildren();
    const chapter = roots[0];
    const included = test.view.getChildren(chapter)[0];
    const chapterItem = await test.view.getTreeItem(chapter);
    const includedItem = await test.view.getTreeItem(included);
    const childProjections = test.projectionsByFile.get(test.childUri.toString());
    const childLineCalls = test.linesByFile.get(test.childUri.toString());
    const notifications: unknown[] = [];
    const subscription = test.view.onDidChangeTreeData(element => { notifications.push(element); });
    try {
      assert.strictEqual(chapterItem.label, 'Retained heading');
      assert.strictEqual(includedItem.label, 'Included section');
      test.setTitle('Renamed chapter');
      test.liveChanged.fire(test.uri);
      test.flush();
      assert.strictEqual(notifications.length, 1);
      assert.notStrictEqual(notifications[0], undefined, 'A live name change must not invalidate the tree root');
      assert.strictEqual((await test.view.getTreeItem(chapter)).label, 'Renamed chapter');
      assert.strictEqual(test.view.getChildren(), roots);
      assert.strictEqual(test.view.getChildren(chapter)[0], included,
        'The section from the included file remains nested under its chapter');
      assert.strictEqual(await test.view.getTreeItem(included), includedItem,
        'VS Code may ask for descendants of a refreshed chapter; unchanged file data stays identical');
      assert.strictEqual(test.projectionsByFile.get(test.childUri.toString()), childProjections);
      assert.strictEqual(test.linesByFile.get(test.childUri.toString()), childLineCalls);
    } finally { subscription.dispose(); test.dispose(); }
  });

  test('keeps cross-file label descriptions at their saved owner until a whole-tree update', async () => {
    const test = await harness({ labels: true });
    const row = test.view.getChildren()[0];
    const original = await test.view.getTreeItem(row);
    let redraws = 0;
    const subscription = test.view.onDidChangeTreeData(() => { redraws++; });
    try {
      assert.strictEqual(original.label, 'sec:abc');
      assert.strictEqual(original.description, 'Retained heading · structure-child.tex:2');
      assert.strictEqual(test.projectionsByFile.get(test.uri.toString()), undefined,
        'A child label uses the saved name of its owner in another file');
      const childLineCalls = test.linesByFile.get(test.childUri.toString());
      test.setTitle('Renamed owner');
      test.liveChanged.fire(test.uri);
      test.flush();
      assert.strictEqual(redraws, 0);
      assert.strictEqual(await test.view.getTreeItem(row), original);
      assert.strictEqual(test.linesByFile.get(test.childUri.toString()), childLineCalls);
      assert.strictEqual(test.projectionsByFile.get(test.uri.toString()), undefined);
      test.liveChanged.fire(test.childUri);
      test.flush();
      assert.strictEqual(redraws, 0, 'A child edit must not pull in a live parent-file title either');
      assert.strictEqual(await test.view.getTreeItem(row), original);
      assert.strictEqual(test.projectionsByFile.get(test.uri.toString()), undefined);

      const savedOwner = { ...test.root, title: 'Renamed owner' };
      test.state.snapshot = { ...test.state.snapshot, roots: [savedOwner],
        labels: [{ ...test.state.snapshot.labels[0], node: savedOwner }] };
      test.changed.fire(test.state.snapshot);
      const saved = await test.view.getTreeItem(test.view.getChildren()[0]);
      assert.notStrictEqual(saved, original);
      assert.strictEqual(saved.description, 'Renamed owner · structure-child.tex:2');
    } finally { subscription.dispose(); test.dispose(); }
  });

  test('uses the saved cross-file owner when a label is first displayed after a parent edit', async () => {
    const test = await harness({ labels: true });
    try {
      test.setTitle('Unsaved parent title');
      test.liveChanged.fire(test.uri);
      test.flush();
      assert.strictEqual(test.projected, 0);
      assert.strictEqual(test.linesByFile.size, 0, 'A hidden/unrequested row does not calculate its line during another file edit');
      const row = test.view.getChildren()[0];
      const item = await test.view.getTreeItem(row);
      assert.strictEqual(item.description, 'Retained heading · structure-child.tex:2');
      assert.strictEqual(test.projectionsByFile.get(test.uri.toString()), undefined,
        'Lazy rendering must not make a child label depend on its edited parent file');
      assert.strictEqual(await test.view.getTreeItem(row), item);
    } finally { test.dispose(); }
  });

  test('reparents included headings from the new global hierarchy after a saved level change', async () => {
    const test = await harness({ child: true });
    try {
      const originalChapter = test.view.getChildren()[0];
      const originalChild = test.view.getChildren(originalChapter)[0];
      const originalItem = await test.view.getTreeItem(originalChild);
      const sameLevel = { ...test.root, constructName: 'section', level: 2, children: [] };
      test.state.snapshot = { ...test.state.snapshot, roots: [sameLevel, test.child] };
      test.changed.fire(test.state.snapshot);
      const roots = test.view.getChildren();
      assert.strictEqual(roots.length, 2, 'A section cannot own a following section of the same level');
      assert.deepStrictEqual(test.view.getChildren(roots[0]), []);
      assert.strictEqual((await test.view.getTreeItem(roots[1])).label, 'Included section');
      assert.notStrictEqual(await test.view.getTreeItem(roots[1]), originalItem,
        'A global rebuild resets display data together with the hierarchy');
    } finally { test.dispose(); }
  });
});
