import type SourceScanner from './SourceScanner';
import type { SourceRange } from './SourceScanner';

/**
 * 既存の字句解析結果を使い，波括弧の深さが0のカンマで分割する．範囲は空白を除去せず，元ソースのUTF-16単位の半開区間で返す．空要素も残す．
 * コメント・リテラル・制御記号内の文字は区切りや波括弧として扱わない．不正な範囲では空配列を返す．
 *
 * @param scanner 元のソースに対する共有字句解析結果．
 * @param start 対象範囲の開始位置．UTF-16単位で，範囲に含む．省略時は0．
 * @param end 対象範囲の終端位置．UTF-16単位で，範囲に含まない．省略時はscanner.source.length．
 * @returns 空要素を保持した各項目の半開UTF-16範囲．不正な範囲なら空配列．
 */
export function splitclist(scanner: SourceScanner, start = 0, end = scanner.source.length): readonly SourceRange[] {
  if (!Number.isInteger(start) || !Number.isInteger(end)
    || start < 0 || end < start || end > scanner.source.length) {
    return [];
  }
  const { commands, maskedSource } = scanner;
  let low = 0;
  let high = commands.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (commands[middle].end <= start) { low = middle + 1; }
    else { high = middle; }
  }
  let commandIndex = low;
  let depth = 0;
  let itemStart = start;
  const ranges: SourceRange[] = [];
  for (let cursor = start; cursor < end; cursor++) {
    const command = commands[commandIndex];
    if (command && command.start <= cursor) {
      cursor = command.end - 1;
      commandIndex++;
      continue;
    }
    const character = maskedSource[cursor];
    if (character === '{') { depth++; }
    else if (character === '}' && depth > 0) { depth--; }
    else if (character === ',' && depth === 0) {
      ranges.push({ start: itemStart, end: cursor });
      itemStart = cursor + 1;
    }
  }
  ranges.push({ start: itemStart, end });
  return ranges;
}
