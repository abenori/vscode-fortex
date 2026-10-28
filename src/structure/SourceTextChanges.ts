import type { OutlineEdit } from './NativeOutlinePositions';

interface Line { start: number; end: number; text: string }

/** Save/reload-only bridge from persisted text to a captured editor version. */
export function sourceTextChanges(before: string, after: string): OutlineEdit[] {
  if (before === after) { return []; }
  const edits: OutlineEdit[] = [];
  // Large rewrites fall back to a conservative replacement. Bound fine-grained
  // comparison work rather than running an unbounded diff in the extension host.
  let remainingCells = 1000000;
  const append = (offset: number, length: number, insertedLength: number) => {
    if (length || insertedLength) { edits.push({ offset, length, insertedLength }); }
  };
  const compare = (oldStart: number, oldEnd: number, newStart: number, newEnd: number, findLines: boolean): void => {
    while (oldStart < oldEnd && newStart < newEnd && before[oldStart] === after[newStart]) { oldStart++; newStart++; }
    while (oldStart < oldEnd && newStart < newEnd && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
    const oldLength = oldEnd - oldStart;
    const newLength = newEnd - newStart;
    if (!oldLength || !newLength) { append(oldStart, oldLength, newLength); return; }

    const cells = (oldLength + 1) * (newLength + 1);
    if (cells <= 262144 && cells <= remainingCells) {
      remainingCells -= cells;
      const width = newLength + 1;
      const matches = new Uint32Array(cells);
      for (let left = oldLength - 1; left >= 0; left--) {
        for (let right = newLength - 1; right >= 0; right--) {
          matches[left * width + right] = before[oldStart + left] === after[newStart + right]
            ? matches[(left + 1) * width + right + 1] + 1
            : Math.max(matches[(left + 1) * width + right], matches[left * width + right + 1]);
        }
      }
      let left = 0;
      let right = 0;
      let pending: { offset: number; length: number; insertedLength: number } | undefined;
      const flush = () => { if (pending) { edits.push(pending); pending = undefined; } };
      while (left < oldLength || right < newLength) {
        if (left < oldLength && right < newLength && before[oldStart + left] === after[newStart + right]) {
          flush(); left++; right++;
        } else {
          pending ??= { offset: oldStart + left, length: 0, insertedLength: 0 };
          if (left < oldLength && (right === newLength
            || matches[(left + 1) * width + right] >= matches[left * width + right + 1])) {
            pending.length++; left++;
          } else { pending.insertedLength++; right++; }
        }
      }
      flush();
      return;
    }

    if (findLines) {
      const oldLines = lines(before, oldStart, oldEnd);
      const newLines = lines(after, newStart, newEnd);
      const oldUnique = uniqueLines(oldLines);
      const newUnique = uniqueLines(newLines);
      const candidates: { old: number; next: number }[] = [];
      for (const [text, old] of oldUnique) {
        const next = newUnique.get(text);
        if (old >= 0 && next !== undefined && next >= 0) { candidates.push({ old, next }); }
      }
      const anchors = increasing(candidates);
      if (anchors.length) {
        let oldCursor = oldStart;
        let newCursor = newStart;
        for (const anchor of anchors) {
          const oldLine = oldLines[anchor.old];
          const newLine = newLines[anchor.next];
          compare(oldCursor, oldLine.start, newCursor, newLine.start, false);
          oldCursor = oldLine.end;
          newCursor = newLine.end;
        }
        compare(oldCursor, oldEnd, newCursor, newEnd, false);
        return;
      }
    }
    append(oldStart, oldLength, newLength);
  };
  compare(0, before.length, 0, after.length, true);
  return edits;
}

function lines(source: string, start: number, end: number): Line[] {
  const result: Line[] = [];
  let lineStart = start;
  for (let cursor = start; cursor < end; cursor++) {
    if (source[cursor] !== '\r' && source[cursor] !== '\n') { continue; }
    if (source[cursor] === '\r' && source[cursor + 1] === '\n' && cursor + 1 < end) { cursor++; }
    result.push({ start: lineStart, end: cursor + 1, text: source.slice(lineStart, cursor + 1) });
    lineStart = cursor + 1;
  }
  if (lineStart < end) { result.push({ start: lineStart, end, text: source.slice(lineStart, end) }); }
  return result;
}

function uniqueLines(entries: readonly Line[]): Map<string, number> {
  const result = new Map<string, number>();
  entries.forEach((entry, index) => result.set(entry.text, result.has(entry.text) ? -1 : index));
  return result;
}

/** Longest increasing subsequence keeps only unchanged lines in source order. */
function increasing(entries: readonly { old: number; next: number }[]): { old: number; next: number }[] {
  const tails: number[] = [];
  const previous: number[] = [];
  entries.forEach((entry, index) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (entries[tails[middle]].next < entry.next) { low = middle + 1; }
      else { high = middle; }
    }
    previous[index] = low ? tails[low - 1] : -1;
    tails[low] = index;
  });
  const result: { old: number; next: number }[] = [];
  for (let index = tails.at(-1) ?? -1; index >= 0; index = previous[index]) { result.push(entries[index]); }
  return result.reverse();
}
