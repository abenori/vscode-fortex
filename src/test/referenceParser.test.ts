import * as assert from 'assert';
import * as LaTeXParser from '../latex-parser';
import { findReferenceContext } from '../completion/reference/LabelParser';

const referenceCommands = ['ref', 'pageref', 'eqref', 'autoref', 'nameref', 'cref', 'Cref', 'vref', 'Vref'];

suite('LaTeX reference parser', () => {
  test('recognizes reference commands and their stars while retaining label commas', () => {
    const source = '\\label{one,two}' + referenceCommands.map(command => `\\${command}*{one, two}`).join('');
    const tokens = new LaTeXParser.ReferenceParser(source).tokens;
    assert.deepStrictEqual(tokens.map(token => [token.kind, token.command, token.key]), [
      ['label', 'label', 'one,two'],
      ...referenceCommands.flatMap(command => [
        ['reference', command, 'one'], ['reference', command, 'two']
      ])
    ]);
    assert.ok(tokens.every(token => token.commandEnd > token.keyEnd));
  });

  test('accepts an existing scanner and preserves duplicates and UTF-16 source offsets', () => {
    const source = '😀\\label{日本語}\\ref{日本語}\\label{日本語}';
    const scanner = new LaTeXParser.SourceScanner(source);
    const parser = new LaTeXParser.ReferenceParser(scanner);
    assert.strictEqual(parser.source, source);
    assert.deepStrictEqual(parser.tokens, new LaTeXParser.ReferenceParser(source).tokens);
    assert.strictEqual(parser.tokens[0].commandStart, 2);
    assert.deepStrictEqual(parser.tokens.map(token => token.kind), ['label', 'reference', 'label']);
    for (const token of parser.tokens) {
      assert.strictEqual(source.slice(token.keyStart, token.keyEnd), token.key);
      assert.ok(source.slice(token.commandStart, token.commandEnd).startsWith(`\\${token.command}`));
    }
  });

  test('ignores comments, literals, escaped commands and different control words', () => {
    const source = [
      '% \\label{comment} \\ref{comment}',
      String.raw`\verb|\label{inline}\ref{inline}|`,
      String.raw`\lstinline{\ref{inline}}`,
      String.raw`\begin{minted}{tex}\label{literal}\ref{literal}\end{minted}`,
      String.raw`\\label{escaped}\\ref{escaped}\refname{other}\Crefname{other}`,
      String.raw`\label{visible}\cref{visible}`
    ].join('\r\n');
    assert.deepStrictEqual(new LaTeXParser.ReferenceParser(source).tokens.map(token => token.key), [
      'visible', 'visible'
    ]);
  });

  test('joins comments across CRLF while keeping ranges in the original source', () => {
    const source = '😀\\label % before\r\n { sec:in% ignored }\r\ntro % trailing\r\n }\r\n'
      + '\\cref*{one,% ignored ,\r\n two, three}';
    const scanner = new LaTeXParser.SourceScanner(source);
    const tokens = new LaTeXParser.ReferenceParser(scanner).tokens;
    assert.deepStrictEqual(tokens.map(token => token.key), ['sec:intro', 'one', 'two', 'three']);
    assert.strictEqual(tokens[0].keyStart, source.indexOf('sec:in'));
    assert.strictEqual(tokens[0].keyEnd, source.indexOf('tro %') + 3);
    assert.strictEqual(tokens[2].keyStart, source.indexOf('two,'));
    for (const token of tokens) {
      assert.strictEqual(scanner.textWithoutComments(token.keyStart, token.keyEnd), token.key);
    }
  });

  test('handles nested groups and control symbols without splitting their commas or parsing nested commands', () => {
    const source = String.raw`\cref{outer{a,b}, escaped\,comma, \label{nested}, last}\label{outside}`;
    const tokens = new LaTeXParser.ReferenceParser(source).tokens;
    assert.deepStrictEqual(tokens.map(token => [token.kind, token.key]), [
      ['reference', 'outer{a,b}'], ['reference', String.raw`escaped\,comma`],
      ['reference', String.raw`\label{nested}`], ['reference', 'last'], ['label', 'outside']
    ]);
  });

  test('skips absent, empty and unfinished arguments and recovers later complete declarations', () => {
    const source = '\\label \\ref{}\\cref{, ,}\\ref{unfinished\r\n\\label{later}\\ref{good}';
    assert.deepStrictEqual(new LaTeXParser.ReferenceParser(source).tokens.map(token => [token.kind, token.key]), [
      ['label', 'later'], ['reference', 'good']
    ]);
  });

  test('retains definition bodies as lexical source without attempting macro expansion', () => {
    const source = String.raw`\newcommand{\example}{\label{raw}\ref{raw}}\example`;
    assert.deepStrictEqual(new LaTeXParser.ReferenceParser(source).tokens.map(token => token.key), ['raw', 'raw']);
  });

  test('selects the nearest key at command and brace positions', () => {
    const source = 'See \\cref{first, second}.';
    const parser = new LaTeXParser.ReferenceParser(source);
    assert.strictEqual(parser.tokenAt(source.indexOf('cref'))?.key, 'first');
    assert.strictEqual(parser.tokenAt(source.indexOf('second') + 2)?.key, 'second');
    assert.strictEqual(parser.tokenAt(source.indexOf('}'))?.key, 'second');
    assert.strictEqual(parser.tokenAt(0), undefined);
    assert.strictEqual(parser.tokenAt(source.length), undefined);
    for (const offset of [-1, 0.5, NaN, Infinity, source.length + 1]) {
      assert.strictEqual(parser.tokenAt(offset), undefined);
    }
  });

  test('retains duplicate labels and comment continuations across line endings', () => {
    for (const eol of ['\n', '\r\n', '\r']) {
      const source = ['\\section{Introduction}', '\\label % label', '{sec:in% join', 'tro}',
        '\\label{sec:intro}', String.raw`\verb|\label{ignored}|`].join(eol);
      const labels = new LaTeXParser.ReferenceParser(source).tokens.filter(token => token.kind === 'label');
      assert.deepStrictEqual(labels.map(label => label.key), ['sec:intro', 'sec:intro']);
      assert.strictEqual(labels[0].commandStart, source.indexOf('\\label'));
      assert.strictEqual(labels[0].keyStart, source.indexOf('sec:in'));
      assert.strictEqual(source.slice(labels[1].commandStart, labels[1].commandEnd), '\\label{sec:intro}');
    }
  });

  test('finds partial reference keys without requiring a complete document parse', () => {
    for (const command of referenceCommands) {
      const source = `Text \\${command}*{first,  sec:part`;
      const context = findReferenceContext(source);
      assert.ok(context);
      assert.strictEqual(context.query, 'sec:part');
      assert.strictEqual(source.slice(context.queryStart), 'sec:part');
    }
    const closed = '\\ref{section}';
    const context = findReferenceContext(closed, closed.length - 1);
    assert.ok(context);
    assert.strictEqual(context.query, 'section');
    assert.strictEqual(findReferenceContext(closed), undefined);
    const longSource = 'x'.repeat(30000) + '\\ref{section';
    assert.strictEqual(findReferenceContext(longSource)?.queryStart, longSource.indexOf('section'));
  });

  test('uses shared lexical rules for partial reference contexts', () => {
    for (const source of [
      '% \\ref{ignored', String.raw`\\ref{ignored`, String.raw`\verb|\ref{ignored`,
      String.raw`\begin{verbatim}\ref{ignored`, String.raw`\refname{ignored`,
      String.raw`\ref{outer{inner`, String.raw`\ref{key % ignored`
    ]) {
      assert.strictEqual(findReferenceContext(source), undefined, source);
    }
    const source = '\\cref{first,% ignored ,\r\n sec:in% continue\r\ntro';
    const context = findReferenceContext(source);
    assert.ok(context);
    assert.strictEqual(context.query, 'sec:intro');
    assert.strictEqual(context.queryStart, source.indexOf('sec:in'));
    assert.strictEqual(findReferenceContext(String.raw`\ref{escaped\,comma`)?.query, String.raw`escaped\,comma`);
    assert.strictEqual(findReferenceContext('\\ref{key', -1), undefined);
    assert.strictEqual(findReferenceContext('\\ref{key', Infinity), undefined);
  });
});
