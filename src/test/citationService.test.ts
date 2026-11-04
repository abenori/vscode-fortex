import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import CitationService from '../completion/citation/CitationService';
import CitationCompletionProvider from '../completion/citation/CitationCompletionProvider';
import BibFileCache from '../completion/citation/BibFileCache';
import { CitationEntry } from '../completion/citation/Citation';
import KpsewhichResolver from '../project/KpsewhichResolver';
import LaTeXProject from '../project/LaTeXProject';
import * as Workspace from '../workspace';
import Config from '../Config';

async function replaceDocument(document: vscode.TextDocument, text: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
  assert.ok(await vscode.workspace.applyEdit(edit));
}

function projectSnapshot(mainfile: vscode.Uri, filelist: LaTeXProject['filelist']): LaTeXProject {
  return { mainfile, filelist } as LaTeXProject;
}

async function bibliographyDiscovery(
  main: vscode.Uri,
  sources: readonly string[],
  resolve: (references: readonly string[]) => readonly (vscode.Uri | undefined)[]
): Promise<{ references: string[]; watched: vscode.Uri[]; read: vscode.Uri[]; entries: CitationEntry[] }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fortex-citation-discovery-'));
  const originalCreate = LaTeXProject.create;
  const originalResolve = KpsewhichResolver.resolve;
  const originalSetReferences = BibFileCache.prototype.setReferences;
  const originalRead = BibFileCache.prototype.read;
  let service: CitationService | undefined;
  const references: string[] = [];
  const watched: vscode.Uri[] = [];
  const read: vscode.Uri[] = [];
  try {
    const files: vscode.Uri[] = [];
    for (const [index, source] of sources.entries()) {
      const uri = vscode.Uri.file(path.join(directory, `${index}.tex`));
      await fs.writeFile(uri.fsPath, source, 'utf8');
      files.push(uri);
    }
    LaTeXProject.create = async () => projectSnapshot(main,
      files.map(uri => ({ uri, type: LaTeXProject.LaTeXFileType.input, exists: true })));
    KpsewhichResolver.resolve = async (_main, names) => {
      references.push(...names);
      return resolve(names);
    };
    // Inspect both consumers of the resolved URI list without starting TeX or
    // requiring a filesystem provider for remote bibliography fixtures.
    BibFileCache.prototype.setReferences = (owner, uris) => {
      assert.strictEqual(owner, Workspace.uriKey(main));
      watched.push(...uris);
    };
    BibFileCache.prototype.read = async uri => {
      read.push(uri);
      return [{ key: uri.toString(), type: 'book', author: '', title: uri.path, sourceUri: uri }];
    };
    const document = { uri: main, isClosed: false, getText: () => sources[0] } as unknown as vscode.TextDocument;
    service = new CitationService();
    const entries = await service.entriesFor(document);
    return { references, watched, read, entries };
  } finally {
    service?.dispose();
    LaTeXProject.create = originalCreate;
    KpsewhichResolver.resolve = originalResolve;
    BibFileCache.prototype.setReferences = originalSetReferences;
    BibFileCache.prototype.read = originalRead;
    assert.strictEqual(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('fortex-citation-discovery-'));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

suite('Citation request-scoped project discovery', function () {
  this.timeout(20000);

  test('prefers Biber input-directory files and uses Kpathsea only for unresolved references', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fortex-biber-completion-'));
    const originalSettings = Config.programSettings;
    try {
      await fs.mkdir(path.join(directory, 'input'));
      await fs.writeFile(path.join(directory, 'refs.bib'), 'project-local');
      await fs.writeFile(path.join(directory, 'input', 'refs.bib'), 'input-local');
      await fs.writeFile(path.join(directory, 'input', 'extra.bib'), 'input-local');
      Config.programSettings = () => ({ command: 'biber', args: ['--input-directory=input'] });
      const main = vscode.Uri.file(path.join(directory, 'main.tex'));
      const fallback = vscode.Uri.file(path.join(directory, 'tree', 'fallback.bib'));
      const result = await bibliographyDiscovery(main,
        ['\\bibliography{refs,fallback}\n\\addbibresource{extra.bib}'], names => names.map(() => fallback));
      assert.deepStrictEqual(result.references, ['fallback.bib']);
      assert.deepStrictEqual(result.watched.map(Workspace.uriKey), [
        path.join(directory, 'input', 'refs.bib'), fallback.fsPath, path.join(directory, 'input', 'extra.bib')
      ].map(filename => Workspace.uriKey(vscode.Uri.file(filename))));
    } finally {
      Config.programSettings = originalSettings;
      assert.strictEqual(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('fortex-biber-completion-'));
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test('keeps a pending citation query valid while typing inside that query', async () => {
    const document = await vscode.workspace.openTextDocument({ language: 'latex', content: '\\bibliography{refs}\n\\cite{' });
    const queryStart = document.getText().length;
    const originalCreate = LaTeXProject.create;
    const originalResolve = KpsewhichResolver.resolve;
    const originalSetReferences = BibFileCache.prototype.setReferences;
    const originalRead = BibFileCache.prototype.read;
    let finish!: (project: LaTeXProject) => void;
    let begin!: () => void;
    const pendingProject = new Promise<LaTeXProject>(resolve => { finish = resolve; });
    const started = new Promise<void>(resolve => { begin = resolve; });
    let creations = 0;
    const cancellation = new vscode.CancellationTokenSource();
    const service = new CitationService();
    const provider = new CitationCompletionProvider(service);
    try {
      LaTeXProject.create = async (_file, options) => {
        creations++;
        assert.ok(options?.readSource, 'Project discovery must use a request-owned source snapshot');
        begin();
        return pendingProject;
      };
      KpsewhichResolver.resolve = async (_main, references) => references.map(() => undefined);
      BibFileCache.prototype.setReferences = () => {};
      BibFileCache.prototype.read = async sourceUri => [{ key: 'entry', type: 'book', author: '', title: 'Example', sourceUri }];
      const first = provider.complete(document, document.positionAt(queryStart), { query: '', queryStart }, cancellation.token);
      await started;
      const edit = new vscode.WorkspaceEdit();
      edit.insert(document.uri, document.positionAt(queryStart), 'e');
      assert.ok(await vscode.workspace.applyEdit(edit));
      const continued = provider.complete(document, document.positionAt(queryStart + 1), { query: 'e', queryStart }, cancellation.token);
      finish(projectSnapshot(document.uri, [{ uri: document.uri, type: LaTeXProject.LaTeXFileType.main, exists: true }]));
      await first;
      assert.deepStrictEqual((await continued)?.items.map(item => item.insertText), ['entry']);
      assert.strictEqual(creations, 1, 'Continuing a pending query must not restart project discovery');
    } finally {
      finish(projectSnapshot(document.uri, []));
      provider.dispose(); service.dispose(); cancellation.dispose();
      LaTeXProject.create = originalCreate;
      KpsewhichResolver.resolve = originalResolve;
      BibFileCache.prototype.setReferences = originalSetReferences;
      BibFileCache.prototype.read = originalRead;
    }
  });

  test('does not scan bibliography declarations when a source is edited without a request', async () => {
    const discovery: typeof import('../completion/citation/BibFileDiscovery') =
      require('../completion/citation/BibFileDiscovery');
    const originalDiscover = discovery.discoverBibReferences;
    const document = await vscode.workspace.openTextDocument({ language: 'latex', content: 'Ordinary body.' });
    let scans = 0;
    const service = new CitationService();
    try {
      discovery.discoverBibReferences = source => {
        scans++;
        return originalDiscover(source);
      };
      await replaceDocument(document, 'Changed body without a citation request.');
      assert.strictEqual(scans, 0);
    } finally {
      service.dispose();
      discovery.discoverBibReferences = originalDiscover;
    }
  });

  test('preserves reference case across project files and resolves URI aliases before reading or watching', async () => {
    const main = vscode.Uri.parse('vscode-remote://test-server/project/main.tex');
    const upper = vscode.Uri.joinPath(main, '..', 'Refs.bib');
    const lower = vscode.Uri.joinPath(main, '..', 'refs.bib');
    const shared = vscode.Uri.joinPath(main, '..', 'shared.bib');
    const result = await bibliographyDiscovery(main, [
      String.raw`\bibliography{Refs,shared,alias,Refs}`,
      String.raw`\bibliography{refs,Refs,./shared}`
    ], references => references.map(name => name === 'alias.bib' ? shared : undefined));
    assert.deepStrictEqual(result.references, ['Refs.bib', 'shared.bib', 'alias.bib', 'refs.bib', './shared.bib']);
    const expected = [upper, shared, lower].map(uri => uri.toString());
    assert.deepStrictEqual(result.watched.map(uri => uri.toString()), expected);
    assert.deepStrictEqual(result.read.map(uri => uri.toString()), expected);
    assert.deepStrictEqual(result.entries.map(entry => entry.key), expected);
  });

  test('uses the shared platform policy for local bibliography URI identity', async () => {
    const main = vscode.Uri.file(path.join(os.tmpdir(), 'fortex-citation-uri-policy', 'main.tex'));
    const result = await bibliographyDiscovery(main, [String.raw`\bibliography{Refs,refs,./Refs}`],
      references => references.map(() => undefined));
    assert.deepStrictEqual(result.references, ['Refs.bib', 'refs.bib', './Refs.bib']);
    const upper = vscode.Uri.joinPath(main, '..', 'Refs.bib');
    const lower = vscode.Uri.joinPath(main, '..', 'refs.bib');
    const expected = (process.platform === 'win32' ? [upper] : [upper, lower]).map(uri => uri.toString());
    assert.deepStrictEqual(result.watched.map(uri => uri.toString()), expected);
    assert.deepStrictEqual(result.read.map(uri => uri.toString()), expected);
    assert.deepStrictEqual(result.entries.map(entry => entry.key), expected);
  });

  test('discovers each request independently and skips missing filelist entries without reading them', async () => {
    const main = vscode.Uri.file(path.join(os.tmpdir(), 'fortex-citation-members', 'main.tex'));
    const child = vscode.Uri.joinPath(main, '..', 'chapters', 'child.tex');
    const missing = vscode.Uri.joinPath(main, '..', 'missing.tex');
    const document = { uri: child, isClosed: false, getText: () => '\\bibliography{child}' } as unknown as vscode.TextDocument;
    const documentText: { readDocumentText: typeof Workspace.readDocumentText } = require('../workspace/DocumentText');
    const originalCreate = LaTeXProject.create;
    const originalResolve = KpsewhichResolver.resolve;
    const originalSetReferences = BibFileCache.prototype.setReferences;
    const originalRead = BibFileCache.prototype.read;
    const originalReadSource = documentText.readDocumentText;
    const reads: string[] = [];
    let complete!: (project: LaTeXProject) => void;
    const project = new Promise<LaTeXProject>(resolve => { complete = resolve; });
    let creations = 0;
    let service: CitationService | undefined;
    try {
      LaTeXProject.create = async active => {
        assert.strictEqual(active, child);
        creations++;
        return project;
      };
      documentText.readDocumentText = async uri => {
        reads.push(uri.toString());
        assert.strictEqual(uri.toString(), main.toString(), 'Only existing project sources should be read');
        return '\\bibliography{main}';
      };
      KpsewhichResolver.resolve = async (resolvedMain, references) => {
        assert.strictEqual(resolvedMain, main);
        assert.deepStrictEqual(references, ['main.bib', 'child.bib']);
        return references.map(() => undefined);
      };
      BibFileCache.prototype.setReferences = () => {};
      BibFileCache.prototype.read = async uri => [
        { key: path.basename(uri.path), type: 'book', author: '', title: '', sourceUri: uri }
      ];
      service = new CitationService();
      const first = service.entriesFor(document);
      const second = service.entriesFor(document);
      assert.strictEqual(creations, 2, 'Independent requests must not share project state');
      complete(projectSnapshot(main, [
        { uri: main, type: LaTeXProject.LaTeXFileType.main, exists: true },
        { uri: missing, type: LaTeXProject.LaTeXFileType.include, exists: false },
        { uri: child, type: LaTeXProject.LaTeXFileType.input, exists: true }
      ]));
      for (const entries of await Promise.all([first, second])) {
        assert.deepStrictEqual(entries.map(entry => entry.key), ['main.bib', 'child.bib']);
      }
      assert.deepStrictEqual((await service.entriesFor(document)).map(entry => entry.key), ['main.bib', 'child.bib']);
      assert.strictEqual(creations, 3, 'A completed scope must not be retained for another request');
      assert.deepStrictEqual(reads, [main.toString(), main.toString(), main.toString()]);
    } finally {
      service?.dispose();
      LaTeXProject.create = originalCreate;
      KpsewhichResolver.resolve = originalResolve;
      BibFileCache.prototype.setReferences = originalSetReferences;
      BibFileCache.prototype.read = originalRead;
      documentText.readDocumentText = originalReadSource;
    }
  });

  for (const failed of [true, false]) {
    test(`uses the current unsaved text when project creation ${failed ? 'fails' : 'has no existing sources'}`, async () => {
      const uri = vscode.Uri.parse('untitled:fortex-citation-fallback');
      const bib = vscode.Uri.file(path.join(os.tmpdir(), 'fallback.bib'));
      const document = { uri, isClosed: false, getText: () => '\\bibliography{fallback}' } as unknown as vscode.TextDocument;
      const originalCreate = LaTeXProject.create;
      const originalResolve = KpsewhichResolver.resolve;
      const originalSetReferences = BibFileCache.prototype.setReferences;
      const originalRead = BibFileCache.prototype.read;
      let service: CitationService | undefined;
      try {
        LaTeXProject.create = async active => {
          assert.strictEqual(active, uri);
          if (failed) { throw new Error('No project for an unsaved document'); }
          return projectSnapshot(uri, [{ uri, type: LaTeXProject.LaTeXFileType.main, exists: false }]);
        };
        KpsewhichResolver.resolve = async (main, references) => {
          assert.strictEqual(main, uri);
          assert.deepStrictEqual(references, ['fallback.bib']);
          return [bib];
        };
        BibFileCache.prototype.setReferences = () => {};
        BibFileCache.prototype.read = async sourceUri => [
          { key: 'fallback-entry', type: 'book', author: '', title: '', sourceUri }
        ];
        service = new CitationService();
        assert.deepStrictEqual((await service.entriesFor(document)).map(entry => entry.key), ['fallback-entry']);
      } finally {
        service?.dispose();
        LaTeXProject.create = originalCreate;
        KpsewhichResolver.resolve = originalResolve;
        BibFileCache.prototype.setReferences = originalSetReferences;
        BibFileCache.prototype.read = originalRead;
      }
    });
  }

  test('does not resolve bibliography paths after disposal during project creation', async () => {
    const uri = vscode.Uri.parse('untitled:fortex-citation-disposed');
    const document = { uri, isClosed: false, getText: () => '\\bibliography{unused}' } as unknown as vscode.TextDocument;
    const originalCreate = LaTeXProject.create;
    const originalResolve = KpsewhichResolver.resolve;
    let complete!: (project: LaTeXProject) => void;
    const project = new Promise<LaTeXProject>(resolve => { complete = resolve; });
    let service: CitationService | undefined;
    try {
      LaTeXProject.create = async () => project;
      KpsewhichResolver.resolve = async () => assert.fail('Disposed scopes must not resolve bibliography paths');
      service = new CitationService();
      const pending = service.entriesFor(document);
      service.dispose();
      complete(projectSnapshot(uri, []));
      assert.deepStrictEqual(await pending, []);
    } finally {
      service?.dispose();
      LaTeXProject.create = originalCreate;
      KpsewhichResolver.resolve = originalResolve;
    }
  });

  test('discovers fresh bibliography sources for each request including unsaved input changes', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fortex-citation-scope-'));
    const uri = (name: string) => vscode.Uri.file(path.join(directory, name));
    const original = '\\documentclass{article}\r\n\\input{first}\r\n';
    const originalCreate = LaTeXProject.create;
    const originalResolve = KpsewhichResolver.resolve;
    let service: CitationService | undefined;
    let document: vscode.TextDocument | undefined;
    try {
      for (const [name, source] of Object.entries({
        'main.tex': original,
        'first.tex': '\\bibliography{first}',
        'second.tex': '\\bibliography{second}',
        'first.bib': '@book{first-entry,title={First}}',
        'second.bib': '@book{second-entry,title={Second}}'
      })) {
        await fs.writeFile(uri(name).fsPath, source, 'utf8');
      }
      document = await vscode.workspace.openTextDocument(uri('main.tex'));
      let creations = 0;
      LaTeXProject.create = async (active, options) => {
        creations++;
        return originalCreate(active, options);
      };
      // Resolve the known local fixtures directly without requiring a TeX install.
      KpsewhichResolver.resolve = async (_main, references) => references.map(() => undefined);
      service = new CitationService();
      assert.deepStrictEqual((await service.entriesFor(document)).map(entry => entry.key), ['first-entry']);
      assert.deepStrictEqual((await service.entriesFor(document)).map(entry => entry.key), ['first-entry']);
      assert.strictEqual(creations, 2, 'Each request creates its own project');
      await replaceDocument(document, original + 'Ordinary body text.\r\n');
      assert.deepStrictEqual((await service.entriesFor(document)).map(entry => entry.key), ['first-entry']);
      assert.strictEqual(creations, 3);
      await replaceDocument(document, '\\documentclass{article}\r\n\\input{second}\r\n');
      assert.deepStrictEqual((await service.entriesFor(document)).map(entry => entry.key), ['second-entry']);
      assert.strictEqual(creations, 4);
    } finally {
      service?.dispose();
      LaTeXProject.create = originalCreate;
      KpsewhichResolver.resolve = originalResolve;
      if (document && !document.isClosed) {
        await replaceDocument(document, original);
      }
      assert.strictEqual(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('fortex-citation-scope-'));
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test('follows unsaved uppercase main directives and bibliography declarations through the shared project resolver', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fortex-citation-main-'));
    const uri = (name: string) => vscode.Uri.file(path.join(directory, name));
    const configuration = vscode.workspace.getConfiguration('vscode-fortex');
    const originalOrder = configuration.inspect('mainFileOrder')?.globalValue;
    const originalResolve = KpsewhichResolver.resolve;
    const originalChild = '%#MAIN first.tex\r\nChild body.\r\n';
    const originalSecond = '\\documentclass{article}\r\n\\bibliography{second}\r\n';
    let service: CitationService | undefined;
    let child: vscode.TextDocument | undefined;
    let second: vscode.TextDocument | undefined;
    try {
      for (const [name, source] of Object.entries({
        'child.tex': originalChild,
        'first.tex': '\\documentclass{article}\r\n\\bibliography{first}\r\n',
        'second.tex': originalSecond,
        'first.bib': '@book{first-entry,title={First}}',
        'second.bib': '@book{second-entry,title={Second}}',
        'third.bib': '@book{third-entry,title={Third}}'
      })) {
        await fs.writeFile(uri(name).fsPath, source, 'utf8');
      }
      await configuration.update('mainFileOrder', ['magic', 'current'], vscode.ConfigurationTarget.Global);
      KpsewhichResolver.resolve = async (_main, references) => references.map(() => undefined);
      child = await vscode.workspace.openTextDocument(uri('child.tex'));
      service = new CitationService();
      assert.deepStrictEqual((await service.entriesFor(child)).map(entry => entry.key), ['first-entry']);

      await replaceDocument(child, '%#MAIN second.tex\r\nChild body.\r\n');
      assert.deepStrictEqual((await service.entriesFor(child)).map(entry => entry.key), ['second-entry']);
      assert.strictEqual(await fs.readFile(uri('child.tex').fsPath, 'utf8'), originalChild);

      // A bibliography change does not change the parent decision. The citation
      // service must still refresh its own aggregation of bibliography sources.
      second = await vscode.workspace.openTextDocument(uri('second.tex'));
      await replaceDocument(second, '\\documentclass{article}\r\n\\bibliography{third}\r\n');
      assert.deepStrictEqual((await service.entriesFor(child)).map(entry => entry.key), ['third-entry']);
      assert.strictEqual(await fs.readFile(uri('second.tex').fsPath, 'utf8'), originalSecond);
    } finally {
      service?.dispose();
      KpsewhichResolver.resolve = originalResolve;
      for (const [document, original] of [[child, originalChild], [second, originalSecond]] as const) {
        if (document && !document.isClosed) {
          await replaceDocument(document, original);
        }
      }
      await configuration.update('mainFileOrder', originalOrder, vscode.ConfigurationTarget.Global);
      assert.strictEqual(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('fortex-citation-main-'));
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
