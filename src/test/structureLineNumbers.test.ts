import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import Config from '../Config';
import LaTeXProject from '../project/LaTeXProject';
import StructureService from '../structure/StructureService';
import SourceLineIndex from '../structure/SourceLineIndex';
import { StructureNode } from '../structure/StructureTypes';
import * as Workspace from '../workspace';

function headings(nodes: readonly StructureNode[]): StructureNode[] {
  return nodes.flatMap(node => [...(node.kind === 'section' ? [node] : []), ...headings(node.children)]);
}

suite('Closed outline source line numbers', function () {
  this.timeout(30000);

  test('builds one lazy index, reuses it for unchanged bytes and replaces it after source changes', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fortex-source-lines-'));
    const main = vscode.Uri.file(path.join(directory, 'main.tex'));
    const child = vscode.Uri.file(path.join(directory, 'child.tex'));
    const source = '\\section{First}\r\n日本語 😀 body\r\n\\subsection{Second}\rTail\n';
    const service = new StructureService(false);
    const originalResolver = LaTeXProject.resolveMainFile;
    const originalTrigger = Config.compileTrigger;
    const internals = service as unknown as {
      sources: Map<string, { analysis: { lines?: SourceLineIndex } }>;
      refreshSource(uri: vscode.Uri): Promise<void>;
    };
    Config.compileTrigger = () => [];
    LaTeXProject.resolveMainFile = async () => main;
    try {
      await fs.writeFile(main.fsPath, '\\documentclass{article}\n\\input{child}', 'utf8');
      await fs.writeFile(child.fsPath, source, 'utf8');
      await service.refresh(await vscode.workspace.openTextDocument(main));
      assert.strictEqual(Workspace.findOpenDocument(child), undefined);
      const key = Workspace.uriKey(child);
      const saved = internals.sources.get(key)!;
      assert.strictEqual(saved.analysis.lines, undefined, 'Parsing alone does not allocate a line index');
      const nodes = headings(service.snapshot!.roots);
      assert.strictEqual(nodes.length, 2);
      assert.strictEqual(service.lineNumber(nodes[1].declarationRange), 3);
      const index = saved.analysis.lines!;
      assert.ok(index instanceof SourceLineIndex);
      for (let query = 0; query < 1000; query++) {
        assert.strictEqual(service.lineNumber(nodes[0].declarationRange), 1);
        assert.strictEqual(service.lineNumber(nodes[1].declarationRange), 3);
      }
      assert.strictEqual(internals.sources.get(key)!.analysis.lines, index);
      assert.strictEqual(Workspace.findOpenDocument(child), undefined, 'Line queries never open the source');

      await internals.refreshSource(child);
      await service.current();
      assert.strictEqual(internals.sources.get(key), saved);
      assert.strictEqual(internals.sources.get(key)!.analysis.lines, index);

      await fs.writeFile(child.fsPath, '\n' + source, 'utf8');
      await internals.refreshSource(child);
      await service.current();
      const updated = internals.sources.get(key)!;
      assert.notStrictEqual(updated, saved);
      assert.strictEqual(updated.analysis.lines, undefined);
      const latest = headings(service.snapshot!.roots);
      assert.strictEqual(service.lineNumber(latest[1].declarationRange), 4);
      assert.notStrictEqual(updated.analysis.lines, index);
      assert.strictEqual(service.lineNumber(nodes[1].declarationRange), undefined, 'Old saved positions do not use the new source index');

      const document = await vscode.workspace.openTextDocument(child);
      // VS Code normalizes mixed line endings on open. Compare identical text,
      // rather than offsets in the original persisted bytes against its buffer.
      const openedIndex = new SourceLineIndex(document.getText());
      for (let offset = 0; offset <= document.getText().length; offset++) {
        assert.strictEqual(openedIndex.lineNumberAt(offset), document.positionAt(offset).line + 1);
      }
    } finally {
      service.dispose();
      LaTeXProject.resolveMainFile = originalResolver;
      Config.compileTrigger = originalTrigger;
      assert.strictEqual(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('fortex-source-lines-'));
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
