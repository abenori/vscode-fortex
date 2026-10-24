import type SourceScanner from './SourceScanner';
import type { SourceRange } from './SourceScanner';

/**
 * Splits a comma list at brace depth zero using an existing lexical scan.
 * Ranges are untrimmed, half-open UTF-16 offsets in the original source; empty
 * items are retained. Comments, literal contents and control symbols cannot
 * supply separators or braces. Invalid bounds return an empty array.
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
