/** A half-open range in the original source, measured in UTF-16 code units. */
export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

/** The name excludes the leading backslash and any following star. */
export interface CommandToken extends SourceRange {
  readonly name: string;
}

export interface IgnoredRange extends SourceRange {
  readonly kind: 'comment' | 'inlineLiteral' | 'literalEnvironment';
  readonly contentStart: number;
  readonly contentEnd: number;
  readonly closed: boolean;
}

const literalEnvironments = new Set([
  'verbatim', 'verbatim*', 'Verbatim', 'Verbatim*',
  'BVerbatim', 'BVerbatim*', 'LVerbatim', 'LVerbatim*',
  'SaveVerbatim', 'SaveVerbatim*', 'VerbatimOut',
  'lstlisting', 'lstlisting*', 'minted', 'minted*', 'comment',
  'filecontents', 'filecontents*'
]);

interface EnvironmentName {
  readonly name: string;
  readonly end: number;
  readonly comments: readonly IgnoredRange[];
}

interface RawGroup extends SourceRange {
  readonly contentStart: number;
  readonly contentEnd: number;
  readonly closed: boolean;
}

/**
 * A lexical scan without macro expansion or catcode interpretation.
 * Comments and inline literals are masked in full; literal environment bodies
 * are masked while their begin/end commands remain available. Line endings and
 * UTF-16 offsets are preserved. The command list includes inline literal
 * introducers, but excludes commands within any ignored range's contents.
 * Macro definition bodies remain ordinary source for callers to interpret.
 */
export default class SourceScanner {
  public readonly source: string;
  public readonly maskedSource: string;
  public readonly commands: readonly CommandToken[];
  public readonly ignoredRanges: readonly IgnoredRange[];

  constructor(source: string) {
    this.source = source;
    const characters = source.split('');
    const commands: CommandToken[] = [];
    const ignoredRanges: IgnoredRange[] = [];
    const rawGroups = new RawGroupIndex(source);
    const ignore = (range: IgnoredRange): void => {
      ignoredRanges.push(range);
      for (let offset = range.start; offset < range.end; offset++) {
        if (source[offset] !== '\r' && source[offset] !== '\n') {
          characters[offset] = ' ';
        }
      }
    };

    for (let cursor = 0; cursor < source.length;) {
      if (source[cursor] === '%') {
        const range = readComment(source, cursor);
        ignore(range);
        cursor = range.end;
        continue;
      }
      if (source[cursor] !== '\\') {
        cursor++;
        continue;
      }

      // Every preceding command was consumed completely, so this backslash is
      // unescaped. Avoid rescanning runs of backslashes for each token.
      const command = readCommandUnchecked(source, cursor);
      commands.push(command);
      cursor = command.end;
      const inline = readInlineLiteral(source, command, rawGroups);
      if (inline) {
        ignore(inline);
        cursor = inline.end;
        continue;
      }
      if (command.name !== 'begin') {
        continue;
      }
      const environment = readEnvironmentName(source, cursor);
      if (!environment || !literalEnvironments.has(environment.name)) {
        continue;
      }
      for (const comment of environment.comments) {
        ignore(comment);
      }
      const closing = findEnvironmentEnd(source, environment.end, environment.name);
      const end = closing?.start ?? source.length;
      ignore({
        kind: 'literalEnvironment', start: environment.end, end,
        contentStart: environment.end, contentEnd: end, closed: closing !== undefined
      });
      cursor = end;
    }
    this.maskedSource = characters.join('');
    this.commands = commands;
    this.ignoredRanges = ignoredRanges;
  }

  /**
   * Skips whitespace and comments, stopping at literal text even when masked.
   * Invalid offsets return undefined; EOF is a valid stopping position.
   */
  public skipTrivia(offset: number): number | undefined {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.source.length) {
      return undefined;
    }
    while (offset < this.source.length) {
      const ignored = this.ignoredRanges[this.ignoredIndexAt(offset)];
      if (ignored && ignored.start <= offset) {
        if (ignored.kind !== 'comment') {
          return offset;
        }
        offset = ignored.end;
      } else if (/\s/.test(this.source[offset])) {
        offset++;
      } else {
        break;
      }
    }
    return offset;
  }

  /**
   * Returns source text with comments and their immediately following line
   * endings removed. Literal text and other whitespace are retained. Bounds are
   * half-open UTF-16 offsets; invalid ranges return undefined.
   */
  public textWithoutComments(start = 0, end = this.source.length): string | undefined {
    if (!Number.isInteger(start) || !Number.isInteger(end)
      || start < 0 || end < start || end > this.source.length) {
      return undefined;
    }
    const parts: string[] = [];
    let cursor = start;
    for (let index = this.ignoredIndexAt(start); index < this.ignoredRanges.length; index++) {
      const range = this.ignoredRanges[index];
      if (range.start >= end) {
        break;
      }
      if (range.kind !== 'comment') {
        continue;
      }
      parts.push(this.source.slice(cursor, Math.max(cursor, range.start)));
      let afterComment = range.end;
      if (this.source[afterComment] === '\r') {
        afterComment++;
      }
      if (this.source[afterComment] === '\n') {
        afterComment++;
      }
      cursor = Math.min(afterComment, end);
    }
    parts.push(this.source.slice(cursor, end));
    return parts.join('');
  }

  /** First ignored range whose end is strictly after the requested offset. */
  private ignoredIndexAt(offset: number): number {
    let low = 0;
    let high = this.ignoredRanges.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.ignoredRanges[middle].end <= offset) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }
}

