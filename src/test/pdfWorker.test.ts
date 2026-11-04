import * as assert from 'assert';
import { mkdtemp } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import PDFWorkerSource from '../compile/preview/PDFWorkerSource';

suite('PDF worker source', () => {
  test('reads exact worker bytes and reuses the cached result for concurrent and later requests', async () => {
    const root = vscode.Uri.file(await mkdtemp(path.join(os.tmpdir(), 'vscode-fortex-pdf-worker-')));
    const worker = vscode.Uri.joinPath(root, 'dist', 'vendor', 'pdfjs', 'pdf.worker.min.mjs');
    const content = Buffer.from('// 日本語 worker\nexport const version = "fixture";\n\0', 'utf8');

    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, 'dist', 'vendor', 'pdfjs'));
      await vscode.workspace.fs.writeFile(worker, content);
      const source = new PDFWorkerSource(root);

      const [first, concurrent] = await Promise.all([source.read(), source.read()]);
      assert.ok(first instanceof ArrayBuffer);
      assert.strictEqual(first.byteLength, content.byteLength);
      assert.deepStrictEqual(Buffer.from(first), content);
      assert.strictEqual(concurrent, first);

      // A subsequent panel must reuse the packaged worker without another read.
      await vscode.workspace.fs.delete(worker);
      assert.strictEqual(await source.read(), first);
    } finally {
      await vscode.workspace.fs.delete(root, { recursive: true, useTrash: false });
    }
  });

  test('retries after a failed read instead of caching the rejection', async () => {
    const root = vscode.Uri.file(await mkdtemp(path.join(os.tmpdir(), 'vscode-fortex-pdf-worker-')));
    const worker = vscode.Uri.joinPath(root, 'dist', 'vendor', 'pdfjs', 'pdf.worker.min.mjs');
    const content = Buffer.from('export const version = "available-after-retry";', 'utf8');

    try {
      const source = new PDFWorkerSource(root);
      await assert.rejects(source.read());

      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, 'dist', 'vendor', 'pdfjs'));
      await vscode.workspace.fs.writeFile(worker, content);
      assert.deepStrictEqual(Buffer.from(await source.read()), content);
    } finally {
      await vscode.workspace.fs.delete(root, { recursive: true, useTrash: false });
    }
  });
});
