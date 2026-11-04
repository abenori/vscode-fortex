import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import Config from '../Config';
import StructureService from '../structure/StructureService';
import LaTeXDocumentSymbolProvider from '../structure/LaTeXDocumentSymbolProvider';
import { StructureNode } from '../structure/StructureTypes';

function headings(nodes: readonly StructureNode[]): StructureNode[] {
  return nodes.flatMap(node => [...(node.kind === 'section' ? [node] : []), ...headings(node.children)]);
}

async function edit(document: vscode.TextDocument, start: number, end: number, text: string): Promise<void> {
  const change = new vscode.WorkspaceEdit();
  change.replace(document.uri, new vscode.Range(document.positionAt(start), document.positionAt(end)), text);
  assert.ok(await vscode.workspace.applyEdit(change));
}

async function withSources(
  files: Record<string, string>,
  run: (documents: Record<string, vscode.TextDocument>, service: StructureService, provider: LaTeXDocumentSymbolProvider) => Promise<void>
): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fortex-live-outline-'));
  const service = new StructureService(false);
  const provider = new LaTeXDocumentSymbolProvider(service);
  const originalTrigger = Config.compileTrigger;
  Config.compileTrigger = () => [];
  try {
    const documents: Record<string, vscode.TextDocument> = {};
    for (const [name, source] of Object.entries(files)) {
      const uri = vscode.Uri.file(path.join(directory, name));
      await fs.writeFile(uri.fsPath, source, 'utf8');
      documents[name] = await vscode.workspace.openTextDocument(uri);
    }
    await service.refresh(documents['main.tex']);
    await run(documents, service, provider);
  } finally {
    provider.dispose();
    service.dispose();
    Config.compileTrigger = originalTrigger;
    assert.strictEqual(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('fortex-live-outline-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

suite('Live heading projection', function () {
  this.timeout(30000);

  test('updates a title locally and retains its last confirmed name through incomplete braces', async () => {
    await withSources({ 'main.tex': '\\documentclass{article}\n\\section{Original}\nBody\n' }, async (documents, service, provider) => {
      const document = documents['main.tex'];
      const saved = headings(service.snapshot!.roots)[0];
      await provider.provideDocumentSymbols(document);
      const titleStart = document.getText().indexOf('Original');
      await edit(document, titleStart, titleStart + 'Original'.length, 'Fresh \\textbf{title}');
      assert.deepStrictEqual((await provider.provideDocumentSymbols(document)).map(symbol => symbol.name), ['Fresh title']);
      assert.strictEqual(service.projectNode(saved).title, 'Fresh title');
      assert.strictEqual(saved.title, 'Original', 'The saved project tree remains immutable');

      const declarationEnd = document.getText().indexOf('\n', document.getText().indexOf('\\section'));
      await edit(document, titleStart, declarationEnd - 1, 'Unfinished {new');
      assert.deepStrictEqual((await provider.provideDocumentSymbols(document)).map(symbol => symbol.name), ['Fresh title']);
      assert.strictEqual(service.projectNode(saved).title, 'Fresh title');
      const target = service.projectLocation(saved.declarationRange);
      assert.strictEqual(document.getText().slice(target.start, target.start + '\\section'.length), '\\section',
        'An incomplete title retains a target at its heading command');

      const closing = document.getText().indexOf('\n', document.getText().indexOf('\\section')) - 1;
      await edit(document, closing, closing, '}');
      assert.deepStrictEqual((await provider.provideDocumentSymbols(document)).map(symbol => symbol.name), ['Unfinished new']);
      assert.strictEqual(service.projectNode(saved).title, 'Unfinished new');
      assert.strictEqual(saved.title, 'Original');
    });
  });

  test('shares title work and position correction across native symbols and repeated project inclusions', async () => {
    await withSources({
      'main.tex': '\\documentclass{article}\n\\section{Root}\n\\input{child}\n\\input{child}\n',
      'child.tex': '\\subsection{Saved child}\nBody\n'
    }, async (documents, service, provider) => {
      const child = documents['child.tex'];
      const occurrences = headings(service.snapshot!.roots).filter(node => node.declarationRange.uri.toString() === child.uri.toString());
      assert.strictEqual(occurrences.length, 2);
      await provider.provideDocumentSymbols(child);
      const parser: typeof import('../structure/LaTeXStructureParser') = require('../structure/LaTeXStructureParser');
      const originalEvents = parser.parseStructureEvents;
      const originalTitle = parser.readHeadingTitle;
      let fullParses = 0;
      let titleParses = 0;
      let projectPublications = 0;
      parser.parseStructureEvents = (...args) => { fullParses++; return originalEvents(...args); };
      parser.readHeadingTitle = (...args) => { titleParses++; return originalTitle(...args); };
      const subscription = service.onDidChange(() => { projectPublications++; });
      try {
        const start = child.getText().indexOf('Saved child');
        await edit(child, start, start + 'Saved child'.length, 'Changed child');
        assert.strictEqual(fullParses, 0);
        assert.strictEqual(titleParses, 0, 'The input callback records numbers only');
        const first = service.projectNode(occurrences[0]);
        const second = service.projectNode(occurrences[1]);
        const symbols = await provider.provideDocumentSymbols(child);
        assert.strictEqual(first.title, 'Changed child');
        assert.strictEqual(second.title, 'Changed child');
        assert.deepStrictEqual(symbols.map(symbol => symbol.name), ['Changed child']);
        assert.strictEqual(titleParses, 1, 'Both project occurrences and native Outline share one title parse');
        assert.strictEqual(fullParses, 0);
        assert.strictEqual(projectPublications, 0, 'Typing never rebuilds or republishes the project');

        await edit(child, 0, 0, '前文 😀\r\n');
        const shiftedSymbols = await provider.provideDocumentSymbols(child);
        const shifted = service.projectNode(occurrences[0]);
        const target = service.projectLocation(occurrences[0].declarationRange);
        assert.strictEqual(shifted.title, 'Changed child');
        assert.strictEqual(target.start, shifted.declarationRange.start);
        assert.strictEqual(child.positionAt(target.start).line, shiftedSymbols[0].selectionRange.start.line);
        assert.strictEqual(child.positionAt(target.start).character, shiftedSymbols[0].selectionRange.start.character);
        assert.strictEqual(titleParses, 1, 'Later body edits reuse the confirmed title');
        assert.strictEqual(fullParses, 0);
        assert.strictEqual(service.lineNumber(occurrences[0].declarationRange), 2);
      } finally {
        parser.parseStructureEvents = originalEvents;
        parser.readHeadingTitle = originalTitle;
        subscription.dispose();
      }
    });
  });

  test('updates a renamed heading after its removed outer closing brace is restored', async () => {
    await withSources({ 'main.tex': '\\documentclass{article}\n\\section{Original}\nBody\n' }, async (documents, service, provider) => {
      const document = documents['main.tex'];
      const saved = headings(service.snapshot!.roots)[0];
      await provider.provideDocumentSymbols(document);
      await edit(document, saved.declarationRange.end - 1, saved.declarationRange.end, '');
      const titleStart = document.getText().indexOf('Original');
      await edit(document, titleStart, titleStart + 'Original'.length, 'Renamed');
      assert.deepStrictEqual((await provider.provideDocumentSymbols(document)).map(symbol => symbol.name), ['Original']);
      assert.strictEqual(service.projectNode(saved).title, 'Original');
      const declarationEnd = document.getText().indexOf('\n', document.getText().indexOf('\\section'));
      await edit(document, declarationEnd, declarationEnd, '}');
      assert.deepStrictEqual((await provider.provideDocumentSymbols(document)).map(symbol => symbol.name), ['Renamed']);
      assert.strictEqual(service.projectNode(saved).title, 'Renamed');
      assert.strictEqual(saved.title, 'Original', 'Restoring the title does not replace the saved project snapshot');
      assert.ok(document.isDirty);
    });
  });

  test('retains existing items and approximate targets even after the command is deleted', async () => {
    await withSources({ 'main.tex': '\\documentclass{article}\n\\section{Kept}\nBody\n' }, async (documents, service, provider) => {
      const document = documents['main.tex'];
      const saved = headings(service.snapshot!.roots)[0];
      await provider.provideDocumentSymbols(document);
      await edit(document, saved.declarationRange.start, saved.declarationRange.end, '');
      const symbols = await provider.provideDocumentSymbols(document);
      assert.deepStrictEqual(symbols.map(symbol => symbol.name), ['Kept']);
      const target = service.projectLocation(saved.declarationRange);
      assert.ok(Number.isFinite(target.start) && target.start >= 0);
      assert.ok(target.end >= target.start);
      assert.strictEqual(service.projectNode(saved).title, 'Kept');

      assert.ok(await document.save());
      await service.current();
      assert.deepStrictEqual(await provider.provideDocumentSymbols(document), []);
      assert.deepStrictEqual(service.projectLocation(saved.declarationRange), saved.declarationRange,
        'Locations from a prior saved version retain their offsets as approximate targets');
    });
  });
});