/** Whether an odd run of backslashes immediately precedes this source offset. */
export function isEscaped(source: string, offset: number): boolean {
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length) {
    return false;
  }
  let start = offset;
  while (start > 0 && source[start - 1] === '\\') {
    start--;
  }
  return (offset - start) % 2 === 1;
}

/**
 * Reads a control word (ASCII letters and @) or one Unicode control symbol.
 * A trailing backslash is retained as an incomplete command with an empty name.
 * This helper does not decide whether the offset is inside a comment/literal.
 */
export function readCommand(source: string, start: number): CommandToken | undefined {
  if (!Number.isInteger(start) || start < 0 || start >= source.length
    || source[start] !== '\\' || isEscaped(source, start)) {
    return undefined;
  }
  return readCommandUnchecked(source, start);
}

function readCommandUnchecked(source: string, start: number): CommandToken {
  let end = start + 1;
  if (isCommandLetter(source[end])) {
    while (isCommandLetter(source[end])) {
      end++;
    }
  } else if (end < source.length) {
    end += codePointLength(source, end);
  }
  return { start, end, name: source.slice(start + 1, end) };
}

function isCommandLetter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z@]/.test(character);
}

function codePointLength(source: string, offset: number): number {
  return (source.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1;
}

function lineEnd(source: string, start: number): number {
  while (start < source.length && source[start] !== '\r' && source[start] !== '\n') {
    start++;
  }
  return start;
}

function readComment(source: string, start: number): IgnoredRange {
  const end = lineEnd(source, start);
  return {
    kind: 'comment', start, end, contentStart: start + 1,
    contentEnd: end, closed: true
  };
}

function skipWhitespace(source: string, start: number): number {
  while (start < source.length && /\s/.test(source[start])) {
    start++;
  }
  return start;
}

/** A simple environment name, allowing comments around and inside its group. */
function readEnvironmentName(source: string, start: number): EnvironmentName | undefined {
  const comments: IgnoredRange[] = [];
  let cursor = start;
  const skipTrivia = (): void => {
    cursor = skipWhitespace(source, cursor);
    while (source[cursor] === '%') {
      const comment = readComment(source, cursor);
      comments.push(comment);
      cursor = skipWhitespace(source, comment.end);
    }
  };
  skipTrivia();
  if (source[cursor] !== '{') {
    return undefined;
  }
  cursor++;
  let name = '';
  while (cursor < source.length && source[cursor] !== '}') {
    if (source[cursor] === '%') {
      const comment = readComment(source, cursor);
      comments.push(comment);
      cursor = comment.end;
      if (source[cursor] === '\r') {
        cursor++;
      }
      if (source[cursor] === '\n') {
        cursor++;
      }
    } else if (source[cursor] === '{' || source[cursor] === '\\') {
      return undefined;
    } else {
      name += source[cursor++];
    }
  }
  name = name.trim();
  return source[cursor] === '}' && name.length > 0 && !/\s/.test(name)
    ? { name, end: cursor + 1, comments }
    : undefined;
}

function findEnvironmentEnd(source: string, start: number, name: string): CommandToken | undefined {
  let cursor = source.indexOf('\\end', start);
  while (cursor !== -1) {
    // Literal environment contents have no ordinary escape or comment rules.
    const command = readCommandUnchecked(source, cursor);
    if (command.name === 'end' && readEnvironmentName(source, command.end)?.name === name) {
      return command;
    }
    cursor = source.indexOf('\\end', command.end);
  }
  return undefined;
}

function readInlineLiteral(source: string, command: CommandToken, rawGroups: RawGroupIndex): IgnoredRange | undefined {
  if (!['verb', 'Verb', 'lstinline', 'mintinline'].includes(command.name)) {
    return undefined;
  }
  let cursor = source[command.end] === '*' ? command.end + 1 : command.end;
  if (command.name !== 'verb') {
    cursor = skipInlineWhitespace(source, cursor);
    if (source[cursor] === '[') {
      const optional = rawGroups.read(cursor);
      if (!optional.closed) {
        return undefined;
      }
      cursor = skipInlineWhitespace(source, optional.end);
    }
  }
  if (command.name === 'mintinline') {
    if (source[cursor] !== '{') {
      return undefined;
    }
    const language = rawGroups.read(cursor);
    if (!language.closed) {
      return undefined;
    }
    cursor = skipInlineWhitespace(source, language.end);
  }
  // An unfinished option/language argument has not started literal contents.
  // Once a delimiter has started, an unfinished literal ends at the next line.
  if ((command.name === 'lstinline' || command.name === 'mintinline') && source[cursor] === '{') {
    return { kind: 'inlineLiteral', ...rawGroups.read(cursor), start: command.start };
  }
  if (cursor >= source.length || /\s/.test(source[cursor])) {
    return undefined;
  }
  const delimiterLength = codePointLength(source, cursor);
  const delimiter = source.slice(cursor, cursor + delimiterLength);
  const contentStart = cursor + delimiterLength;
  let end = contentStart;
  while (end < source.length && source[end] !== '\r' && source[end] !== '\n'
    && !source.startsWith(delimiter, end)) {
    end += codePointLength(source, end);
  }
  const contentEnd = end;
  const closed = source.startsWith(delimiter, end);
  if (closed) {
    end += delimiterLength;
  }
  return { kind: 'inlineLiteral', start: command.start, end, contentStart, contentEnd, closed };
}

function skipInlineWhitespace(source: string, start: number): number {
  while (start < source.length && source[start] !== '\r' && source[start] !== '\n' && /\s/.test(source[start])) {
    start++;
  }
  return start;
}

/**
 * Raw groups treat percent signs literally and recover at the next line ending.
 * Index each requested line once: many unfinished inline introducers on one line
 * must not each rescan its remaining contents. Braces shield bracket delimiters.
 */
class RawGroupIndex {
  private readonly groups = new Map<number, RawGroup>();

  constructor(private readonly source: string) { }

  public read(start: number): RawGroup {
    let group = this.groups.get(start);
    if (!group) {
      this.indexLine(start);
      group = this.groups.get(start);
    }
    // Callers only request an unescaped opening brace/bracket following an
    // inline command or an already completed inline option/language argument.
    return group!;
  }

  private indexLine(start: number): void {
    const source = this.source;
    let lineStart = start;
    while (lineStart > 0 && source[lineStart - 1] !== '\r' && source[lineStart - 1] !== '\n') {
      lineStart--;
    }
    const end = lineEnd(source, start);
    const tokens: { start: number; character: string }[] = [];
    for (let cursor = lineStart; cursor < end;) {
      const character = source[cursor];
      tokens.push({ start: cursor, character });
      cursor++;
      if (character === '\\' && cursor < end) {
        cursor += codePointLength(source, cursor);
      }
    }

    const braces: number[] = [];
    const closingBraces = new Map<number, number>();
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.character === '{') {
        braces.push(index);
      } else if (token.character === '}' && braces.length > 0) {
        const opening = braces.pop()!;
        closingBraces.set(opening, index);
        this.record(tokens[opening].start, token.start);
      }
    }
    for (const opening of braces) {
      this.record(tokens[opening].start, undefined, end);
    }

    // nextClosing[i] is the first unshielded closing bracket seen from token i.
    // A completed nested group jumps to the answer after that group. Computing
    // backwards also handles bracket openers inside braces independently.
    const nextClosing: (number | undefined)[] = new Array(tokens.length + 1);
    for (let index = tokens.length - 1; index >= 0; index--) {
      const token = tokens[index];
      if (token.character === ']') {
        nextClosing[index] = index;
      } else if (token.character === '[') {
        const closing = nextClosing[index + 1];
        this.record(token.start, closing === undefined ? undefined : tokens[closing].start, end);
        nextClosing[index] = closing === undefined ? undefined : nextClosing[closing + 1];
      } else if (token.character === '{') {
        const closing = closingBraces.get(index);
        nextClosing[index] = closing === undefined ? undefined : nextClosing[closing + 1];
      } else {
        nextClosing[index] = nextClosing[index + 1];
      }
    }
  }

  private record(start: number, closing: number | undefined, lineEnd = this.source.length): void {
    this.groups.set(start, {
      start, end: closing === undefined ? lineEnd : closing + 1,
      contentStart: start + 1, contentEnd: closing ?? lineEnd, closed: closing !== undefined
    });
  }
}
