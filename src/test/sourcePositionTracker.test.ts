import * as assert from 'assert';
import SourcePositionTracker, { SourceAnchor } from '../structure/SourcePositionTracker';

suite('Source position tracking', () => {
  test('copies the input anchors and keeps original starts as projection keys', () => {
    const anchor: SourceAnchor = { start: 10, end: 20 };
    const positions = new SourcePositionTracker([anchor]);
    anchor.start = 100;
    anchor.end = 200;
    positions.record([{ offset: 0, length: 0, insertedLength: 3 }]);
    assert.deepStrictEqual([...positions.project()], [[10, { start: 13, end: 23, revision: 0 }]]);
  });

  test('moves declarations after a same-line edit without advancing their revision', () => {
    const positions = new SourcePositionTracker([{ start: 10, end: 20 }]);
    positions.record([{ offset: 4, length: 2, insertedLength: 5 }]);
    assert.deepStrictEqual(positions.project().get(10), { start: 13, end: 23, revision: 0 });
  });

  test('uses UTF-16 lengths without interpreting Unicode characters or CRLF', () => {
    const positions = new SourcePositionTracker([{ start: 4, end: 18 }]);
    positions.record([{ offset: 0, length: 0, insertedLength: 'a😀\r\n'.length }]);
    assert.deepStrictEqual(positions.project().get(4), { start: 9, end: 23, revision: 0 });
    positions.record([{ offset: 1, length: '😀'.length, insertedLength: 0 }]);
    assert.deepStrictEqual(positions.project().get(4), { start: 7, end: 21, revision: 0 });
  });

  test('shifts a declaration right for insertion at its start', () => {
    const positions = new SourcePositionTracker([{ start: 10, end: 20 }]);
    positions.record([{ offset: 10, length: 0, insertedLength: 3 }]);
    assert.deepStrictEqual(positions.project().get(10), { start: 13, end: 23, revision: 0 });
  });

  test('keeps declaration ends left and zero-width endpoint anchors right at insertion boundaries', () => {
    const positions = new SourcePositionTracker([{ start: 10, end: 20 }, { start: 50, end: 50 }]);
    positions.record([{ offset: 20, length: 0, insertedLength: 4 }]);
    assert.deepStrictEqual(positions.project().get(10), { start: 10, end: 20, revision: 1 });
    assert.deepStrictEqual(positions.project().get(50), { start: 54, end: 54, revision: 0 });
    positions.record([{ offset: 54, length: 0, insertedLength: 2 }]);
    assert.deepStrictEqual(positions.project().get(10), { start: 10, end: 20, revision: 1 });
    assert.deepStrictEqual(positions.project().get(50), { start: 56, end: 56, revision: 0 });
    const emptyBody = new SourcePositionTracker([{ start: 2, end: 8 }, { start: 8, end: 8 }]);
    emptyBody.record([{ offset: 8, length: 0, insertedLength: 5 }]);
    assert.deepStrictEqual(emptyBody.project().get(2), { start: 2, end: 8, revision: 1 });
    assert.deepStrictEqual(emptyBody.project().get(8), { start: 13, end: 13, revision: 0 });
  });

  test('tracks multiline declaration edits and advances revision when their text is restored', () => {
    const positions = new SourcePositionTracker([{ start: 100, end: 140 }]);
    positions.record([{ offset: 120, length: 0, insertedLength: '\r\n'.length }]);
    assert.deepStrictEqual(positions.project().get(100), { start: 100, end: 142, revision: 1 });
    positions.record([{ offset: 120, length: 2, insertedLength: 0 }]);
    assert.deepStrictEqual(positions.project().get(100), { start: 100, end: 140, revision: 2 });
  });

  test('does not advance revision for deletion ending at the start or beginning at the declaration end', () => {
    const before = new SourcePositionTracker([{ start: 10, end: 20 }]);
    before.record([{ offset: 5, length: 5, insertedLength: 0 }]);
    assert.deepStrictEqual(before.project().get(10), { start: 5, end: 15, revision: 0 });
    const after = new SourcePositionTracker([{ start: 10, end: 20 }]);
    after.record([{ offset: 20, length: 10, insertedLength: 0 }]);
    assert.deepStrictEqual(after.project().get(10), { start: 10, end: 20, revision: 0 });
  });

  test('advances revision for removal overlapping either edge of a declaration', () => {
    const left = new SourcePositionTracker([{ start: 10, end: 20 }]);
    left.record([{ offset: 7, length: 5, insertedLength: 0 }]);
    assert.deepStrictEqual(left.project().get(10), { start: 7, end: 15, revision: 1 });
    const right = new SourcePositionTracker([{ start: 10, end: 20 }]);
    right.record([{ offset: 17, length: 5, insertedLength: 0 }]);
    assert.deepStrictEqual(right.project().get(10), { start: 10, end: 17, revision: 1 });
  });

  test('clamps a replaced declaration and moves later declarations without advancing their revision', () => {
    const positions = new SourcePositionTracker([
      { start: 10, end: 20 },
      { start: 40, end: 50 }
    ]);
    positions.record([{ offset: 5, length: 30, insertedLength: 4 }]);
    assert.deepStrictEqual([...positions.project()], [
      [10, { start: 9, end: 9, revision: 1 }],
      [40, { start: 14, end: 24, revision: 0 }]
    ]);
  });

  test('sorts a multi-cursor batch in descending original-document coordinates', () => {
    const positions = new SourcePositionTracker([
      { start: 10, end: 20 },
      { start: 39, end: 49 }
    ]);
    positions.record([
      { offset: 2, length: 0, insertedLength: 3 },
      { offset: 40, length: 5, insertedLength: 1 },
      { offset: 25, length: 0, insertedLength: 2 }
    ]);
    assert.deepStrictEqual([...positions.project()], [
      [10, { start: 13, end: 23, revision: 0 }],
      [39, { start: 44, end: 50, revision: 1 }]
    ]);
  });

  test('copies numeric edits and applies successive batches in their own document versions', () => {
    const positions = new SourcePositionTracker([{ start: 10, end: 20 }]);
    const changes = [{ offset: 0, length: 0, insertedLength: 5 }];
    positions.record(changes);
    changes[0].insertedLength = 100;
    changes.push({ offset: 25, length: 4, insertedLength: 0 });
    positions.record([{ offset: 22, length: 0, insertedLength: 3 }]);
    assert.deepStrictEqual(positions.project().get(10), { start: 15, end: 28, revision: 1 });
  });

  test('caches projections without reapplying history or mutating earlier maps and values', () => {
    const positions = new SourcePositionTracker([{ start: 10, end: 20 }]);
    const initial = positions.project();
    assert.strictEqual(positions.project(), initial);
    positions.record([{ offset: 0, length: 0, insertedLength: 3 }]);
    assert.deepStrictEqual(initial.get(10), { start: 10, end: 20, revision: 0 });
    const first = positions.project();
    assert.notStrictEqual(first, initial);
    assert.notStrictEqual(first.get(10), initial.get(10));
    assert.strictEqual(positions.project(), first);
    positions.record([]);
    positions.record([{ offset: 0, length: 0, insertedLength: 0 }]);
    assert.strictEqual(positions.project(), first);
    positions.record([{ offset: 0, length: 0, insertedLength: 2 }]);
    const latest = positions.project();
    assert.deepStrictEqual(latest.get(10), { start: 15, end: 25, revision: 0 });
    assert.deepStrictEqual(first.get(10), { start: 13, end: 23, revision: 0 });
    assert.deepStrictEqual(initial.get(10), { start: 10, end: 20, revision: 0 });
  });

  test('preserves declarations during distant body edits and clamps a deleted endpoint anchor', () => {
    const positions = new SourcePositionTracker([{ start: 10, end: 20 }, { start: 1000000, end: 1000000 }]);
    positions.record([{ offset: 500000, length: 0, insertedLength: 100 }]);
    assert.deepStrictEqual(positions.project().get(10), { start: 10, end: 20, revision: 0 });
    assert.deepStrictEqual(positions.project().get(1000000), { start: 1000100, end: 1000100, revision: 0 });
    positions.record([{ offset: 800000, length: 300000, insertedLength: 0 }]);
    assert.deepStrictEqual(positions.project().get(10), { start: 10, end: 20, revision: 0 });
    assert.deepStrictEqual(positions.project().get(1000000), { start: 800000, end: 800000, revision: 1 });
  });

  test('supports an empty anchor index and retains the cached empty projection', () => {
    const positions = new SourcePositionTracker([]);
    positions.record([{ offset: 0, length: 5, insertedLength: 10 }]);
    const result = positions.project();
    assert.strictEqual(result.size, 0);
    assert.strictEqual(positions.project(), result);
  });

  test('advances only the touched declaration revision across body edits and repeated requests', () => {
    const positions = new SourcePositionTracker([
      { start: 10, end: 30 },
      { start: 90, end: 110 }
    ]);
    positions.record([{ offset: 20, length: 2, insertedLength: 5 }]);
    const edited = positions.project();
    assert.strictEqual(edited.get(10)!.revision, 1);
    assert.strictEqual(edited.get(90)!.revision, 0);
    assert.strictEqual(positions.project(), edited);
    positions.record([{ offset: 60, length: 0, insertedLength: 4 }]);
    assert.strictEqual(positions.project().get(10)!.revision, 1, 'Body edits reuse the last title analysis');
    assert.strictEqual(positions.project().get(90)!.revision, 0);
    positions.record([{ offset: 20, length: 5, insertedLength: 2 }]);
    assert.strictEqual(positions.project().get(10)!.revision, 2, 'Restoring the argument permits another local parse');
    assert.strictEqual(edited.get(10)!.revision, 1, 'Published revisions remain immutable');
  });

  test('requests another title read when a removed closing brace is reinserted at the mapped end', () => {
    const positions = new SourcePositionTracker([{ start: 10, end: 30 }]);
    positions.record([{ offset: 29, length: 1, insertedLength: 0 }]);
    assert.deepStrictEqual(positions.project().get(10), { start: 10, end: 29, revision: 1 });
    positions.record([{ offset: 29, length: 0, insertedLength: 1 }]);
    assert.deepStrictEqual(positions.project().get(10), { start: 10, end: 29, revision: 2 });
  });
});
