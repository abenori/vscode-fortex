import * as assert from 'assert';
import * as vscode from 'vscode';
import CommandCompletionProvider from '../completion/command/CommandCompletionProvider';
import { collectRawCommands } from '../completion/RawCompletionCollector';

const uncancelled: vscode.CancellationToken = {
  isCancellationRequested: false, onCancellationRequested: () => new vscode.Disposable(() => undefined)
};

async function replace(document: vscode.TextDocument, from: string, to: string): Promise<void> {
  const start = document.getText().indexOf(from);
  assert.ok(start >= 0);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(start), document.positionAt(start + from.length)), to);
  assert.ok(await vscode.workspace.applyEdit(edit));
}

async function localCommands(provider: CommandCompletionProvider, document: vscode.TextDocument, token = uncancelled): Promise<vscode.CompletionItem[]> {
  const source = document.getText();
  const start = source.lastIndexOf('\\');
  const result = await provider.complete(document, document.positionAt(source.length), { query: source.slice(start + 1), start }, token);
  return result?.items.filter(item => item.sortText?.startsWith('0:')) ?? [];
}

suite('Command completion input contexts', () => {
  test('reads unsaved definition changes on the next request without background indexing', async () => {
    const document = await vscode.workspace.openTextDocument({ language: 'latex', content: '\\newcommand\r\n{\\original}\r\n[1]\r\n{#1}\n\\' });
    const collector: { collectRawCommands: typeof collectRawCommands } = require('../completion/RawCompletionCollector');
    const original = collector.collectRawCommands;
    let scans = 0;
    collector.collectRawCommands = source => { scans++; return original(source); };
    const provider = new CommandCompletionProvider();
    try {
      await replace(document, 'original', 'renamed');
      assert.strictEqual(scans, 0);
      assert.deepStrictEqual((await localCommands(provider, document)).map(item => item.label), ['\\renamed']);
      await replace(document, '[1]', '[2]');
      assert.strictEqual(scans, 1);
      const items = await localCommands(provider, document);
      assert.ok(items[0].detail?.includes('2 arguments'));
      assert.strictEqual(scans, 2);
    } finally { provider.dispose(); collector.collectRawCommands = original; }
  });

  test('collects commented, literal and nested declarations with supported snippets', async () => {
    const source = '% \\newcommand{\\commented}[2][{x}]{#1#2}\n'
      + '\\begin{verbatim}\n\\newcommand{\\example}{}\n\\end{verbatim}\n'
      + '\\newcommand{\\outer}{\\newcommand{\\inner}[1]{#1}}\n\\';
    const document = await vscode.workspace.openTextDocument({ language: 'latex', content: source });
    const provider = new CommandCompletionProvider();
    try {
      const items = await localCommands(provider, document);
      assert.deepStrictEqual(items.map(item => item.label), ['\\commented', '\\example', '\\outer', '\\inner']);
      const snippet = items[0].insertText;
      assert.ok(snippet instanceof vscode.SnippetString);
      assert.match(snippet.value, /commented\[\$\{1:option\}\]/);
      assert.ok(snippet.value.includes('{${2:arg1}\\}'));
    } finally { provider.dispose(); }
  });

  test('reuses candidates while only the command fragment changes and releases them explicitly', async () => {
    const document = await vscode.workspace.openTextDocument({ language: 'latex', content: '\\newcommand{\\localcommand}{}\n\\l' });
    const collector: { collectRawCommands: typeof collectRawCommands } = require('../completion/RawCompletionCollector');
    const original = collector.collectRawCommands;
    let scans = 0;
    collector.collectRawCommands = source => { scans++; return original(source); };
    const provider = new CommandCompletionProvider();
    try {
      assert.ok((await localCommands(provider, document)).some(item => item.label === '\\localcommand'));
      const edit = new vscode.WorkspaceEdit();
      const end = document.positionAt(document.getText().length);
      edit.insert(document.uri, end, 'o');
      assert.ok(await vscode.workspace.applyEdit(edit));
      assert.ok((await localCommands(provider, document)).some(item => item.label === '\\localcommand'));
      assert.strictEqual(scans, 1);
      provider.invalidate();
      await localCommands(provider, document);
      assert.strictEqual(scans, 2);
      const cancelled = new vscode.CancellationTokenSource();
      cancelled.cancel();
      try { assert.deepStrictEqual(await localCommands(provider, document, cancelled.token), []); }
      finally { cancelled.dispose(); }
    } finally { provider.dispose(); collector.collectRawCommands = original; }
  });
});
