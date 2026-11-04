import * as assert from 'assert';
import * as LaTeXParser from '../latex-parser';
import { collectEnvironmentNames, findEnvironmentCompletionContext } from '../completion/environment/EnvironmentParser';

suite('Shared LaTeX environment parser', () => {
  test('matches nested named environments and all mathematical delimiter forms', () => {
    const source = String.raw`\begin{outer}\begin{inner}x\end{inner}\[x\]\(y\)$z$ $$w$$\end{outer}`;
    const parser = new LaTeXParser.EnvironmentParser(source);
    assert.deepStrictEqual(parser.pairs.map(pair => [pair.begin.style, pair.begin.name]), [
      ['named', 'inner'], ['display', '\\['], ['inline', '\\('], ['dollar', '$'],
      ['doubleDollar', '$$'], ['named', 'outer']
    ]);
    assert.deepStrictEqual(parser.unclosed, []);
    assert.strictEqual(parser.tokens.length, 12);
    for (const pair of parser.pairs) {
      assert.strictEqual(pair.begin.kind, 'begin');
      assert.strictEqual(pair.end.kind, 'end');
      assert.strictEqual(pair.begin.name, pair.end.name);
      assert.strictEqual(pair.begin.style, pair.end.style);
    }
  });

  test('retains original UTF-16 name and delimiter offsets with CRLF and comments', () => {
    const source = '😀\r\n\\begin % ignored {\r\n { the% ignored }\r\norem }x\\end{theorem}';
    const scanner = new LaTeXParser.SourceScanner(source);
    const parser = new LaTeXParser.EnvironmentParser(scanner);
    assert.strictEqual(parser.source, source);
    assert.deepStrictEqual(parser.tokens, new LaTeXParser.EnvironmentParser(source).tokens);
    assert.strictEqual(parser.pairs.length, 1);
    const begin = parser.pairs[0].begin;
    assert.strictEqual(begin.name, 'theorem');
    assert.strictEqual(begin.start, source.indexOf('\\begin'));
    assert.strictEqual(source.slice(begin.nameStart, begin.nameEnd), 'the% ignored }\r\norem');
    assert.strictEqual(source.slice(begin.start, begin.end), '\\begin % ignored {\r\n { the% ignored }\r\norem }');
  });

  test('excludes comments, escaped commands, literal contents and escaped dollar signs', () => {
    const source = [
      String.raw`% \begin{commented} $$`,
      String.raw`\verb|\begin{inline} $ \[|`,
      String.raw`\lstinline{\end{inline} $$}`,
      String.raw`\\begin{escaped} \\[ \$`,
      String.raw`\begin{verbatim}\begin{hidden} $ \(\end{verbatim}`,
      String.raw`\begin{visible}x\end{visible}`
    ].join('\r\n');
    const parser = new LaTeXParser.EnvironmentParser(source);
    assert.deepStrictEqual(parser.tokens.map(token => token.name), ['verbatim', 'verbatim', 'visible', 'visible']);
    assert.deepStrictEqual(parser.pairs.map(pair => pair.begin.name), ['verbatim', 'visible']);
  });

  test('does not reinterpret nested names, macros or unfinished names as valid environments', () => {
    const source = String.raw`\begin{a b}\end{a b}\begin{\dynamic}\end{\dynamic}\begin{nested{a}}\end{nested{a}}`;
    assert.deepStrictEqual(new LaTeXParser.EnvironmentParser(source).tokens, []);
    const unfinished = '\\begin{unfinished\r\n\\begin{valid}x\\end{valid}';
    assert.deepStrictEqual(new LaTeXParser.EnvironmentParser(unfinished).pairs.map(pair => pair.begin.name), ['valid']);
  });

  test('keeps mismatched closings unpaired without discarding inner openings', () => {
    const source = String.raw`\begin{a}\begin{b}\end{a}\end{b}\end{a}\begin{c}\end{missing}`;
    const parser = new LaTeXParser.EnvironmentParser(source);
    assert.deepStrictEqual(parser.pairs.map(pair => pair.begin.name), ['b', 'a']);
    assert.deepStrictEqual(parser.unclosed.map(token => token.name), ['c']);
    assert.strictEqual(parser.pairAt(source.indexOf('\\end{a}')), undefined);
  });

  test('queries complete tokens and globally unclosed openings at valid caret offsets', () => {
    const source = String.raw`\begin{outer}\begin{inner}x\end{inner} text \[`;
    const parser = new LaTeXParser.EnvironmentParser(source);
    const inner = parser.pairs[0];
    assert.strictEqual(parser.tokenAt(inner.begin.nameStart), inner.begin);
    assert.strictEqual(parser.tokenAt(inner.end.end), inner.end);
    assert.strictEqual(parser.pairAt(inner.end.nameStart), inner);
    assert.strictEqual(parser.pairAt(source.indexOf(' text ') + 2), undefined);
    assert.strictEqual(parser.unclosedAt(inner.begin.start)?.name, 'outer');
    assert.strictEqual(parser.unclosedAt(source.length)?.name, '\\[');
    assert.strictEqual(parser.unclosedAt(source.length - 1)?.name, 'outer');
    for (const offset of [-1, source.length + 1, NaN, 1.5]) {
      assert.strictEqual(parser.tokenAt(offset), undefined);
      assert.strictEqual(parser.pairAt(offset), undefined);
      assert.strictEqual(parser.unclosedAt(offset), undefined);
    }
    assert.strictEqual(new LaTeXParser.EnvironmentParser('\\begin{later}x\\end{later}').unclosedAt(14), undefined);
  });

  test('uses exact mathematical delimiter styles and records unclosed math', () => {
    const source = String.raw`\[a\)\] \(b\) $c$ $$d$$ $unfinished`;
    const parser = new LaTeXParser.EnvironmentParser(source);
    assert.deepStrictEqual(parser.pairs.map(pair => pair.begin.style), ['display', 'inline', 'dollar', 'doubleDollar']);
    assert.deepStrictEqual(parser.unclosed.map(token => token.style), ['dollar']);
    assert.strictEqual(parser.pairAt(source.indexOf('\\)')), undefined);
    assert.strictEqual(parser.unclosedAt(source.length)?.name, '$');
  });

  test('keeps adjacent inline formulas separate without inventing display delimiters', () => {
    const parser = new LaTeXParser.EnvironmentParser('$x$$y$ $$z$$');
    assert.deepStrictEqual(parser.pairs.map(pair => pair.begin.style), ['dollar', 'dollar', 'doubleDollar']);
    assert.deepStrictEqual(parser.tokens.map(token => [token.kind, token.style]), [
      ['begin', 'dollar'], ['end', 'dollar'], ['begin', 'dollar'], ['end', 'dollar'],
      ['begin', 'doubleDollar'], ['end', 'doubleDollar']
    ]);
    assert.deepStrictEqual(parser.unclosed, []);
    assert.strictEqual(parser.tokenAt(3), parser.tokens[2]);
    assert.strictEqual(parser.pairAt(3), parser.pairs[1]);
  });

  test('can match selected styles without unfinished inline math blocking environment edits', () => {
    const source = String.raw`\begin{a}$ unfinished \[x\]\end{a}`;
    const parser = new LaTeXParser.EnvironmentParser(source, [], ['named', 'display']);
    assert.deepStrictEqual(parser.pairs.map(pair => pair.begin.name), ['\\[', 'a']);
    assert.deepStrictEqual(parser.unclosed, []);
    assert.ok(parser.tokens.every(token => token.style === 'named' || token.style === 'display'));
    assert.deepStrictEqual(new LaTeXParser.EnvironmentParser(source, [], []).tokens, []);
    assert.deepStrictEqual(new LaTeXParser.EnvironmentParser(source).unclosed.map(token => token.name), ['a', '$']);
  });

  test('allows callers to exclude ranges before matching mathematical delimiters', () => {
    const source = String.raw`\newcommand{\bad}{$}\section{other $} $$visible$$\begin{a}\end{a}`;
    const start = source.indexOf('$$visible');
    const parser = new LaTeXParser.EnvironmentParser(source, [
      { start: 0, end: start - 3 }, { start: start - 5, end: start },
      { start: -1, end: 5 }, { start: 9, end: 2 }, { start: source.length, end: source.length + 1 }
    ]);
    assert.deepStrictEqual(parser.pairs.map(pair => pair.begin.name), ['$$', 'a']);
    assert.deepStrictEqual(parser.unclosed, []);
    assert.strictEqual(parser.tokens[0].start, start);
    // Without exclusions, complete macro definitions retain ordinary source meaning.
    assert.ok(new LaTeXParser.EnvironmentParser(source).tokens.some(token => token.start < start));
  });

  test('keeps named completion contexts out of comments, literals and escaped commands', () => {
    for (const source of [String.raw`% \begin{ite`, String.raw`\verb|\begin{ite|`, String.raw`\\begin{ite`]) {
      assert.strictEqual(findEnvironmentCompletionContext(source, source.length), undefined);
    }
    const source = '\\begin % ignored\r\n {ite}';
    const context = findEnvironmentCompletionContext(source, source.length - 1);
    assert.ok(context);
    assert.deepStrictEqual(context, { style: 'named', query: 'ite', queryStart: source.indexOf('ite'), replaceEnd: source.length });
    assert.strictEqual(findEnvironmentCompletionContext('\\begin{it\r\ne}', 11), undefined);
    assert.strictEqual(findEnvironmentCompletionContext('\\begin{ite', 10)?.query, 'ite');
    assert.strictEqual(findEnvironmentCompletionContext(String.raw`\verb|\[|`, 8), undefined);
  });

  test('collects static local environment declarations using the shared definition parser', () => {
    const source = [
      String.raw`\newenvironment{localproof}{}{}`,
      String.raw`\NewDocumentEnvironment{localx}{m}{}{}`,
      String.raw`\newtheorem*{localtheorem}{Theorem}`,
      String.raw`\renewenvironment{unfinished}`,
      String.raw`\begin{usedhere}x\end{usedhere}`,
      String.raw`% \newenvironment{hiddencomment}{}{}`,
      String.raw`\verb|\newtheorem{hiddenliteral}{Hidden}|`
    ].join('\r\n');
    const names = collectEnvironmentNames(source);
    for (const name of ['localproof', 'localx', 'localtheorem', 'unfinished', 'usedhere', 'itemize']) {
      assert.ok(names.includes(name));
    }
    assert.ok(!names.includes('hiddencomment'));
    assert.ok(!names.includes('hiddenliteral'));
    assert.strictEqual(names.filter(name => name === 'itemize').length, 1);
  });
});
