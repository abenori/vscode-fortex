import * as assert from 'assert';
import * as LaTeXParser from '../latex-parser';

function contents(source: string, argument: LaTeXParser.ScannedArgument | undefined): string {
  assert.ok(argument);
  return source.slice(argument.contentStart, argument.contentEnd);
}

suite('LaTeX argument scanner', () => {
  test('reads nested multiline brace arguments with original UTF-16 ranges', () => {
    const source = '😀 \\section\r\n{日本語 {nested}\r\ntext}';
    const scanner = new LaTeXParser.ArgumentScanner(new LaTeXParser.SourceScanner(source));
    const argument = scanner.readArgument(source.indexOf('section') + 'section'.length);
    assert.deepStrictEqual(argument, {
      opening: '{', start: source.indexOf('{'), end: source.length,
      contentStart: source.indexOf('{') + 1, contentEnd: source.length - 1, complete: true
    });
    assert.strictEqual(contents(source, argument), '日本語 {nested}\r\ntext');
  });

  test('skips whitespace and comments but keeps comment contents in the raw argument', () => {
    const source = ' % 😀 ignored { [\r\n {first% } ]\r\nsecond}';
    const argument = new LaTeXParser.ArgumentScanner(source).readArgument(0);
    assert.strictEqual(argument?.start, source.indexOf('{first'));
    assert.strictEqual(argument?.end, source.length);
    assert.strictEqual(contents(source, argument), 'first% } ]\r\nsecond');
  });

  test('ignores escaped delimiters and control symbols when indexing groups', () => {
    const source = String.raw`\{fake\} \[fake\] \\[real] {a\}b\{c \% d}`;
    const scanner = new LaTeXParser.ArgumentScanner(source);
    assert.strictEqual(scanner.readArgument(1), undefined);
    assert.strictEqual(scanner.readArgument(source.indexOf('[fake'), '['), undefined);
    assert.strictEqual(contents(source, scanner.readArgument(source.indexOf('[real]'), '[')), 'real');
    const argument = scanner.readArgument(source.indexOf('{a'));
    assert.strictEqual(contents(source, argument), String.raw`a\}b\{c \% d`);
    assert.strictEqual(argument?.complete, true);
  });

  test('balances optional brackets while braces protect closing brackets', () => {
    const source = '[one {]} [two] three]{required}';
    const scanner = new LaTeXParser.ArgumentScanner(source);
    const optional = scanner.readArgument(0, '[');
    assert.strictEqual(contents(source, optional), 'one {]} [two] three');
    assert.strictEqual(optional?.complete, true);
    assert.strictEqual(contents(source, scanner.readArgument(optional!.end)), 'required');
    assert.strictEqual(contents(source, scanner.readArgument(source.indexOf('{]}'))), ']');
  });

  test('does not require square brackets to balance inside brace arguments', () => {
    const source = '{[}{]}';
    const scanner = new LaTeXParser.ArgumentScanner(source);
    assert.strictEqual(contents(source, scanner.readArgument(0)), '[');
    assert.strictEqual(contents(source, scanner.readArgument(3)), ']');
  });

  test('ignores literal delimiters inside an argument', () => {
    const source = String.raw`{a \verb|}%{| \lstinline{]} \mintinline{latex}|}| b}`;
    const argument = new LaTeXParser.ArgumentScanner(source).readArgument(0);
    assert.strictEqual(argument?.end, source.length);
    assert.strictEqual(argument?.complete, true);
    assert.strictEqual(contents(source, argument), source.slice(1, -1));
  });

  test('does not skip inline literals as if they were whitespace', () => {
    const source = String.raw` \verb| | {real}`;
    const scanner = new LaTeXParser.ArgumentScanner(source);
    assert.strictEqual(scanner.readArgument(0), undefined);
    assert.strictEqual(scanner.readArgument(source.indexOf('|') + 1), undefined);
    assert.strictEqual(contents(source, scanner.readArgument(source.indexOf('{real}'))), 'real');
  });

  test('does not read masked groups or stars from a literal environment', () => {
    const source = String.raw`\begin{verbatim} {*}[fake] \end{verbatim}{real}`;
    const scanner = new LaTeXParser.ArgumentScanner(source);
    assert.strictEqual(scanner.readArgument(source.indexOf('{*}')), undefined);
    assert.strictEqual(scanner.readArgument(source.indexOf('[fake]'), '['), undefined);
    assert.strictEqual(scanner.readStar(source.indexOf('*'))?.starred, false);
    assert.strictEqual(contents(source, scanner.readArgument(source.indexOf('{real}'))), 'real');
  });

  test('returns unclosed arguments without hiding later complete groups', () => {
    const source = '{unclosed\r\n\\section{recovered}';
    const scanner = new LaTeXParser.ArgumentScanner(source);
    assert.deepStrictEqual(scanner.readArgument(0), {
      opening: '{', start: 0, end: source.length,
      contentStart: 1, contentEnd: source.length, complete: false
    });
    const recovered = scanner.readArgument(source.indexOf('{recovered}'));
    assert.strictEqual(contents(source, recovered), 'recovered');
    assert.strictEqual(recovered?.complete, true);
    const optional = new LaTeXParser.ArgumentScanner('[unclosed').readArgument(0, '[');
    assert.strictEqual(optional?.complete, false);
    assert.strictEqual(optional?.contentEnd, '[unclosed'.length);
  });

  test('reads a star across comments and reports the exact continuation position', () => {
    const source = ' % ignored\r\n * % after star\n {title}';
    const scanner = new LaTeXParser.ArgumentScanner(source);
    const star = scanner.readStar(0);
    assert.deepStrictEqual(star, { starred: true, start: source.indexOf('*'), end: source.indexOf('*') + 1 });
    assert.strictEqual(contents(source, scanner.readArgument(star!.end)), 'title');
    assert.deepStrictEqual(scanner.readStar(star!.end), {
      starred: false, start: source.indexOf('{title}'), end: source.indexOf('{title}')
    });
    assert.strictEqual(new LaTeXParser.ArgumentScanner(String.raw`\*`).readStar(1)?.starred, false);
  });

  test('handles empty arguments, absent arguments, EOF and invalid offsets', () => {
    const scanner = new LaTeXParser.ArgumentScanner('{}[]');
    assert.strictEqual(scanner.readArgument(0)?.contentStart, scanner.readArgument(0)?.contentEnd);
    assert.strictEqual(scanner.readArgument(2, '[')?.complete, true);
    assert.strictEqual(scanner.readArgument(2), undefined);
    assert.strictEqual(scanner.readArgument(4), undefined);
    assert.deepStrictEqual(scanner.readStar(4), { starred: false, start: 4, end: 4 });
    for (const offset of [-1, 0.5, 5, NaN, Infinity]) {
      assert.strictEqual(scanner.readArgument(offset), undefined);
      assert.strictEqual(scanner.readStar(offset), undefined);
    }
    assert.strictEqual(new LaTeXParser.ArgumentScanner('').readArgument(0), undefined);
  });
});
