import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import Config from '../Config';
import LaTeXProject from '../project/LaTeXProject';
import StructureService from '../structure/StructureService';
import { StructureNode } from '../structure/StructureTypes';

async function edit(document: vscode.TextDocument, start: number, end: number, text: string): Promise<void> {
  const change = new vscode.WorkspaceEdit();
  change.replace(document.uri, new vscode.Range(document.positionAt(start), document.positionAt(end)), text);
  assert.ok(await vscode.workspace.applyEdit(change));
}

function headingTree(nodes: readonly StructureNode[]): unknown[] {
  return nodes.map(node => [node.title, headingTree(node.children)]);
}

async function withProject(
  files: Record<string, string>,
  run: (documents: Record<string, vscode.TextDocument>, service: StructureService) => Promise<void>
): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fortex-hierarchy-reuse-'));
  const originalResolver = LaTeXProject.resolveMainFile;
  const originalTrigger = Config.compileTrigger;
  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  const config = vscode.workspace.getConfiguration('vscode-fortex');
  const inspected = config.inspect<boolean>('outline.followIncludes');
  const originalFollow = target === vscode.ConfigurationTarget.Workspace ? inspected?.workspaceValue : inspected?.globalValue;
  let service: StructureService | undefined;
  Config.compileTrigger = () => [];
  try {
    await config.update('outline.followIncludes', true, target);
    const documents: Record<string, vscode.TextDocument> = {};
    for (const [name, source] of Object.entries(files)) {
      const uri = vscode.Uri.file(path.join(directory, name));
      await fs.writeFile(uri.fsPath, source, 'utf8');
      documents[name] = await vscode.workspace.openTextDocument(uri);
    }
    LaTeXProject.resolveMainFile = async () => documents['main.tex'].uri;
    service = new StructureService(false);
    await service.refresh(documents['main.tex']);
    await run(documents, service);
  } finally {
    service?.dispose();
    LaTeXProject.resolveMainFile = originalResolver;
    Config.compileTrigger = originalTrigger;
    await config.update('outline.followIncludes', originalFollow, target);
    assert.strictEqual(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('fortex-hierarchy-reuse-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

suite('Project hierarchy with reusable file display data', function () {
  this.timeout(30000);

  test('keeps an included section beneath its chapter while only the chapter title is edited', async () => {
    await withProject({
      'main.tex': '\\chapter{a}\\input{abc.tex}',
      'abc.tex': '\\section{b}'
    }, async (documents, service) => {
      const roots = service.snapshot!.roots;
      assert.deepStrictEqual(headingTree(roots), [['a', [['b', []]]]]);
      const chapter = roots[0];
      const section = chapter.children[0];
      assert.strictEqual(chapter.constructName, 'chapter');
      assert.strictEqual(section.constructName, 'section');
      assert.strictEqual(section.declarationRange.uri.toString(), documents['abc.tex'].uri.toString());
      assert.strictEqual(section.declarationRange.start, 0);

      const titleStart = documents['main.tex'].getText().indexOf('{') + 1;
      await edit(documents['main.tex'], titleStart, titleStart + 1, 'Renamed chapter');
      assert.strictEqual(service.projectNode(chapter).title, 'Renamed chapter');
      assert.strictEqual(service.projectNode(section).title, 'b');
      assert.strictEqual(service.projectLocation(section.declarationRange).start, 0,
        'Editing the chapter does not shift source coordinates in the included file');
      assert.strictEqual(service.snapshot!.roots, roots);
      assert.deepStrictEqual(headingTree(roots), [['a', [['b', []]]]],
        'The global saved hierarchy and other-file nodes remain intact during editing');
    });
  });

  test('reparents unchanged included headings on a saved level change without reparsing their source', async () => {
    const childSource = '\\section{b}\\subsection{c}';
    await withProject({
      'main.tex': '\\chapter{a}\\input{abc.tex}\\chapter{next}',
      'abc.tex': childSource
    }, async (documents, service) => {
      assert.deepStrictEqual(headingTree(service.snapshot!.roots), [
        ['a', [['b', [['c', []]]]]], ['next', []]
      ]);
      const childVersion = service.snapshot!.roots[0].children[0].declarationRange.sourceSnapshotId;
      const parser: typeof import('../structure/LaTeXStructureParser') = require('../structure/LaTeXStructureParser');
      const originalParse = parser.parseStructureEvents;
      let childParses = 0;
      parser.parseStructureEvents = input => {
        if ((typeof input === 'string' ? input : input.source) === childSource) { childParses++; }
        return originalParse(input);
      };
      try {
        await edit(documents['main.tex'], 1, 1 + 'chapter'.length, 'section');
        assert.ok(await documents['main.tex'].save());
        const changed = (await service.current())!;
        assert.deepStrictEqual(headingTree(changed.roots), [
          ['a', []], ['b', [['c', []]]], ['next', []]
        ], 'An equal-level included section becomes a sibling, despite its file being unchanged');
        assert.strictEqual(changed.roots[1].declarationRange.sourceSnapshotId, childVersion);

        await edit(documents['main.tex'], 1, 1 + 'section'.length, 'chapter');
        assert.ok(await documents['main.tex'].save());
        const restored = (await service.current())!;
        assert.deepStrictEqual(headingTree(restored.roots), [
          ['a', [['b', [['c', []]]]]], ['next', []]
        ]);
        assert.strictEqual(restored.roots[0].children[0].declarationRange.sourceSnapshotId, childVersion);
        assert.strictEqual(childParses, 0, 'Global hierarchy construction reuses unchanged file analysis');
      } finally { parser.parseStructureEvents = originalParse; }
    });
  });

  test('carries section levels through nested includes and back into their parent files', async () => {
    await withProject({
      'main.tex': '\\chapter{a}\\input{abc.tex}\\section{after}',
      'abc.tex': '\\section{b}\\input{nested.tex}\\section{d}',
      'nested.tex': '\\subsection{c}\\chapter{other}\\section{under other}'
    }, async (_documents, service) => {
      assert.deepStrictEqual(headingTree(service.snapshot!.roots), [
        ['a', [['b', [['c', []]]]]],
        ['other', [['under other', []], ['d', []], ['after', []]]]
      ]);
    });
  });
});
