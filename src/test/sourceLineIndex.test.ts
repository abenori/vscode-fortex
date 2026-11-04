import * as assert from 'assert';
import SourceLineIndex from '../structure/SourceLineIndex';

suite('Saved source line index', () => {
  test('handles empty text, trailing newlines and clamped offsets', () => {
    const empty = new SourceLineIndex('');
    assert.strictEqual(empty.lineNumberAt(0), 1);
    assert.strictEqual(empty.lineNumberAt(100), 1);
    const lines = new SourceLineIndex('one\ntwo\n');
    assert.strictEqual(lines.lineNumberAt(-100), 1);
    assert.strictEqual(lines.lineNumberAt(3), 1);
    assert.strictEqual(lines.lineNumberAt(4), 2);
    assert.strictEqual(lines.lineNumberAt(8), 3);
    assert.strictEqual(lines.lineNumberAt(100), 3);
  });

  test('treats CRLF as one newline and keeps its interior on the preceding line', () => {
    const lines = new SourceLineIndex('a\r\nb\rc\nd');
    assert.deepStrictEqual(Array.from({ length: 9 }, (_, offset) => lines.lineNumberAt(offset)),
      [1, 1, 1, 2, 2, 3, 3, 4, 4]);
  });

  test('uses UTF-16 offsets for Japanese text and surrogate pairs', () => {
    const source = '日本😀\r\n次\n終';
    const lines = new SourceLineIndex(source);
    assert.strictEqual(lines.lineNumberAt(source.indexOf('次')), 2);
    assert.strictEqual(lines.lineNumberAt(source.indexOf('終')), 3);
    assert.strictEqual(lines.lineNumberAt(3), 1);
    assert.strictEqual(lines.lineNumberAt(5), 1);
  });

  test('supports repeated unordered queries over a large source', () => {
    const line = '本文 😀\r\n';
    const lines = new SourceLineIndex(line.repeat(20000));
    for (let query = 0; query < 2000; query++) {
      const number = (query * 37) % 20000;
      assert.strictEqual(lines.lineNumberAt(number * line.length), number + 1);
    }
  });
});
