import SourceScanner from './SourceScanner';
import ArgumentScanner from './ArgumentScanner';

/** A label or one reference key, measured in original UTF-16 source offsets. */
export interface ReferenceToken {
  readonly kind: 'label' | 'reference';
  readonly command: string;
  readonly key: string;
  readonly commandStart: number;
  /** The complete command including its argument; the end is exclusive. */
  readonly commandEnd: number;
  readonly keyStart: number;
  readonly keyEnd: number;
}

const referenceCommands = new Set([
  'ref', 'pageref', 'eqref', 'autoref', 'nameref', 'cref', 'Cref', 'vref', 'Vref'
]);

/**
 * Reads complete label and reference declarations without macro expansion.
 * References split at top-level commas; labels keep one key. Source order and
 * duplicates are retained. Comments, literals and escaped commands follow the
 * SourceScanner rules; macro definition bodies remain ordinary source. A key's
 * range includes any comments removed from its text, preserving original offsets.
 */
export default class ReferenceParser {
  public readonly source: string;
  public readonly tokens: readonly ReferenceToken[];

  public constructor(source: string | SourceScanner) {
    const scanner = typeof source === 'string' ? new SourceScanner(source) : source;
    const argumentsScanner = new ArgumentScanner(scanner);
    this.source = scanner.source;
    const tokens: ReferenceToken[] = [];
    let consumedEnd = 0;

    for (const command of scanner.commands) {
      if (command.start < consumedEnd
        || (command.name !== 'label' && !ReferenceParser.isReferenceCommand(command.name))) {
        continue;
      }
      const cursor = command.name === 'label'
        ? command.end
        : argumentsScanner.readStar(command.end)?.end ?? command.end;
      const argument = argumentsScanner.readArgument(cursor);
      if (!argument?.complete) {
        continue;
      }
      consumedEnd = argument.end;
      const segments = command.name === 'label'
        ? [[argument.contentStart, argument.contentEnd] as const]
        : this.keySegments(scanner, argument.contentStart, argument.contentEnd);
      for (const [start, end] of segments) {
        const key = scanner.textWithoutComments(start, end)?.trim();
        if (!key) {
          continue;
        }
        const keyStart = scanner.skipTrivia(start)!;
        const keyEnd = this.trimKeyEnd(scanner, start, end);
        tokens.push({
          kind: command.name === 'label' ? 'label' : 'reference',
          command: command.name, key, commandStart: command.start,
          commandEnd: argument.end, keyStart, keyEnd
        });
      }
    }
    this.tokens = tokens;
  }

  /** Shares the command vocabulary with contexts for references being typed. */
  public static isReferenceCommand(name: string): boolean {
    return referenceCommands.has(name);
  }

  /** A command or brace of a multi-key reference selects its nearest key. */
  public tokenAt(offset: number): ReferenceToken | undefined {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.source.length) {
      return undefined;
    }
    let nearest: ReferenceToken | undefined;
    for (const token of this.tokens) {
      if (token.commandStart > offset) {
        break;
      }
      if (offset <= token.commandEnd
        && (!nearest || distanceFromKey(token, offset) < distanceFromKey(nearest, offset))) {
        nearest = token;
      }
    }
    return nearest;
  }

  private keySegments(scanner: SourceScanner, start: number, end: number): Array<readonly [number, number]> {
    const segments: Array<readonly [number, number]> = [];
    let segmentStart = start;
    let depth = 0;
    let commandIndex = lowerBound(scanner.commands, start, command => command.start);
    for (let cursor = start; cursor < end; cursor++) {
      const command = scanner.commands[commandIndex];
      if (command?.start === cursor) {
        cursor = command.end - 1;
        commandIndex++;
        continue;
      }
      const character = scanner.maskedSource[cursor];
      if (character === '{') {
        depth++;
      } else if (character === '}') {
        depth--;
      } else if (character === ',' && depth === 0) {
        segments.push([segmentStart, cursor]);
        segmentStart = cursor + 1;
      }
    }
    segments.push([segmentStart, end]);
    return segments;
  }

  private trimKeyEnd(scanner: SourceScanner, start: number, end: number): number {
    let ignoredIndex = lowerBound(scanner.ignoredRanges, end, range => range.start) - 1;
    while (end > start) {
      const ignored = scanner.ignoredRanges[ignoredIndex];
      if (ignored && ignored.start >= end) {
        ignoredIndex--;
      } else if (ignored?.kind === 'comment' && ignored.end >= end) {
        end = Math.max(start, ignored.start);
        ignoredIndex--;
      } else if (/\s/.test(this.source[end - 1])) {
        end--;
      } else {
        break;
      }
    }
    return end;
  }
}

function distanceFromKey(token: ReferenceToken, offset: number): number {
  return Math.max(token.keyStart - offset, offset - token.keyEnd, 0);
}

function lowerBound<T>(values: readonly T[], offset: number, position: (value: T) => number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (position(values[middle]) < offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}
