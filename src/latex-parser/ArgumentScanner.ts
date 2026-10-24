import SourceScanner from './SourceScanner';
import type { SourceRange } from './SourceScanner';

export type ArgumentOpening = '{' | '[';

/** All offsets refer to the original source; end and contentEnd are exclusive. */
export interface ScannedArgument extends SourceRange {
  readonly opening: ArgumentOpening;
  readonly contentStart: number;
  readonly contentEnd: number;
  readonly complete: boolean;
}

/** An absent star has an empty range at the first position after trivia. */
export interface ScannedStar extends SourceRange {
  readonly starred: boolean;
}

/**
 * Indexes argument delimiters in one pass over an immutable source snapshot.
 * Braces protect closing brackets in optional arguments. Nested brackets are
 * balanced at the same brace depth; unmatched brackets do not prevent a brace
 * argument from closing. Commands and literal contents do not supply delimiters.
 */
export default class ArgumentScanner {
  private readonly scanner: SourceScanner;
  private readonly openings = new Set<number>();
  private readonly closings = new Map<number, number>();

  public constructor(source: string | SourceScanner) {
    this.scanner = typeof source === 'string' ? new SourceScanner(source) : source;
    const braces: number[] = [];
    const brackets: number[][] = [[]];
    const { maskedSource, commands } = this.scanner;
    let commandIndex = 0;
    for (let offset = 0; offset < maskedSource.length; offset++) {
      while (commandIndex < commands.length && commands[commandIndex].start < offset) {
        commandIndex++;
      }
      const command = commands[commandIndex];
      if (command?.start === offset) {
        offset = command.end - 1;
        commandIndex++;
        continue;
      }
      const character = maskedSource[offset];
      if (character === '{') {
        this.openings.add(offset);
        braces.push(offset);
        brackets.push([]);
      } else if (character === '}' && braces.length > 0) {
        this.closings.set(braces.pop()!, offset);
        brackets.pop();
      } else if (character === '[') {
        this.openings.add(offset);
        brackets[brackets.length - 1].push(offset);
      } else if (character === ']') {
        const opening = brackets[brackets.length - 1].pop();
        if (opening !== undefined) {
          this.closings.set(opening, offset);
        }
      }
    }
  }

  /**
   * Reads a brace argument (or an optional bracket argument) after whitespace
   * and comments. Missing openers and invalid offsets return undefined. An
   * unclosed argument ends at EOF with complete:false; other indexed arguments
   * remain independently readable so callers can recover while editing.
   */
  public readArgument(offset: number, opening: ArgumentOpening = '{'): ScannedArgument | undefined {
    if (!this.validOffset(offset)) {
      return undefined;
    }
    const start = this.skipTrivia(offset);
    if (this.scanner.source[start] !== opening || !this.openings.has(start)) {
      return undefined;
    }
    const closing = this.closings.get(start);
    return {
      opening,
      start,
      end: closing === undefined ? this.scanner.source.length : closing + 1,
      contentStart: start + 1,
      contentEnd: closing ?? this.scanner.source.length,
      complete: closing !== undefined
    };
  }

  /** Reads an optional star after trivia, without consuming following trivia. */
  public readStar(offset: number): ScannedStar | undefined {
    if (!this.validOffset(offset)) {
      return undefined;
    }
    const start = this.skipTrivia(offset);
    const starred = this.scanner.maskedSource[start] === '*' && !this.insideCommand(start);
    return { starred, start, end: starred ? start + 1 : start };
  }

  private validOffset(offset: number): boolean {
    return Number.isInteger(offset) && offset >= 0 && offset <= this.scanner.source.length;
  }

  /** Literal text is never treated as trivia, even when it has been masked. */
  private skipTrivia(offset: number): number {
    const { source, ignoredRanges } = this.scanner;
    while (offset < source.length) {
      let low = 0;
      let high = ignoredRanges.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (ignoredRanges[middle].end <= offset) {
          low = middle + 1;
        } else {
          high = middle;
        }
      }
      const ignored = ignoredRanges[low];
      if (ignored && ignored.start <= offset) {
        if (ignored.kind !== 'comment') {
          return offset;
        }
        offset = ignored.end;
      } else if (/\s/.test(source[offset])) {
        offset++;
      } else {
        break;
      }
    }
    return offset;
  }

  private insideCommand(offset: number): boolean {
    const { commands } = this.scanner;
    let low = 0;
    let high = commands.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (commands[middle].end <= offset) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const command = commands[low];
    return command !== undefined && command.start <= offset;
  }
}
