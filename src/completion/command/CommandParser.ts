export interface CommandContext {
  query: string;
  start: number;
}

export interface CustomCommandDefinition {
  name: string;
  argumentCount: number;
  optionalFirstArgument: boolean;
  line: number;
}

/** Finds the control-word fragment immediately before the cursor. */
export function findCommandContext(linePrefix: string, lineOffset = 0): CommandContext | undefined {
  const match = /\\([A-Za-z@]*\*?)$/.exec(linePrefix);
  if (!match || isEscapedBackslash(linePrefix, match.index) || isInsideComment(linePrefix, match.index)) {
    return undefined;
  }
  return { query: match[1], start: lineOffset + match.index };
}

/** Extracts classic and xparse command declarations from uncommented source. */
export function findCustomCommands(source: string): CustomCommandDefinition[] {
  const masked = maskComments(source);
  const lineOffsets = makeLineOffsets(source);
  const commands = new Map<string, CustomCommandDefinition>();
  const classic = /\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand)\*?\s*(?:\{\s*\\([A-Za-z@]+)\s*\}|\\([A-Za-z@]+))\s*(?:\[(\d+)\])?\s*(?:\[[^\]]*\])?/g;
  const xparse = /\\(?:NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclareDocumentCommand)\s*(?:\{\s*\\([A-Za-z@]+)\s*\}|\\([A-Za-z@]+))/g;

  for (const match of masked.matchAll(classic)) {
    const name = match[1] ?? match[2];
    const argumentCount = Number.parseInt(match[3] ?? '0', 10);
    const declaration = match[0];
    const argumentCountEnd = match[3] ? declaration.indexOf(`[${match[3]}]`) + match[3].length + 2 : -1;
    const optionalFirstArgument = argumentCount > 0 && argumentCountEnd >= 0 && /^\s*\[/.test(declaration.slice(argumentCountEnd));
    commands.set(name, {
      name,
      argumentCount,
      optionalFirstArgument,
      line: lineAtOffset(lineOffsets, match.index)
    });
  }

  // xparse argument specifications can encode delimiters and processors. Listing
  // the command without guessing a snippet is safer than inserting wrong braces.
  for (const match of masked.matchAll(xparse)) {
    const name = match[1] ?? match[2];
    commands.set(name, {
      name,
      argumentCount: 0,
      optionalFirstArgument: false,
      line: lineAtOffset(lineOffsets, match.index)
    });
  }

  return [...commands.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function makeLineOffsets(source: string): number[] {
  const offsets = [0];
  for (let offset = 0; offset < source.length; offset++) {
    if (source[offset] === '\n') {
      offsets.push(offset + 1);
    }
  }
  return offsets;
}

function lineAtOffset(offsets: readonly number[], offset: number): number {
  let low = 0;
  let high = offsets.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle] <= offset) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return low;
}

function isInsideComment(line: string, commandOffset: number): boolean {
  for (let offset = 0; offset < commandOffset; offset++) {
    if (line[offset] === '%' && !isEscapedBackslash(line, offset)) {
      return true;
    }
  }
  return false;
}

function maskComments(source: string): string {
  let result = '';
  let inComment = false;
  let slashCount = 0;
  for (const char of source) {
    if (inComment) {
      if (char === '\r' || char === '\n') {
        inComment = false;
        result += char;
      } else {
        result += ' ';
      }
      continue;
    }
    if (char === '%' && slashCount % 2 === 0) {
      inComment = true;
      result += ' ';
      slashCount = 0;
      continue;
    }
    result += char;
    slashCount = char === '\\' ? slashCount + 1 : 0;
  }
  return result;
}

function isEscapedBackslash(source: string, offset: number): boolean {
  let slashCount = 0;
  for (let cursor = offset - 1; cursor >= 0 && source[cursor] === '\\'; cursor--) {
    slashCount++;
  }
  return slashCount % 2 === 1;
}
