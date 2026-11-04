import * as assert from 'assert';
import * as LaTeXParser from '../latex-parser';
import { findCommandContext } from '../completion/command/CommandParser';

suite('LaTeX definition parser', () => {
  test('extracts all classic command declarations, stars, counts and nested defaults', () => {
    const source = String.raw`\newcommand*{\first}[2][{a]b}]{#1#2}\renewcommand\second[1]{#1}\providecommand{\third}{}\DeclareRobustCommand{\fourth}[0]{}\DeclareMathOperator*{\operator}{lim sup}`;
    const definitions = new LaTeXParser.DefinitionParser(source).definitions;
    assert.deepStrictEqual(definitions.map(definition => [definition.command, definition.name, definition.argumentCount, definition.optionalFirstArgument]), [
      ['newcommand', 'first', 2, true], ['renewcommand', 'second', 1, false],
      ['providecommand', 'third', 0, false], ['DeclareRobustCommand', 'fourth', 0, false],
      ['DeclareMathOperator', 'operator', 0, false]
    ]);
    assert.ok(definitions.every(definition => definition.complete && definition.kind === 'command'));
    assert.deepStrictEqual(definitions.map(definition => definition.bodyRanges.map(range => source.slice(range.start, range.end))), [
      ['#1#2'], ['#1'], [''], [''], ['lim sup']
    ]);
    assert.strictEqual(definitions.at(-1)?.end, source.length);
  });

  test('extracts ordinary and expandable xparse declarations without guessing their signatures', () => {
    const commands = [
      'NewDocumentCommand', 'RenewDocumentCommand', 'ProvideDocumentCommand', 'DeclareDocumentCommand',
      'NewExpandableDocumentCommand', 'RenewExpandableDocumentCommand',
      'ProvideExpandableDocumentCommand', 'DeclareExpandableDocumentCommand'
    ];
    const source = commands.map((command, index) => `\\${command}{\\macro${'x'.repeat(index)}}{>{\\processor} m O{{nested}}}{body}`).join('\r\n');
    const definitions = new LaTeXParser.DefinitionParser(source).definitions;
    assert.deepStrictEqual(definitions.map(definition => definition.command), commands);
    assert.ok(definitions.every(definition => definition.complete && definition.kind === 'command'));
    assert.ok(definitions.every(definition => definition.argumentCount === undefined && definition.optionalFirstArgument === undefined));
    assert.ok(definitions.every(definition => definition.bodyRanges.length === 1));
  });

  test('extracts classic and xparse environments with separate opening and closing bodies', () => {
    const source = String.raw`\newenvironment*{first}[2][default]{open #1}{close #2}\renewenvironment{second}{}{}\provideenvironment{third}{}{}\NewDocumentEnvironment{fourth}{m}{open}{close}\RenewDocumentEnvironment{fifth}{}{}{}\ProvideDocumentEnvironment{sixth}{}{}{}\DeclareDocumentEnvironment{seventh}{}{}{}`;
    const definitions = new LaTeXParser.DefinitionParser(source).definitions;
    assert.deepStrictEqual(definitions.map(definition => definition.name), ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh']);
    assert.ok(definitions.every(definition => definition.kind === 'environment' && definition.complete && definition.bodyRanges.length === 2));
    assert.deepStrictEqual(definitions[0].bodyRanges.map(range => source.slice(range.start, range.end)), ['open #1', 'close #2']);
    assert.strictEqual(definitions[0].argumentCount, 2);
    assert.strictEqual(definitions[0].optionalFirstArgument, true);
  });

  test('extracts theorem titles and both counter forms without treating the title as a definition body', () => {
    const source = String.raw`\newtheorem{thm}{Theorem}[section]\newtheorem{lem}[thm]{A \textbf{lemma}}\newtheorem*{remark}{Remark}`;
    const definitions = new LaTeXParser.DefinitionParser(source).definitions;
    assert.deepStrictEqual(definitions.map(definition => [definition.kind, definition.name, definition.title]), [
      ['theorem', 'thm', 'Theorem'], ['theorem', 'lem', String.raw`A \textbf{lemma}`], ['theorem', 'remark', 'Remark']
    ]);
    assert.ok(definitions.every(definition => definition.complete && definition.bodyRanges.length === 0));
    assert.strictEqual(definitions[0].end, source.indexOf('\\newtheorem{lem}'));
    assert.strictEqual(definitions[1].end, source.indexOf('\\newtheorem*'));
  });

  test('extracts TeX primitive definitions and parameter counts while skipping control-sequence delimiters', () => {
    const source = String.raw`\def\first#1#2\stop{#2#1}\gdef\second{constant}\edef\third#1,{#1}\xdef\fourth#1#2#3{#3}`;
    const definitions = new LaTeXParser.DefinitionParser(source).definitions;
    assert.deepStrictEqual(definitions.map(definition => [definition.command, definition.name, definition.argumentCount]), [
      ['def', 'first', 2], ['gdef', 'second', 0], ['edef', 'third', 1], ['xdef', 'fourth', 3]
    ]);
    assert.ok(definitions.every(definition => definition.complete && definition.bodyRanges.length === 1));
  });

  test('ignores comments, literal bodies, escaped declarations and different command names', () => {
    const source = [
      '% \\newcommand{\\commented}{}',
      String.raw`\verb|\newcommand{\inline}{}|`,
      String.raw`\lstinline{\newtheorem{inline}{Inline}}`,
      String.raw`\begin{verbatim}\def\literal{}\end{verbatim}`,
      String.raw`\\newcommand{\escaped}{}\newcommandname{\different}{}`,
      String.raw`\newcommand{\actual}{}`
    ].join('\r\n');
    assert.deepStrictEqual(new LaTeXParser.DefinitionParser(source).definitions.map(definition => definition.name), ['actual']);
  });

  test('retains raw body/title text and removes comment continuations only when interpreting names and counts', () => {
    const source = '\\newcommand % between\r\n { % name\r\n \\first % trailing\r\n } [ % count\r\n 2 ] [a% default\r\nb] {raw% body\r\ntext}\r\n\\newtheorem{pro% name\r\nposition}{Raw% title\r\nTitle}';
    const definitions = new LaTeXParser.DefinitionParser(source).definitions;
    assert.deepStrictEqual(definitions.map(definition => definition.name), ['first', 'proposition']);
    assert.strictEqual(definitions[0].argumentCount, 2);
    assert.strictEqual(definitions[0].optionalFirstArgument, true);
    assert.strictEqual(source.slice(definitions[0].bodyRanges[0].start, definitions[0].bodyRanges[0].end), 'raw% body\r\ntext');
    assert.strictEqual(definitions[1].title, 'Raw% title\r\nTitle');
  });

  test('does not return definitions inside completed names, options, signatures, titles or bodies', () => {
    const source = String.raw`\newcommand{\outer}[1][\newcommand{\default}{}]{\newcommand{\nested}{}\newtheorem{hidden}{Hidden}}\NewDocumentCommand{\xparse}{O{\newcommand{\specification}{}}}{\def\inner{}}\newtheorem{thm}{\newcommand{\title}{}}\newcommand{\actual}{}`;
    assert.deepStrictEqual(new LaTeXParser.DefinitionParser(source).definitions.map(definition => definition.name), ['outer', 'xparse', 'thm', 'actual']);
  });

  test('recovers after unclosed bodies while returning only closed body ranges', () => {
    const source = '\\newenvironment{unfinished}{\\newcommand{\\hidden}{}}{unclosed\r\n\\newcommand{\\recovered}{body}';
    const definitions = new LaTeXParser.DefinitionParser(source).definitions;
    assert.deepStrictEqual(definitions.map(definition => definition.name), ['unfinished', 'recovered']);
    assert.strictEqual(definitions[0].complete, false);
    assert.strictEqual(definitions[0].end, source.length);
    assert.deepStrictEqual(definitions[0].bodyRanges.map(range => source.slice(range.start, range.end)), [String.raw`\newcommand{\hidden}{}`]);
    assert.strictEqual(definitions[1].complete, true);
  });

  test('retains named incomplete declarations and recovers after unclosed options or primitive parameters', () => {
    const source = '\\newcommand{\\first}[unfinished\r\n\\def\\second#1\r\n\\newcommand{\\third}';
    const definitions = new LaTeXParser.DefinitionParser(source).definitions;
    assert.deepStrictEqual(definitions.map(definition => definition.name), ['first', 'second', 'third']);
    assert.ok(definitions.every(definition => !definition.complete && definition.bodyRanges.length === 0));
  });

  test('reports the completed prefix before missing bodies and unclosed trailing arguments', () => {
    for (const [prefix, remainder] of [
      [String.raw`\newcommand{\first}[1][\section{Hidden}]`, String.raw`\section{Recovered}`],
      [String.raw`\NewDocumentCommand{\first}{O{\label{hidden}}}`, String.raw`\section{Recovered}`],
      [String.raw`\newtheorem{first}{\section{Hidden}}`, '[unclosed\r\n\\section{Recovered}']
    ]) {
      const source = prefix + remainder;
      const definition = new LaTeXParser.DefinitionParser(source).definitions[0];
      assert.ok(definition);
      assert.strictEqual(definition.complete, false);
      assert.strictEqual(definition.consumedEnd, prefix.length);
      assert.deepStrictEqual(definition.bodyRanges, []);
    }
    const completeSource = String.raw`\newcommand{\complete}{body}`;
    const complete = new LaTeXParser.DefinitionParser(completeSource).definitions[0];
    assert.strictEqual(complete.consumedEnd, complete.end);
    assert.strictEqual(complete.consumedEnd, completeSource.length);
  });

  test('retains an unfinished command-name group without consuming later declarations', () => {
    const source = '\\newcommand{\\unfinished\r\n\\newcommand{\\actual}{}';
    const definitions = new LaTeXParser.DefinitionParser(source).definitions;
    assert.deepStrictEqual(definitions.map(definition => definition.name), ['unfinished', 'actual']);
    assert.strictEqual(definitions[0].complete, false);
    assert.strictEqual(definitions[0].consumedEnd, '\\newcommand'.length);
    assert.strictEqual(definitions[1].complete, true);
  });

  test('rejects dynamic names and invalid command-name groups without inventing snippets for invalid counts', () => {
    const source = String.raw`\newcommand{\first extra}{}\newenvironment{\dynamic}{}{}\newtheorem{nested{name}}{Title}\newcommand{\actual}[99999999999999999999]{body}`;
    const definitions = new LaTeXParser.DefinitionParser(source).definitions;
    assert.deepStrictEqual(definitions.map(definition => definition.name), ['actual']);
    assert.strictEqual(definitions[0].argumentCount, undefined);
    assert.strictEqual(definitions[0].complete, true);
  });

  test('reports consumed syntax for invalid names while suppressing definitions nested in their closed arguments', () => {
    for (const invalid of [
      String.raw`\newcommand{garbage\section{Fake}}{\newcommand{\hidden}{}}`,
      String.raw`\newcommand{garbage}[1][\newcommand{\default}{}]{\newcommand{\hidden}{}}`,
      String.raw`\NewDocumentCommand{garbage}{O{\newcommand{\specification}{}}}{\newcommand{\hidden}{}}`,
      String.raw`\newenvironment{\dynamic}{\newcommand{\opening}{}}{\newcommand{\closing}{}}`,
      String.raw`\newtheorem{bad{name}}{\newcommand{\title}{}}[section]`
    ]) {
      const parser = new LaTeXParser.DefinitionParser(invalid + String.raw`\newcommand{\actual}{}`);
      assert.deepStrictEqual(parser.definitions.map(definition => definition.name), ['actual']);
      assert.deepStrictEqual(parser.consumedRanges[0], { start: 0, end: invalid.length });
      assert.strictEqual(parser.consumedRanges.length, 2);
    }
  });

  test('does not consume later declarations when a primitive name is missing or an invalid name group is unfinished', () => {
    for (const [prefix, consumedEnd] of [
      [String.raw`\def garbage `, '\\def'.length],
      [String.raw`\newcommand{garbage `, '\\newcommand'.length]
    ] as const) {
      const parser = new LaTeXParser.DefinitionParser(prefix + String.raw`\newcommand{\actual}{}`);
      assert.deepStrictEqual(parser.definitions.map(definition => definition.name), ['actual']);
      assert.deepStrictEqual(parser.consumedRanges[0], { start: 0, end: consumedEnd });
    }
  });

  test('retains source snapshots and original UTF-16 name/body ranges across all line endings', () => {
    for (const newline of ['\n', '\r\n', '\r']) {
      const source = `😀${newline}\\newcommand{ \\first }[1]{日本語${newline}😀#1}${newline}\\newenvironment{ 日本語 }{}{}`;
      const scanner = new LaTeXParser.SourceScanner(source);
      const parser = new LaTeXParser.DefinitionParser(scanner);
      assert.strictEqual(parser.source, source);
      assert.deepStrictEqual(parser.definitions, new LaTeXParser.DefinitionParser(source).definitions);
      for (const definition of parser.definitions) {
        assert.strictEqual(source.slice(definition.nameStart, definition.nameEnd), definition.name);
        assert.strictEqual(source.slice(definition.start, definition.start + definition.command.length + 1), `\\${definition.command}`);
      }
      assert.strictEqual(source.slice(parser.definitions[0].bodyRanges[0].start, parser.definitions[0].bodyRanges[0].end), `日本語${newline}😀#1`);
      assert.strictEqual(parser.definitions[1].end, source.length);
    }
  });

  test('keeps control-symbol names available to parser callers', () => {
    const source = String.raw`\newcommand{\?}{question}\def\!{bang}`;
    const definitions = new LaTeXParser.DefinitionParser(source).definitions;
    assert.deepStrictEqual(definitions.map(definition => definition.name), ['?', '!']);
  });

  test('retains repeated declarations and their signatures in source order across line endings', () => {
    for (const newline of ['\n', '\r\n', '\r']) {
      const source = [
        String.raw`\NewDocumentCommand{\first}{m}{}`,
        String.raw`\renewcommand{\first}[2][default]{#1#2}`,
        String.raw`\DeclareMathOperator{\operator}{op}`,
        String.raw`\def\primitive#1{#1}`,
        String.raw`\newcommand{\outer}{\newcommand{\hidden}{}}`,
        String.raw`\verb|\newcommand{\literal}{}|`
      ].join(newline);
      const definitions = new LaTeXParser.DefinitionParser(source).definitions;
      assert.deepStrictEqual(definitions.map(definition => definition.name), ['first', 'first', 'operator', 'primitive', 'outer']);
      assert.strictEqual(definitions[0].argumentCount, undefined);
      assert.strictEqual(definitions[1].argumentCount, 2);
      assert.strictEqual(definitions[1].optionalFirstArgument, true);
      assert.strictEqual(definitions[3].argumentCount, 1);
      assert.strictEqual(definitions[3].optionalFirstArgument, false);
      assert.strictEqual(definitions[1].start, source.indexOf('\\renewcommand'));
      assert.strictEqual(definitions[3].start, source.indexOf('\\def'));
    }
  });

  test('finds command fragments on the current line with shared comment and literal handling', () => {
    assert.deepStrictEqual(findCommandContext('Text \\sec*', 100), { query: 'sec*', start: 105 });
    assert.deepStrictEqual(findCommandContext('\\'), { query: '', start: 0 });
    assert.deepStrictEqual(findCommandContext('\\% \\sec'), { query: 'sec', start: 3 });
    assert.strictEqual(findCommandContext('% \\sec'), undefined);
    assert.strictEqual(findCommandContext('\\\\'), undefined);
    assert.strictEqual(findCommandContext(String.raw`\verb|\sec`), undefined);
    assert.strictEqual(findCommandContext(String.raw`\begin{verbatim}\sec`), undefined);
    assert.deepStrictEqual(findCommandContext(String.raw`\verb|x| \sec`), { query: 'sec', start: 9 });
  });
});
