import * as assert from 'assert';
import * as LaTeXParser from '../latex-parser';

suite('LaTeX comma lists', () => {
  test('splits only top-level commas while retaining nested groups and control symbols', () => {
    const source = String.raw`first,{a,{b,c}},\choose{x,y},escaped\,comma,\{last\},[a,b]`;
    const ranges = LaTeXParser.splitclist(new LaTeXParser.SourceScanner(source));
    assert.deepStrictEqual(ranges.map(range => source.slice(range.start, range.end)), [
      'first', '{a,{b,c}}', String.raw`\choose{x,y}`, String.raw`escaped\,comma`,
      String.raw`\{last\}`, '[a', 'b]'
    ]);
  });

  test('preserves original ranges across comments, literals, CRLF and Unicode text', () => {
    const prefix = 'Before😀\r\n';
    const content = '日% ignored ,{\r\n本,\\verb+{,}+,\\begin{verbatim}a,{b}\\end{verbatim},😀';
    const source = prefix + content + '\r\nAfter';
    const scanner = new LaTeXParser.SourceScanner(source);
    const ranges = LaTeXParser.splitclist(scanner, prefix.length, prefix.length + content.length);
    assert.deepStrictEqual(ranges.map(range => source.slice(range.start, range.end)), [
      '日% ignored ,{\r\n本', '\\verb+{,}+', '\\begin{verbatim}a,{b}\\end{verbatim}', '😀'
    ]);
    assert.strictEqual(scanner.textWithoutComments(ranges[0].start, ranges[0].end), '日本');
    assert.strictEqual(ranges[0].start, prefix.length);
    assert.strictEqual(ranges.at(-1)?.end, prefix.length + content.length);
  });

  test('retains empty items and whitespace instead of applying caller policies', () => {
    const source = ', a ,, b ,';
    const ranges = LaTeXParser.splitclist(new LaTeXParser.SourceScanner(source));
    assert.deepStrictEqual(ranges.map(range => source.slice(range.start, range.end)), ['', ' a ', '', ' b ', '']);
    assert.deepStrictEqual(LaTeXParser.splitclist(new LaTeXParser.SourceScanner('')), [{ start: 0, end: 0 }]);
  });

  test('handles bounded partial lists without treating command fragments as separators', () => {
    const source = String.raw`\,first,{unfinished,a,b`;
    const scanner = new LaTeXParser.SourceScanner(source);
    const ranges = LaTeXParser.splitclist(scanner, 1);
    assert.deepStrictEqual(ranges.map(range => source.slice(range.start, range.end)), [',first', '{unfinished,a,b']);
    assert.deepStrictEqual(LaTeXParser.splitclist(scanner, source.length), [{ start: source.length, end: source.length }]);
    for (const [start, end] of [[-1, 2], [2, 1], [0, source.length + 1], [0.5, 2], [0, Infinity], [NaN, 2]]) {
      assert.deepStrictEqual(LaTeXParser.splitclist(scanner, start, end), []);
    }
  });
});
