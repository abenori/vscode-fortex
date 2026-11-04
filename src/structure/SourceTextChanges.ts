import type { SourceEditDelta } from './SourcePositionTracker';

interface Line {
  /** 元ソースにおける範囲の開始位置．0始まりのUTF-16単位で，この位置を含む． */
  start: number;
  /** 元ソースにおける範囲の終端．0始まりのUTF-16単位で，この位置を含まない． */
  end: number;
  /** この範囲に対応する文字列． */
  text: string
}

/**
 * 保存・再読み込み時に，保存済み本文と捕捉したエディタの版の位置を対応付ける．
 * @param before 変更前のソース全文．
 * @param after 変更後のソース全文．
 * @returns 変更前の座標系で表した置換範囲と挿入文字数．本文が同一なら空配列．
 */
export function sourceTextChanges(before: string, after: string): SourceEditDelta[] {
  if (before === after) { return []; }
  const edits: SourceEditDelta[] = [];
  // 大きな書き換えは範囲全体の置換に切り替える．拡張機能の実行環境で比較量が無制限に増えないよう，細かい差分の計算量を制限する．
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
      const lcsLengths = new Uint32Array(cells);
      for (let left = oldLength - 1; left >= 0; left--) {
        for (let right = newLength - 1; right >= 0; right--) {
          lcsLengths[left * width + right] = before[oldStart + left] === after[newStart + right]
            ? lcsLengths[(left + 1) * width + right + 1] + 1
            : Math.max(lcsLengths[(left + 1) * width + right], lcsLengths[left * width + right + 1]);
        }
      }
      let left = 0;
      let right = 0;
      let pending: {
        /** 編集前の本文における0始まりのUTF-16位置． */
        offset: number;
        /** 元のソースのUTF-16単位の長さ． */
        length: number;
        /** 挿入する文字列のUTF-16単位の長さ． */
        insertedLength: number
      } | undefined;
      const flush = () => { if (pending) { edits.push(pending); pending = undefined; } };
      while (left < oldLength || right < newLength) {
        if (left < oldLength && right < newLength && before[oldStart + left] === after[newStart + right]) {
          flush(); left++; right++;
        } else {
          pending ??= { offset: oldStart + left, length: 0, insertedLength: 0 };
          if (left < oldLength && (right === newLength
            || lcsLengths[(left + 1) * width + right] >= lcsLengths[left * width + right + 1])) {
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
      const candidates: {
        /** 変更前の行配列における0始まりの添字． */
        old: number;
        /** 変更後の行配列における0始まりの添字． */
        next: number
      }[] = [];
      for (const [text, old] of oldUnique) {
        const next = newUnique.get(text);
        if (old >= 0 && next !== undefined && next >= 0) { candidates.push({ old, next }); }
      }
      const anchors = selectIncreasingAnchors(candidates);
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

/**
 * 指定したソース範囲を改行を含む行に分割する．
 * @param source 解析または読み取りの対象となるソース本文．
 * @param start 対象範囲の開始位置．UTF-16単位で，範囲に含む．
 * @param end 対象範囲の終端位置．UTF-16単位で，範囲に含まない．
 * @returns 行の半開UTF-16範囲と本文の配列．
 */
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

/**
 * 行本文ごとに唯一の出現位置を索引化する．
 * @param entries 処理する項目の一覧．
 * @returns 本文から行の添字へのMap．重複した本文の値は-1．
 */
function uniqueLines(entries: readonly Line[]): Map<string, number> {
  const result = new Map<string, number>();
  entries.forEach((entry, index) => result.set(entry.text, result.has(entry.text) ? -1 : index));
  return result;
}

/**
 * 最長増加部分列を使い，変更のない共通行をソース順を保って残す．
 * @param entries 処理する項目の一覧．
 * @returns 変更前・変更後の両方で順序を保つ，共通行の対応の最長部分列．
 */
function selectIncreasingAnchors(entries: readonly {
  /** 変更前の行配列における0始まりの添字． */
  old: number;
  /** 変更後の行配列における0始まりの添字． */
  next: number
}[]): {
  /** 変更前の行配列における0始まりの添字． */
  old: number;
  /** 変更後の行配列における0始まりの添字． */
  next: number
}[] {
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
  const result: {
    /** 変更前の行配列における0始まりの添字． */
    old: number;
    /** 変更後の行配列における0始まりの添字． */
    next: number
  }[] = [];
  for (let index = tails.at(-1) ?? -1; index >= 0; index = previous[index]) { result.push(entries[index]); }
  return result.reverse();
}
