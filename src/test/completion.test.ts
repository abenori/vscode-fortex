import * as assert from 'assert';
import * as vscode from 'vscode';
import { findCompletionContext } from '../completion/CompletionContext';
import LaTeXCompletionProvider from '../completion/LaTeXCompletionProvider';
import LabelCompletionProvider from '../completion/reference/LabelCompletionProvider';

suite('Line-based completion', () => {
  test('uses shared lexical rules for literal and escaped citation contexts', () => {
    for (const source of ['\\verb|\\cite{fake', '\\\\cite{fake', '\\mintinline{tex}|\\ref{fake']) {
      assert.strictEqual(findCompletionContext(source, source.length), undefined, source);
    }
    const source = '\\cite[see {p. [3]}]{first, second';
    assert.deepStrictEqual(findCompletionContext(source, source.length), {
      kind: 'citation', query: 'second', queryStart: source.indexOf('second')
    });
  });

  test('recognizes reference variants and preserves earlier keys and document offsets', () => {
    for (const command of ['ref', 'pageref', 'eqref', 'autoref', 'nameref', 'cref', 'Cref', 'vref', 'Vref']) {
      const line = `See \\${command}*{first,  sec:intro}`;
      const context = findCompletionContext(line, line.length - 1, 1000);
      assert.deepStrictEqual(context, {
        kind: 'reference', query: 'sec:intro', queryStart: 1000 + line.indexOf('sec:intro')
      });
    }
  });

  test('recognizes citations with optional arguments and command names', () => {
    const line = 'See \\cite[see][p. 3]{first, knuth tex}';
    assert.deepStrictEqual(findCompletionContext(line, line.length - 1, 100), {
      kind: 'citation', query: 'knuth tex', queryStart: 100 + line.indexOf('knuth tex')
    });
    assert.deepStrictEqual(findCompletionContext('日本語 \\sec', 8, 100), {
      kind: 'command', query: 'sec', start: 104
    });
  });

  test('preserves closing-delimiter replacement for environments', () => {
    const line = '  \\begin{itemize}';
    assert.deepStrictEqual(findCompletionContext(line, line.indexOf('itemize') + 3, 100), {
      kind: 'environment', style: 'named', query: 'ite', queryStart: 109, replaceEnd: 117
    });
    assert.deepStrictEqual(findCompletionContext('  \\[\\]', 4, 100), {
      kind: 'environment', style: 'display', query: '\\[', queryStart: 102, replaceEnd: 106
    });
  });

  test('ignores comments and completed arguments but allows escaped percent signs', () => {
    for (const line of ['% \\ref{x', '% \\cite{x', '% \\begin{ite', '% \\sec', '\\begin{ite % comment', '\\\\% \\ref{x', '\\ref{x}', 'plain text']) {
      assert.strictEqual(findCompletionContext(line, line.length), undefined, line);
    }
    const line = '\\% \\ref{x';
    assert.strictEqual(findCompletionContext(line, line.length)?.kind, 'reference');
    // Comments to the right of the cursor do not suppress completion.
    assert.strictEqual(findCompletionContext('\\ref{x} % comment', 6)?.kind, 'reference');
  });

  test('dispatches to exactly one provider using only the current line', async () => {
    const cancellation = new vscode.CancellationTokenSource();
    const calls: string[] = [];
    const result = new vscode.CompletionList([], true);
    const complete = (kind: string) => () => {
      calls.push(kind);
      return result;
    };
    const provider = new LaTeXCompletionProvider({
      reference: { complete: complete('reference') },
      citation: { complete: async () => complete('citation')() },
      environment: { complete: complete('environment') },
      command: { complete: complete('command') }
    });
    try {
      for (const [line, kind] of [
        ['\\ref{sec', 'reference'], ['\\cite{tex', 'citation'], ['\\begin{ite', 'environment'],
        ['\\[', 'environment'], ['\\sec', 'command'], ['plain text', undefined]
      ]) {
        assert.ok(line);
        calls.length = 0;
        const document = {
          lineAt: (lineNumber: number) => {
            assert.strictEqual(lineNumber, 15000);
            return { text: line, range: new vscode.Range(15000, 0, 15000, line.length) };
          },
          offsetAt: (position: vscode.Position) => {
            assert.deepStrictEqual(position, new vscode.Position(15000, 0));
            return 2000000;
          },
          getText: () => assert.fail('Context detection must not read document text')
        } as unknown as vscode.TextDocument;
        assert.strictEqual(
          await provider.provideCompletionItems(document, new vscode.Position(15000, line.length), cancellation.token),
          kind ? result : undefined
        );
        assert.deepStrictEqual(calls, kind ? [kind] : []);
      }
      cancellation.cancel();
      calls.length = 0;
      assert.strictEqual(provider.provideCompletionItems({} as vscode.TextDocument, new vscode.Position(0, 0), cancellation.token), undefined);
      assert.deepStrictEqual(calls, []);
    } finally {
      cancellation.dispose();
    }
  });

  test('reads keys once for an ongoing context and invokes only its provider', async () => {
    const document = await vscode.workspace.openTextDocument({
      language: 'latex',
      content: '\\label{sec:intro}\r\n\\label{eq:first}\r\n' + 'body\r\n'.repeat(5000) + '日本語 \\cref{eq:first, sec:i}'
    });
    const labels = new LabelCompletionProvider();
    const cancellation = new vscode.CancellationTokenSource();
    const unexpected = () => assert.fail('Reference completion must only invoke the label provider');
    const provider = new LaTeXCompletionProvider({
      reference: labels,
      citation: { complete: unexpected },
      environment: { complete: unexpected },
      command: { complete: unexpected }
    });
    try {
      const lineNumber = document.lineCount - 1;
      const line = document.lineAt(lineNumber).text;
      let reads = 0;
      const guarded = {
        uri: document.uri, version: document.version,
        offsetAt: (position: vscode.Position) => document.offsetAt(position),
        positionAt: (offset: number) => document.positionAt(offset),
        getText: () => {
          assert.strictEqual(++reads, 1, 'A continuation must not read document text again');
          return document.getText();
        },
        lineAt: (requestedLine: number | vscode.Position) => {
          const number = typeof requestedLine === 'number' ? requestedLine : requestedLine.line;
          assert.strictEqual(number, lineNumber);
          return document.lineAt(number);
        }
      } as unknown as vscode.TextDocument;
      await provider.provideCompletionItems(guarded, new vscode.Position(lineNumber, line.length - 1), cancellation.token);
      const result = await provider.provideCompletionItems(guarded, new vscode.Position(lineNumber, line.length - 1), cancellation.token);
      assert.ok(result);
      assert.deepStrictEqual(result.items.map(item => item.insertText), ['sec:intro']);
      assert.deepStrictEqual(result.items[0].range, new vscode.Range(lineNumber, line.indexOf('sec:i'), lineNumber, line.length - 1));
      assert.strictEqual(reads, 1);
    } finally {
      labels.dispose();
      cancellation.dispose();
    }
  });

  test('does not use commands on earlier lines to detect completion context', async () => {
    const document = await vscode.workspace.openTextDocument({
      language: 'latex', content: '\\ref{\nsec:intro\n\\cite{\nknuth\n\\begin\n{ite'
    });
    const unexpected = () => assert.fail('A command on a previous line must not trigger completion');
    const provider = new LaTeXCompletionProvider({
      reference: { complete: unexpected }, citation: { complete: unexpected },
      environment: { complete: unexpected }, command: { complete: unexpected }
    });
    const cancellation = new vscode.CancellationTokenSource();
    try {
      for (const line of [1, 3, 5]) {
        assert.strictEqual(await provider.provideCompletionItems(document, document.lineAt(line).range.end, cancellation.token), undefined);
      }
    } finally {
      cancellation.dispose();
    }
  });
});
