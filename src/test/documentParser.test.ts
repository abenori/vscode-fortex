import * as assert from 'assert';
import * as LaTeXParser from '../latex-parser';

function assertArgument(
  source: string,
  argument: LaTeXParser.DocumentArgument | undefined,
  form: LaTeXParser.DocumentArgument['form'],
  raw: string,
  complete = true
): asserts argument is LaTeXParser.DocumentArgument {
  assert.ok(argument);
  assert.strictEqual(argument.form, form);
  assert.strictEqual(argument.raw, raw);
  assert.strictEqual(argument.complete, complete);
  assert.strictEqual(source.slice(argument.contentStart, argument.contentEnd), raw);
  assert.strictEqual(argument.contentStart, argument.start + 1);
  assert.strictEqual(argument.end, argument.contentEnd + (complete ? 1 : 0));
}

suite('LaTeX document parser', () => {
  test('extracts all supported declarations in source order without deduplicating or splitting lists', () => {
    const source = String.raw`\documentclass{article}\usepackage{one, two}\RequirePackage{three}\input{chapter}\include{appendix}\bibliography{alpha, beta}\addbibresource{refs.bib}\input{chapter}`;
    const declarations = new LaTeXParser.DocumentParser(source).declarations;
    assert.deepStrictEqual(declarations.map(declaration => [declaration.kind, declaration.command]), [
      ['documentClass', 'documentclass'], ['package', 'usepackage'], ['package', 'RequirePackage'],
      ['include', 'input'], ['include', 'include'], ['bibliography', 'bibliography'],
      ['bibliography', 'addbibresource'], ['include', 'input']
    ]);
    assert.deepStrictEqual(declarations.map(declaration => declaration.argument?.raw), [
      'article', 'one, two', 'three', 'chapter', 'appendix', 'alpha, beta', 'refs.bib', 'chapter'
    ]);
    for (const declaration of declarations) {
      assert.strictEqual(declaration.complete, true);
      assert.strictEqual(declaration.starred, false);
      assert.strictEqual(source.slice(declaration.start, declaration.start + declaration.command.length + 1), `\\${declaration.command}`);
      assert.strictEqual(declaration.end, declaration.argument?.end);
    }
  });

  test('accepts an existing source scanner and retains the original source snapshot', () => {
    const source = '😀\\documentclass{article}\r\n\\input{chapter}';
    const scanner = new LaTeXParser.SourceScanner(source);
    const parser = new LaTeXParser.DocumentParser(scanner);
    assert.strictEqual(parser.source, source);
    assert.deepStrictEqual(parser.declarations, new LaTeXParser.DocumentParser(source).declarations);
    assert.strictEqual(scanner.source, source);
    assert.strictEqual(scanner.commands.length, 2);
  });

  test('reads nested options and postposed versions for classes and packages', () => {
    const source = String.raw`\documentclass[paper={a]b},feature=[x]]{cl{ass}}[2025/01/01]\usepackage[opt]{one,two}[v1]\RequirePackage[req]{three}[v2]\addbibresource[location=remote]{refs.bib}`;
    const declarations = new LaTeXParser.DocumentParser(source).declarations;
    assert.strictEqual(declarations.length, 4);
    assertArgument(source, declarations[0].options, 'bracketed', 'paper={a]b},feature=[x]');
    assertArgument(source, declarations[0].argument, 'braced', 'cl{ass}');
    assertArgument(source, declarations[0].version, 'bracketed', '2025/01/01');
    assertArgument(source, declarations[1].options, 'bracketed', 'opt');
    assertArgument(source, declarations[1].version, 'bracketed', 'v1');
    assertArgument(source, declarations[2].options, 'bracketed', 'req');
    assertArgument(source, declarations[2].version, 'bracketed', 'v2');
    assertArgument(source, declarations[3].options, 'bracketed', 'location=remote');
    assert.strictEqual(declarations[3].version, undefined);
    assert.ok(declarations.every(declaration => declaration.complete));
    for (const declaration of declarations.slice(0, 3)) {
      assert.strictEqual(declaration.end, declaration.version?.end);
    }
  });

  test('skips interargument comments and preserves comments inside argument text', () => {
    const source = '\\documentclass % before\r\n [a% ] ignored\r\n,b] % before main\r\n {ar% } ignored\r\nticle} % before version\r\n [2025% ] ignored\r\n/01]';
    const declarations = new LaTeXParser.DocumentParser(source).declarations;
    assert.strictEqual(declarations.length, 1);
    assertArgument(source, declarations[0].options, 'bracketed', 'a% ] ignored\r\n,b');
    assertArgument(source, declarations[0].argument, 'braced', 'ar% } ignored\r\nticle');
    assertArgument(source, declarations[0].version, 'bracketed', '2025% ] ignored\r\n/01');
    assert.strictEqual(declarations[0].complete, true);
    assert.strictEqual(declarations[0].end, source.length);
  });

  test('excludes comments, literals, escaped commands and different control words', () => {
    const source = [
      '% \\documentclass{commented}',
      String.raw`\verb|\input{inline}|`,
      String.raw`\lstinline{\include{inline}}`,
      String.raw`\begin{verbatim}\usepackage{literal}\end{verbatim}`,
      String.raw`\\input{escaped}\inputname{different}\requirepackage{different}`,
      String.raw`\input{visible}`
    ].join('\r\n');
    const declarations = new LaTeXParser.DocumentParser(source).declarations;
    assert.strictEqual(declarations.length, 1);
    assert.strictEqual(declarations[0].command, 'input');
    assertArgument(source, declarations[0].argument, 'braced', 'visible');
  });

  test('does not reinterpret commands nested inside complete declaration arguments', () => {
    const source = String.raw`\documentclass[opt={\input{hidden-option}}]{\input{hidden-main}}[\include{hidden-version}]\input{visible}`;
    const declarations = new LaTeXParser.DocumentParser(source).declarations;
    assert.deepStrictEqual(declarations.map(declaration => declaration.command), ['documentclass', 'input']);
    assertArgument(source, declarations[0].options, 'bracketed', String.raw`opt={\input{hidden-option}}`);
    assertArgument(source, declarations[0].argument, 'braced', String.raw`\input{hidden-main}`);
    assertArgument(source, declarations[0].version, 'bracketed', String.raw`\include{hidden-version}`);
    assertArgument(source, declarations[1].argument, 'braced', 'visible');
  });

  test('recovers after an unclosed main argument while protecting its completed options', () => {
    const source = '\\usepackage[opt={\\input{hidden}}]{unfinished\r\n\\input{recovered}';
    const declarations = new LaTeXParser.DocumentParser(source).declarations;
    assert.deepStrictEqual(declarations.map(declaration => declaration.command), ['usepackage', 'input']);
    assert.strictEqual(declarations[0].complete, false);
    assertArgument(source, declarations[0].options, 'bracketed', String.raw`opt={\input{hidden}}`);
    assertArgument(source, declarations[0].argument, 'braced', 'unfinished\r\n\\input{recovered}', false);
    assert.strictEqual(declarations[0].end, source.length);
    assertArgument(source, declarations[1].argument, 'braced', 'recovered');
    assert.strictEqual(declarations[1].complete, true);
  });

  test('records unclosed options and recovers later declarations', () => {
    const source = '\\documentclass[unfinished\n\\include{recovered}';
    const declarations = new LaTeXParser.DocumentParser(source).declarations;
    assert.deepStrictEqual(declarations.map(declaration => declaration.command), ['documentclass', 'include']);
    assertArgument(source, declarations[0].options, 'bracketed', 'unfinished\n\\include{recovered}', false);
    assert.strictEqual(declarations[0].argument, undefined);
    assert.strictEqual(declarations[0].complete, false);
    assertArgument(source, declarations[1].argument, 'braced', 'recovered');
  });

  test('records unclosed versions without losing a completed main argument or later declaration', () => {
    const source = '\\documentclass{article}[unfinished\r\\addbibresource{refs.bib}';
    const declarations = new LaTeXParser.DocumentParser(source).declarations;
    assert.deepStrictEqual(declarations.map(declaration => declaration.command), ['documentclass', 'addbibresource']);
    assertArgument(source, declarations[0].argument, 'braced', 'article');
    assertArgument(source, declarations[0].version, 'bracketed', 'unfinished\r\\addbibresource{refs.bib}', false);
    assert.strictEqual(declarations[0].complete, false);
    assertArgument(source, declarations[1].argument, 'braced', 'refs.bib');
  });

  test('retains declarations missing their required argument and ends at the last consumed token', () => {
    const source = String.raw`\documentclass[option] \usepackage \include \bibliography \addbibresource* [backend=biber] \input`;
    const declarations = new LaTeXParser.DocumentParser(source).declarations;
    assert.deepStrictEqual(declarations.map(declaration => declaration.command), [
      'documentclass', 'usepackage', 'include', 'bibliography', 'addbibresource', 'input'
    ]);
    assert.ok(declarations.every(declaration => !declaration.complete && declaration.argument === undefined));
    assert.strictEqual(declarations[0].end, declarations[0].options?.end);
    assert.strictEqual(declarations[4].end, declarations[4].options?.end);
    for (const index of [1, 2, 3, 5]) {
      const declaration = declarations[index];
      assert.strictEqual(declaration.end, declaration.start + declaration.command.length + 1);
    }
    assert.strictEqual(declarations[4].starred, true);
  });

  test('requires braces for input filenames and recovers the next declaration', () => {
    for (const ending of [' \\include{after}', '\t\\include{after}', '% ignored\r\n\\include{after}', '\\include{after}', '{suffix}\\include{after}', '}\\include{after}']) {
      const source = `\\input part${ending}`;
      const declarations = new LaTeXParser.DocumentParser(source).declarations;
      assert.deepStrictEqual(declarations.map(declaration => declaration.command), ['input', 'include'], ending);
      assert.strictEqual(declarations[0].argument, undefined);
      assert.strictEqual(declarations[0].end, '\\input'.length);
      assert.strictEqual(declarations[0].complete, false);
      assertArgument(source, declarations[1].argument, 'braced', 'after');
    }
  });

  test('leaves unbraced literal, quoted and macro filenames without an argument', () => {
    for (const source of [String.raw`\input chapter.tex`, String.raw`\input "some file.tex"`, String.raw`\input \directory/x.tex`]) {
      const declarations = new LaTeXParser.DocumentParser(source).declarations;
      assert.strictEqual(declarations.length, 1);
      assert.strictEqual(declarations[0].argument, undefined);
      assert.strictEqual(declarations[0].complete, false);
      assert.strictEqual(declarations[0].end, '\\input'.length);
    }
  });

  test('preserves quoted filenames inside braces for filename interpretation', () => {
    const source = String.raw`\input{"some file.tex"}`;
    const declaration = new LaTeXParser.DocumentParser(source).declarations[0];
    assertArgument(source, declaration.argument, 'braced', '"some file.tex"');
    assert.strictEqual(declaration.complete, true);
    assert.strictEqual(declaration.end, source.length);
  });

  test('retains an unfinished braced input while recovering later declarations', () => {
    const source = '\\input{unfinished\n\\include{recovered}';
    const declarations = new LaTeXParser.DocumentParser(source).declarations;
    assert.deepStrictEqual(declarations.map(declaration => declaration.command), ['input', 'include']);
    assertArgument(source, declarations[0].argument, 'braced', 'unfinished\n\\include{recovered}', false);
    assert.strictEqual(declarations[0].complete, false);
    assert.strictEqual(declarations[0].end, source.length);
    assertArgument(source, declarations[1].argument, 'braced', 'recovered');
    assert.strictEqual(declarations[1].complete, true);
  });

  test('keeps dynamic paths, extensions, comma lists and URLs exactly as written', () => {
    const source = String.raw`\input{\directory/part.tex}\include{../part}\bibliography{a, b.bib}\addbibresource{https://example.test/refs.bib}`;
    const declarations = new LaTeXParser.DocumentParser(source).declarations;
    assert.strictEqual(declarations.length, 4);
    const values = [String.raw`\directory/part.tex`, '../part', 'a, b.bib', 'https://example.test/refs.bib'];
    declarations.forEach((declaration, index) => assertArgument(source, declaration.argument, 'braced', values[index]));
  });

  test('recognizes addbibresource stars and requires arguments immediately after other commands', () => {
    const source = String.raw`\addbibresource* [opt]{refs.bib}\input*{chapter}\include*{chapter}\documentclass*{article}\usepackage*{pkg}\RequirePackage*{pkg}\bibliography*{refs}`;
    const declarations = new LaTeXParser.DocumentParser(source).declarations;
    assert.strictEqual(declarations.length, 7);
    assert.strictEqual(declarations[0].starred, true);
    assert.strictEqual(declarations[0].complete, true);
    assertArgument(source, declarations[0].options, 'bracketed', 'opt');
    assertArgument(source, declarations[0].argument, 'braced', 'refs.bib');
    for (const declaration of declarations.slice(1)) {
      assert.strictEqual(declaration.starred, false);
      assert.strictEqual(declaration.argument, undefined);
      assert.strictEqual(declaration.complete, false);
      assert.strictEqual(declaration.end, declaration.start + declaration.command.length + 1);
    }
  });

  test('treats empty groups as syntactically complete without validating their contents', () => {
    const source = String.raw`\documentclass{}\usepackage[]{}\RequirePackage{}\input{}\include{}\bibliography{}\addbibresource*[]{}`;
    const declarations = new LaTeXParser.DocumentParser(source).declarations;
    assert.strictEqual(declarations.length, 7);
    for (const declaration of declarations) {
      assertArgument(source, declaration.argument, 'braced', '');
      assert.strictEqual(declaration.complete, true);
    }
    assertArgument(source, declarations[1].options, 'bracketed', '');
    assertArgument(source, declarations[6].options, 'bracketed', '');
  });

  test('preserves LF, CRLF, CR and UTF-16 offsets in declarations and raw argument text', () => {
    for (const newline of ['\n', '\r\n', '\r']) {
      const source = `😀% \\input{commented}${newline}\\documentclass${newline}[😀a]${newline}{日本語${newline}😀}${newline}[ver]${newline}\\input{chapter}`;
      const declarations = new LaTeXParser.DocumentParser(source).declarations;
      assert.strictEqual(declarations.length, 2);
      assert.strictEqual(declarations[0].start, source.indexOf('\\documentclass'));
      assertArgument(source, declarations[0].options, 'bracketed', '😀a');
      assert.strictEqual(declarations[0].options.start, source.indexOf('[😀a]'));
      assertArgument(source, declarations[0].argument, 'braced', `日本語${newline}😀`);
      assert.strictEqual(declarations[0].argument.start, source.indexOf('{日本語'));
      assert.strictEqual(declarations[0].argument.end, source.indexOf('😀}', source.indexOf('{日本語')) + 3);
      assertArgument(source, declarations[0].version, 'bracketed', 'ver');
      assert.strictEqual(declarations[0].end, source.indexOf('[ver]') + '[ver]'.length);
      assert.strictEqual(declarations[1].start, source.lastIndexOf('\\input'));
      assertArgument(source, declarations[1].argument, 'braced', 'chapter');
      assert.strictEqual(declarations[1].end, source.length);
    }
  });

  test('leaves macro definition bodies visible for callers to interpret', () => {
    const source = String.raw`\newcommand{\load}{\input{defined}}\newenvironment{custom}{\usepackage{defined}}{}\input{actual}`;
    const declarations = new LaTeXParser.DocumentParser(source).declarations;
    assert.deepStrictEqual(declarations.map(declaration => [declaration.command, declaration.argument?.raw]), [
      ['input', 'defined'], ['usepackage', 'defined'], ['input', 'actual']
    ]);
  });
});
