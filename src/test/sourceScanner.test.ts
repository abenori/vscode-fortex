import * as assert from 'assert';
import * as LaTeXParser from '../latex-parser';

suite('LaTeX source scanner', () => {
  test('removes only comments and their line endings from requested source ranges', () => {
    for (const newline of ['\n', '\r\n', '\r']) {
      const source = `{ar% ignored \\macro${newline}ticle} \\verb|% literal| \\% kept${newline}last`;
      const scanner = new LaTeXParser.SourceScanner(source);
      assert.strictEqual(scanner.textWithoutComments(), `{article} \\verb|% literal| \\% kept${newline}last`);
      assert.strictEqual(scanner.textWithoutComments(1, source.indexOf('}')), 'article');
      assert.strictEqual(scanner.textWithoutComments(0, 0), '');
      for (const [start, end] of [[-1, 0], [1, 0], [0, source.length + 1], [NaN, 1], [0, 0.5]]) {
        assert.strictEqual(scanner.textWithoutComments(start, end), undefined);
      }
    }
  });

  test('skips whitespace and comments while stopping at literal text', () => {
    const source = ' % comment\r\n \\verb| | {next}';
    const scanner = new LaTeXParser.SourceScanner(source);
    assert.strictEqual(scanner.skipTrivia(0), source.indexOf('\\verb'));
    const literalSpace = source.indexOf('|') + 1;
    assert.strictEqual(scanner.skipTrivia(literalSpace), literalSpace);
    assert.strictEqual(scanner.skipTrivia(source.indexOf('{next}')), source.indexOf('{next}'));
    assert.strictEqual(scanner.skipTrivia(source.length), source.length);
    for (const offset of [-1, 0.5, source.length + 1, NaN, Infinity]) {
      assert.strictEqual(scanner.skipTrivia(offset), undefined);
    }
  });

  test('reads control words, symbols and stars with original UTF-16 offsets', () => {
    const source = String.raw`😀\section*{題名}\foo@bar\%\😀` + '\\';
    const scanner = new LaTeXParser.SourceScanner(source);
    assert.deepStrictEqual(scanner.commands.map(command => command.name), ['section', 'foo@bar', '%', '😀', '']);
    assert.strictEqual(scanner.commands[0].start, 2);
    for (const command of scanner.commands) {
      assert.strictEqual(source.slice(command.start, command.end), `\\${command.name}`);
    }
    assert.strictEqual(scanner.maskedSource, source);
  });

  test('checks backslash parity and rejects invalid command offsets', () => {
    const source = String.raw`\\\section\%`;
    assert.strictEqual(LaTeXParser.isEscaped(source, 0), false);
    assert.strictEqual(LaTeXParser.isEscaped(source, 1), true);
    assert.strictEqual(LaTeXParser.isEscaped(source, 2), false);
    assert.strictEqual(LaTeXParser.readCommand(source, 1), undefined);
    assert.strictEqual(LaTeXParser.readCommand(source, 2)?.name, 'section');
    for (const offset of [-1, 0.5, source.length, NaN, Infinity]) {
      assert.strictEqual(LaTeXParser.readCommand(source, offset), undefined);
    }
    assert.strictEqual(LaTeXParser.readCommand('plain', 0), undefined);
    assert.strictEqual(LaTeXParser.isEscaped(source, -1), false);
    assert.strictEqual(LaTeXParser.isEscaped('\\', 1), true);
    assert.deepStrictEqual(new LaTeXParser.SourceScanner(source).commands.map(command => command.name), ['\\', 'section', '%']);
  });

  test('masks comments while retaining emoji widths, CRLF and escaped percent signs', () => {
    const source = '😀% fake \\section{😀}\r\n\\% real \\section{Visible}\r\n\\\\% comment\\label{x}';
    const scanner = new LaTeXParser.SourceScanner(source);
    assert.strictEqual(scanner.maskedSource.length, source.length);
    assert.deepStrictEqual(scanner.commands.map(command => command.name), ['%', 'section', '\\']);
    assert.deepStrictEqual(scanner.ignoredRanges.map(range => range.kind), ['comment', 'comment']);
    for (const range of scanner.ignoredRanges) {
      assert.strictEqual(source[range.start], '%');
      assert.strictEqual(range.contentStart, range.start + 1);
      assert.strictEqual(range.contentEnd, range.end);
      assert.strictEqual(scanner.maskedSource.slice(range.start, range.end), ' '.repeat(range.end - range.start));
    }
    for (let offset = 0; offset < source.length; offset++) {
      if (source[offset] === '\r' || source[offset] === '\n') {
        assert.strictEqual(scanner.maskedSource[offset], source[offset]);
      }
    }
  });

  test('masks supported inline literals including options, brace forms and literal percent', () => {
    const examples = [
      String.raw`\verb|\section{fake}%|`,
      String.raw`\verb*+\label{fake}+`,
      String.raw`\Verb[commandchars=\\\{\}]!\foo!`,
      String.raw`\lstinline[language={a]b}]|\foo%|`,
      String.raw`\lstinline{\foo{nested}%}`,
      String.raw`\mintinline[breaklines]{latex}|\foo%|`,
      String.raw`\mintinline{latex}{\foo{nested}%}`,
      String.raw`\verb😀\foo😀`
    ];
    for (const example of examples) {
      const source = `${example}\\section{real}`;
      const scanner = new LaTeXParser.SourceScanner(source);
      assert.strictEqual(scanner.ignoredRanges.length, 1, example);
      const range = scanner.ignoredRanges[0];
      assert.strictEqual(range.kind, 'inlineLiteral', example);
      assert.strictEqual(range.closed, true, example);
      assert.strictEqual(range.start, 0, example);
      assert.strictEqual(range.end, example.length, example);
      assert.ok(source.slice(range.contentStart, range.contentEnd).includes('\\'), example);
      assert.strictEqual(scanner.maskedSource, `${' '.repeat(example.length)}\\section{real}`, example);
      assert.deepStrictEqual(scanner.commands.map(command => command.name), [example.match(/^\\([A-Za-z]+)/)![1], 'section'], example);
    }
  });

  test('recovers incomplete delimiter and brace literals at a line ending or EOF', () => {
    for (const literal of [String.raw`\verb|\foo%`, String.raw`\lstinline{\foo{nested}`, String.raw`\mintinline{tex}|\foo`]) {
      for (const ending of ['', '\n\\section{after}', '\r\n\\section{after}']) {
        const scanner = new LaTeXParser.SourceScanner(literal + ending);
        assert.strictEqual(scanner.ignoredRanges.length, 1);
        assert.strictEqual(scanner.ignoredRanges[0].closed, false);
        assert.strictEqual(scanner.ignoredRanges[0].end, literal.length);
        assert.strictEqual(scanner.ignoredRanges[0].contentEnd, literal.length);
        assert.deepStrictEqual(scanner.commands.map(command => command.name), [literal.match(/^\\([A-Za-z]+)/)![1], ...(ending ? ['section'] : [])]);
      }
    }
  });

  test('keeps literal environment boundaries and masks only their bodies', () => {
    for (const name of ['verbatim', 'verbatim*', 'Verbatim', 'BVerbatim', 'LVerbatim', 'SaveVerbatim', 'VerbatimOut', 'lstlisting', 'minted', 'comment', 'filecontents', 'filecontents*']) {
      const opening = `\\begin{${name}}`;
      const body = '\r\n😀% \\section{fake} \\begin{theorem}\r\n';
      const closing = `\\end{${name}}`;
      const scanner = new LaTeXParser.SourceScanner(`${opening}${body}${closing}\\section{real}`);
      assert.deepStrictEqual(scanner.commands.map(command => command.name), ['begin', 'end', 'section'], name);
      assert.deepStrictEqual(scanner.ignoredRanges, [{
        kind: 'literalEnvironment', start: opening.length, end: opening.length + body.length,
        contentStart: opening.length, contentEnd: opening.length + body.length, closed: true
      }], name);
      assert.strictEqual(scanner.maskedSource, opening + body.replace(/[^\r\n]/g, ' ') + closing + '\\section{real}', name);
    }
  });

  test('recognizes commented environment names and preserves sorted nonoverlapping ranges', () => {
    const opening = '\\begin% \\fake\r\n{verba% split\r\ntim}';
    const body = '\n\\foo% raw\n';
    const closing = '\\end% closing comment\n{verbatim}';
    const scanner = new LaTeXParser.SourceScanner(opening + body + closing + '% final');
    assert.deepStrictEqual(scanner.commands.map(command => command.name), ['begin', 'end']);
    assert.deepStrictEqual(scanner.ignoredRanges.map(range => range.kind), ['comment', 'comment', 'literalEnvironment', 'comment', 'comment']);
    const literal = scanner.ignoredRanges[2];
    assert.strictEqual(literal.start, opening.length);
    assert.strictEqual(literal.end, opening.length + body.length);
    for (let index = 1; index < scanner.ignoredRanges.length; index++) {
      assert.ok(scanner.ignoredRanges[index - 1].end <= scanner.ignoredRanges[index].start);
    }
  });

  test('masks unclosed environments through EOF and keeps ordinary environment commands', () => {
    const source = String.raw`\begin{theorem}\label{real}\end{theorem}\begin{verbatim}\section{fake}`;
    const scanner = new LaTeXParser.SourceScanner(source);
    assert.deepStrictEqual(scanner.commands.map(command => command.name), ['begin', 'label', 'end', 'begin']);
    assert.strictEqual(scanner.ignoredRanges.length, 1);
    assert.strictEqual(scanner.ignoredRanges[0].closed, false);
    assert.strictEqual(scanner.ignoredRanges[0].end, source.length);
  });

  test('does not hide macro definitions or unfinished inline options', () => {
    const source = String.raw`\newcommand{\example}{\label{defined}}\mintinline[unfinished \foo`;
    const scanner = new LaTeXParser.SourceScanner(source);
    assert.deepStrictEqual(scanner.commands.map(command => command.name), ['newcommand', 'example', 'label', 'mintinline', 'foo']);
    assert.strictEqual(scanner.maskedSource, source);
    assert.deepStrictEqual(scanner.ignoredRanges, []);
  });

  test('reuses raw group matching across many unfinished inline introducers', () => {
    const prefix = String.raw`\mintinline[`.repeat(4096);
    const source = `${prefix}\r\n\\section{after}`;
    const scanner = new LaTeXParser.SourceScanner(source);
    assert.strictEqual(scanner.commands.length, 4097);
    assert.ok(scanner.commands.slice(0, -1).every(command => command.name === 'mintinline'));
    assert.strictEqual(scanner.commands[4096].name, 'section');
    assert.strictEqual(scanner.commands[4096].start, prefix.length + 2);
    assert.strictEqual(scanner.maskedSource, source);
    assert.deepStrictEqual(scanner.ignoredRanges, []);
  });

  test('reads complete later inline arguments independently of unfinished outer groups', () => {
    for (const prefix of [String.raw`\mintinline[unfinished `, String.raw`\mintinline[unfinished { `]) {
      const literal = String.raw`\mintinline[opt]{tex}{\foo}`;
      const source = `${prefix}${literal}\\section{after}`;
      const scanner = new LaTeXParser.SourceScanner(source);
      assert.deepStrictEqual(scanner.commands.map(command => command.name), ['mintinline', 'mintinline', 'section']);
      assert.strictEqual(scanner.ignoredRanges.length, 1);
      assert.strictEqual(scanner.ignoredRanges[0].start, prefix.length);
      assert.strictEqual(scanner.ignoredRanges[0].end, prefix.length + literal.length);
      assert.strictEqual(scanner.ignoredRanges[0].closed, true);
    }
  });
});
