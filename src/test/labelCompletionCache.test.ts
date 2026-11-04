import * as assert from 'assert';
import * as vscode from 'vscode';
import LabelCompletionProvider from '../completion/reference/LabelCompletionProvider';
import { collectRawLabels } from '../completion/RawCompletionCollector';

const uncancelled: vscode.CancellationToken = {
  isCancellationRequested: false, onCancellationRequested: () => new vscode.Disposable(() => undefined)
};

async function replace(document: vscode.TextDocument, start: number, end: number, text: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(start), document.positionAt(end)), text);
  assert.ok(await vscode.workspace.applyEdit(edit));
}

async function complete(provider: LabelCompletionProvider, document: vscode.TextDocument, token = uncancelled): Promise<vscode.CompletionList | undefined> {
  const source = document.getText();
  const start = source.lastIndexOf('\\ref{') + 5;
  return provider.complete(document, document.positionAt(source.length), { query: source.slice(start), queryStart: start }, token);
}

suite('Label completion input contexts', () => {
  test('does no eager indexing and reads latest unsaved text on a new request', async () => {
    const document = await vscode.workspace.openTextDocument({ language: 'latex', content: '\\label{old}\n\\ref{' });
    const collector: { collectRawLabels: typeof collectRawLabels } = require('../completion/RawCompletionCollector');
    const original = collector.collectRawLabels;
    let scans = 0;
    collector.collectRawLabels = source => { scans++; return original(source); };
    const provider = new LabelCompletionProvider();
    try {
      assert.strictEqual(scans, 0);
      await replace(document, 7, 10, 'latest');
      assert.strictEqual(scans, 0, 'Editing without a request must not collect labels');
      const result = await complete(provider, document);
      assert.deepStrictEqual(result?.items.map(item => item.insertText), ['latest']);
      assert.strictEqual(scans, 1);
      assert.strictEqual(result?.items[0].documentation, undefined);
      assert.strictEqual(result?.items[0].detail, undefined);
    } finally { provider.dispose(); collector.collectRawLabels = original; }
  });

  test('reuses candidates only while edits stay within the same reference query', async () => {
    const document = await vscode.workspace.openTextDocument({ language: 'latex', content: '\\label{sec:first}\n\\ref{s' });
    const collector: { collectRawLabels: typeof collectRawLabels } = require('../completion/RawCompletionCollector');
    const original = collector.collectRawLabels;
    let scans = 0;
    collector.collectRawLabels = source => { scans++; return original(source); };
    const provider = new LabelCompletionProvider();
    try {
      assert.deepStrictEqual((await complete(provider, document))?.items.map(item => item.insertText), ['sec:first']);
      const end = document.getText().length;
      await replace(document, end, end, 'e');
      assert.deepStrictEqual((await complete(provider, document))?.items.map(item => item.insertText), ['sec:first']);
      assert.strictEqual(scans, 1, 'A query continuation must not read and parse all labels again');
      const key = document.getText().indexOf('sec:first');
      await replace(document, key, key + 'sec:first'.length, 'sec:changed');
      assert.strictEqual(scans, 1, 'An outside edit should only drop the session');
      assert.deepStrictEqual((await complete(provider, document))?.items.map(item => item.insertText), ['sec:changed']);
      assert.strictEqual(scans, 2);
      provider.invalidate();
      await complete(provider, document);
      assert.strictEqual(scans, 3);
    } finally { provider.dispose(); collector.collectRawLabels = original; }
  });

  test('includes inactive textual labels, deduplicates keys, and balances multiline arguments', async () => {
    const source = '% \\label{comment}\n\\verb|\\label{literal}|\n'
      + '\\newcommand{\\example}{\\label{definition}}\n'
      + '\\label{ du% ignored }\r\nplicate{nested}\\{x\\} }\n'
      + '\\label{comment}\n\\label{}\n\\label{unfinished\n\\ref{';
    const document = await vscode.workspace.openTextDocument({ language: 'latex', content: source });
    const provider = new LabelCompletionProvider();
    try {
      assert.deepStrictEqual((await complete(provider, document))?.items.map(item => item.insertText),
        ['comment', 'definition', String.raw`duplicate{nested}\{x\}`, 'literal'].sort((a, b) => a.localeCompare(b)));
    } finally { provider.dispose(); }
  });

  test('resolves documentation lazily from the newest source rather than retained text', async () => {
    const document = await vscode.workspace.openTextDocument({ language: 'latex', content: 'Earlier description\n\\label{target}\n\\ref{' });
    const provider = new LabelCompletionProvider();
    try {
      const item = (await complete(provider, document))?.items[0];
      assert.ok(item);
      assert.strictEqual(item.documentation, undefined);
      await replace(document, 0, 'Earlier description'.length, 'Latest unsaved description');
      const resolved = await provider.resolveCompletionItem(item, uncancelled);
      assert.ok(resolved.documentation instanceof vscode.MarkdownString);
      assert.match(resolved.documentation.value, /Latest unsaved description/);
      assert.doesNotMatch(resolved.documentation.value, /Earlier description/);
    } finally { provider.dispose(); }
  });

  test('returns no candidates for cancellation and after disposal', async () => {
    const document = await vscode.workspace.openTextDocument({ language: 'latex', content: '\\label{first}\n\\ref{' });
    const provider = new LabelCompletionProvider();
    const cancelled = new vscode.CancellationTokenSource();
    cancelled.cancel();
    try {
      assert.strictEqual(await complete(provider, document, cancelled.token), undefined);
      provider.dispose();
      assert.strictEqual(await complete(provider, document), undefined);
    } finally { provider.dispose(); cancelled.dispose(); }
  });
});
