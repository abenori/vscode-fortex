import ArgumentScanner from './ArgumentScanner';
import SourceScanner from './SourceScanner';
import type { SourceRange } from './SourceScanner';

export const DISPLAY_MATH_ENVIRONMENT = '\\[';

/** Named environments and the four supported mathematical delimiter forms. */
export type EnvironmentTokenStyle = 'named' | 'display' | 'inline' | 'dollar' | 'doubleDollar';

/** Original UTF-16 offsets; end and nameEnd are exclusive. */
export interface EnvironmentToken {
  readonly kind: 'begin' | 'end';
  readonly style: EnvironmentTokenStyle;
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly nameStart: number;
  readonly nameEnd: number;
}

export interface EnvironmentPair {
  readonly begin: EnvironmentToken;
  readonly end: EnvironmentToken;
}

/**
 * Matches literal environment declarations without macro expansion. Comments,
 * escaped delimiters and literal contents are excluded by the source scanner.
 * Mismatched closing tokens never discard intervening openings: only the top
 * compatible opening can be paired, so broken input cannot create crossing pairs.
 */
export default class EnvironmentParser {
  public readonly source: string;
  public readonly tokens: readonly EnvironmentToken[];
  public readonly pairs: readonly EnvironmentPair[];
  public readonly unclosed: readonly EnvironmentToken[];

  public constructor(
    source: string | SourceScanner,
    excludedRanges: readonly SourceRange[] = [],
    styles?: readonly EnvironmentTokenStyle[],
    sharedArgumentsScanner?: ArgumentScanner
  ) {
    const scanner = typeof source === 'string' ? new SourceScanner(source) : source;
    this.source = scanner.source;
    const excluded = mergeRanges(excludedRanges, this.source.length);
    let excludedIndex = 0;
    const overlapsExcluded = (start: number, end: number): boolean => {
      for (let index = excludedIndex; index < excluded.length && excluded[index].start < end; index++) {
        if (excluded[index].end > start) {
          return true;
        }
      }
      return false;
    };
    const argumentsScanner = sharedArgumentsScanner ?? new ArgumentScanner(scanner);
    const tokens: EnvironmentToken[] = [];
    const stack: EnvironmentToken[] = [];
    const pairs: EnvironmentPair[] = [];
    const enabledStyles = styles ? new Set(styles) : undefined;
    let commandIndex = 0;
    const append = (token: EnvironmentToken): void => {
      if (enabledStyles && !enabledStyles.has(token.style)) {
        return;
      }
      tokens.push(token);
      if (token.kind === 'begin') {
        stack.push(token);
        return;
      }
      const begin = stack.at(-1);
      if (begin?.name === token.name && begin.style === token.style) {
        stack.pop();
        pairs.push({ begin, end: token });
      }
    };

    for (let cursor = 0; cursor < scanner.maskedSource.length;) {
      while (excludedIndex < excluded.length && excluded[excludedIndex].end <= cursor) {
        excludedIndex++;
      }
      if (excluded[excludedIndex]?.start <= cursor) {
        cursor = excluded[excludedIndex].end;
        continue;
      }
      while (commandIndex < scanner.commands.length && scanner.commands[commandIndex].start < cursor) {
        commandIndex++;
      }
      const command = scanner.commands[commandIndex];
      if (command?.start === cursor) {
        commandIndex++;
        cursor = command.end;
        if (overlapsExcluded(command.start, command.end)) {
          continue;
        }
        if (command.name === 'begin' || command.name === 'end') {
          const argument = argumentsScanner.readArgument(command.end);
          if (!argument?.complete) {
            continue;
          }
          cursor = argument.end;
          if (overlapsExcluded(command.start, argument.end)) {
            continue;
          }
          const name = scanner.textWithoutComments(argument.contentStart, argument.contentEnd)?.trim() ?? '';
          if (!name || /[\\{}\s]/.test(name)) {
            continue;
          }
          const maskedName = scanner.maskedSource.slice(argument.contentStart, argument.contentEnd);
          append({
            kind: command.name === 'begin' ? 'begin' : 'end', style: 'named', name,
            start: command.start, end: argument.end,
            nameStart: argument.contentStart + maskedName.length - maskedName.trimStart().length,
            nameEnd: argument.contentStart + maskedName.trimEnd().length
          });
        } else if (command.name === '[' || command.name === ']' || command.name === '(' || command.name === ')') {
          const display = command.name === '[' || command.name === ']';
          append({
            kind: command.name === '[' || command.name === '(' ? 'begin' : 'end',
            style: display ? 'display' : 'inline', name: display ? DISPLAY_MATH_ENVIRONMENT : '\\(',
            start: command.start, end: command.end, nameStart: command.start, nameEnd: command.end
          });
        }
        continue;
      }
      if (scanner.maskedSource[cursor] === '$') {
        // An inline formula closes at the first dollar even when another one
        // immediately opens the next formula: `$x$$y$` has no display delimiter.
        const double = stack.at(-1)?.style !== 'dollar' && scanner.maskedSource[cursor + 1] === '$'
          && !overlapsExcluded(cursor, cursor + 2);
        const style = double ? 'doubleDollar' : 'dollar';
        const name = double ? '$$' : '$';
        const end = cursor + name.length;
        append({
          kind: stack.at(-1)?.style === style ? 'end' : 'begin', style, name,
          start: cursor, end, nameStart: cursor, nameEnd: end
        });
        cursor = end;
      } else {
        cursor++;
      }
    }
    this.tokens = tokens;
    this.pairs = pairs;
    this.unclosed = stack;
  }

  /** Accepts a caret immediately after the token for editor compatibility. */
  public tokenAt(offset: number): EnvironmentToken | undefined {
    if (!this.validOffset(offset)) {
      return undefined;
    }
    // At adjacent delimiters, the token starting here owns the caret; otherwise
    // retain support for a caret immediately after an existing token.
    return this.tokens.find(token => token.start === offset)
      ?? this.tokens.find(token => token.start <= offset && offset <= token.end);
  }

  /** Finds a pair only when the caret is on one of its delimiter tokens. */
  public pairAt(offset: number): EnvironmentPair | undefined {
    const token = this.tokenAt(offset);
    return token ? this.pairs.find(pair => pair.begin === token || pair.end === token) : undefined;
  }

  /** Innermost globally unclosed opening completed before this caret position. */
  public unclosedAt(offset: number): EnvironmentToken | undefined {
    return this.validOffset(offset) ? this.unclosed.filter(token => token.end <= offset).at(-1) : undefined;
  }

  private validOffset(offset: number): boolean {
    return Number.isInteger(offset) && offset >= 0 && offset <= this.source.length;
  }

}

/** Invalid exclusions are ignored; overlapping ranges are traversed only once. */
function mergeRanges(ranges: readonly SourceRange[], length: number): SourceRange[] {
  const sorted = ranges.filter(range => Number.isInteger(range.start) && Number.isInteger(range.end)
    && range.start >= 0 && range.end <= length && range.start < range.end)
    .map(range => ({ start: range.start, end: range.end })).sort((left, right) => left.start - right.start);
  const merged: { start: number; end: number }[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push(range);
    }
  }
  return merged;
}
