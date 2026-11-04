import * as assert from 'assert';
import { sourceTextChanges } from '../structure/SourceTextChanges';

function verify(before: string, after: string): ReturnType<typeof sourceTextChanges> {
  const edits = sourceTextChanges(before, after);
  let oldCursor = 0;
  let newCursor = 0;
  for (const edit of edits) {
    assert.ok(edit.offset >= oldCursor, 'Changes must be ordered and nonoverlapping');
    const unchanged = before.slice(oldCursor, edit.offset);
    assert.strictEqual(after.slice(newCursor, newCursor + unchanged.length), unchanged);
    oldCursor = edit.offset + edit.length;
    newCursor += unchanged.length + edit.insertedLength;
  }
  assert.strictEqual(before.slice(oldCursor), after.slice(newCursor));
  return edits;
}

suite('Saved source to editor position bridge', () => {
  test('handles equality, insertion, deletion, replacement and UTF-16 line endings', () => {
    assert.deepStrictEqual(verify('unchanged', 'unchanged'), []);
    assert.deepStrictEqual(verify('ab', 'a\r\n😀b'), [{ offset: 1, length: 0, insertedLength: 4 }]);
    assert.deepStrictEqual(verify('a\r\n😀b', 'ab'), [{ offset: 1, length: 4, insertedLength: 0 }]);
    for (const [before, after] of [['', 'new'], ['old', ''], ['old', 'new'], ['日本語\r\n末尾', '日本語\n変更後の末尾']]) {
      verify(before, after);
    }
  });

  test('preserves unchanged inline declarations between separate small edits', () => {
    const before = 'aaa \\section{First} bbb \\section{Second} ccc';
    const after = 'AAAAA \\section{First} BBBBB \\section{Second} CCCCC';
    const edits = verify(before, after);
    for (const declaration of ['\\section{First}', '\\section{Second}']) {
      const start = before.indexOf(declaration);
      assert.ok(edits.every(edit => edit.offset + edit.length <= start || edit.offset >= start + declaration.length));
    }
  });

  test('uses unchanged line anchors around large rewrites and reordered text', () => {
    const first = 'x'.repeat(10000);
    const second = 'y'.repeat(10000);
    const before = `${first}\r\n\\section{Stable}\r\n${second}\r\n\\section{Last}\r\n`;
    const after = `${'p'.repeat(10000)}\r\n\\section{Stable}\r\n${'q'.repeat(10000)}\r\n\\section{Last}\r\n`;
    const edits = verify(before, after);
    const start = before.indexOf('\\section{Stable}');
    assert.ok(edits.every(edit => edit.offset + edit.length <= start || edit.offset >= start + '\\section{Stable}'.length));
    assert.ok(edits.length >= 2);
    verify('a\nb\nc\nd\n', 'd\nb\na\nc\n');
    verify('a'.repeat(100000), 'b'.repeat(100000));
  });

  test('retains a valid correspondence for many deterministic small edits', () => {
    let seed = 17;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    const alphabet = ['a', 'b', '\r', '\n', '日', '\\', '{', '}'];
    for (let round = 0; round < 120; round++) {
      let before = '';
      for (let index = 0; index < 80; index++) { before += alphabet[random() % alphabet.length]; }
      let after = before;
      for (let edit = 0; edit < 8; edit++) {
        const offset = random() % (after.length + 1);
        const length = random() % 5;
        after = after.slice(0, offset) + alphabet[random() % alphabet.length] + after.slice(offset + length);
      }
      verify(before, after);
    }
  });
});
