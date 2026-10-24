/** Source offsets are UTF-16 offsets, matching VS Code's document offsets. */
export type StructureEvent =
  | { type: 'heading'; command: string; title: string; level: number; start: number; end: number }
  | { type: 'begin'; name: string; title?: string; start: number; end: number }
  | { type: 'end'; name: string; start: number; end: number }
  | { type: 'label'; key: string; start: number; end: number }
  | { type: 'caption'; title: string; start: number; end: number }
  | { type: 'include'; command: 'input' | 'include'; path: string; start: number; end: number }
  | { type: 'theoremDefinition'; name: string; title: string; start: number; end: number };

const headingLevels = new Map([
  ['part', 0], ['chapter', 1], ['section', 2], ['subsection', 3],
  ['subsubsection', 4], ['paragraph', 5], ['subparagraph', 6]
]);

const literalEnvironments = new Set([
  'verbatim', 'verbatim*', 'Verbatim', 'Verbatim*', 'BVerbatim', 'LVerbatim',
  'SaveVerbatim', 'lstlisting', 'lstlisting*', 'minted', 'minted*', 'comment',
  'filecontents', 'filecontents*'
]);
const displayEquationEnvironments = new Set([
  'equation', 'align', 'alignat', 'gather', 'multline', 'flalign', 'displaymath'
]);

const commandDefinitions = new Set([
  'newcommand', 'renewcommand', 'providecommand', 'DeclareRobustCommand', 'DeclareMathOperator'
]);
const documentCommandDefinitions = new Set([
  'NewDocumentCommand', 'RenewDocumentCommand', 'ProvideDocumentCommand', 'DeclareDocumentCommand',
  'NewExpandableDocumentCommand', 'RenewExpandableDocumentCommand',
  'ProvideExpandableDocumentCommand', 'DeclareExpandableDocumentCommand'
]);
const environmentDefinitions = new Set(['newenvironment', 'renewenvironment']);
const documentEnvironmentDefinitions = new Set([
  'NewDocumentEnvironment', 'RenewDocumentEnvironment', 'ProvideDocumentEnvironment', 'DeclareDocumentEnvironment'
]);
const primitiveDefinitions = new Set(['def', 'gdef', 'edef', 'xdef']);

interface Command { name: string; end: number }
interface Group { start: number; end: number; contentStart: number; contentEnd: number }
interface TitleArgument { start: number; end: number; contentStart: number; contentEnd: number }
interface InlineLiteral { contentStart: number; contentEnd: number; end: number }

/** A lexical structure reader; it deliberately does not expand user macros. */
export function parseStructureEvents(source: string): StructureEvent[] {
  const masked = maskIgnoredSource(source);
  const groups = matchGroups(masked);
  const events: StructureEvent[] = [];
  let cursor = 0;
  let displayDollars = false;
  let inlineDollar = false;

  while (cursor < masked.length) {
    if (masked[cursor] === '$') {
      if (masked[cursor + 1] === '$' && !inlineDollar) {
        events.push({ type: displayDollars ? 'end' : 'begin', name: '$$', start: cursor, end: cursor + 2 });
        displayDollars = !displayDollars;
        cursor += 2;
      } else {
        if (!displayDollars) {
          inlineDollar = !inlineDollar;
        }
        cursor++;
      }
      continue;
    }
    if (masked[cursor] !== '\\') {
      cursor++;
      continue;
    }

    const start = cursor;
    const command = readCommand(masked, start);
    cursor = command.end;
    const level = headingLevels.get(command.name);
    if (level !== undefined) {
      const title = readTitle(masked, command.end, groups);
      if (title) {
        events.push({
          type: 'heading', command: command.name, level,
          title: structurePlainText(source.slice(title.contentStart, title.contentEnd)),
          start, end: title.end
        });
        collectTitleEvents(source, masked, groups, command.end, title.end, events);
        cursor = title.end;
      }
      continue;
    }

    if (command.name === '[' || command.name === ']') {
      events.push({ type: command.name === '[' ? 'begin' : 'end', name: '\\[', start, end: command.end });
      continue;
    }
    if (command.name === 'begin' || command.name === 'end') {
      const group = readGroup(masked, command.end, groups);
      if (!group) {
        continue;
      }
      const name = masked.slice(group.contentStart, group.contentEnd).trim();
      if (!name || /[\\{}\s]/.test(name)) {
        continue;
      }
      cursor = group.end;
      if (command.name === 'end') {
        events.push({ type: 'end', name, start, end: cursor });
      } else {
        // A leading interval is equation content, rather than a theorem title.
        const optional = displayEquationEnvironments.has(name.replace(/\*$/, ''))
          ? undefined
          : readGroup(masked, cursor, groups, '[');
        const title = optional ? structurePlainText(source.slice(optional.contentStart, optional.contentEnd)) : undefined;
        cursor = optional?.end ?? cursor;
        events.push({ type: 'begin', name, title, start, end: cursor });
        if (optional) {
          collectTitleEvents(source, masked, groups, optional.contentStart, optional.contentEnd, events);
        }
      }
      continue;
    }
    if (command.name === 'label') {
      const group = readGroup(masked, command.end, groups);
      if (group) {
        const key = masked.slice(group.contentStart, group.contentEnd).trim();
        if (key) {
          events.push({ type: 'label', key, start, end: group.end });
        }
        cursor = group.end;
      }
      continue;
    }
    if (command.name === 'caption') {
      const title = readTitle(masked, command.end, groups);
      if (title) {
        events.push({ type: 'caption', title: structurePlainText(source.slice(title.contentStart, title.contentEnd)), start, end: title.end });
        collectTitleEvents(source, masked, groups, command.end, title.end, events);
        cursor = title.end;
      }
      continue;
    }
    if (command.name === 'input' || command.name === 'include') {
      const group = readGroup(masked, command.end, groups);
      const pathStart = group?.contentStart ?? skipWhitespace(masked, command.end);
      let pathEnd = group?.contentEnd ?? pathStart;
      if (!group && masked[pathStart] !== '{') {
        while (pathEnd < masked.length && !/[\s%\\{}]/.test(masked[pathEnd])) {
          pathEnd++;
        }
      }
      const path = masked.slice(pathStart, pathEnd).trim();
      if (path && !/[\\#${}]/.test(path)) {
        cursor = group?.end ?? pathEnd;
        events.push({ type: 'include', command: command.name, path, start, end: cursor });
      }
      continue;
    }
    if (command.name === 'newtheorem') {
      let position = skipStar(masked, command.end);
      const name = readGroup(masked, position, groups);
      if (!name) {
        continue;
      }
      position = readGroup(masked, name.end, groups, '[')?.end ?? name.end;
      const title = readGroup(masked, position, groups);
      if (title) {
        cursor = readGroup(masked, title.end, groups, '[')?.end ?? title.end;
        events.push({
          type: 'theoremDefinition', name: masked.slice(name.contentStart, name.contentEnd).trim(),
          title: structurePlainText(source.slice(title.contentStart, title.contentEnd)), start, end: cursor
        });
      }
      continue;
    }
    cursor = skipDefinition(masked, command, groups) ?? cursor;
  }
  return events;
}

/** Normalizes display text without erasing unknown commands such as math macros. */
export function structurePlainText(source: string): string {
  const groups = matchGroups(maskIgnoredSource(source));
  const formatting = /^(?:text(?:bf|it|sl|sc|sf|tt|rm|up|normal)|emph|underline|mbox|ensuremath|bfseries|itshape|slshape|scshape|sffamily|ttfamily|rmfamily|normalfont|protect)$/;
  const braces: boolean[] = [];
  let result = '';
  let cursor = 0;
  let math = false;
  let preserveNextGroup = false;
  let stripNextGroup = false;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === '%') {
      cursor = commentEnd(source, cursor);
      result += ' ';
      continue;
    }
    if (character === '\\') {
      const command = readCommand(source, cursor);
      const literal = readInlineLiteral(source, command);
      if (literal) {
        result += source.slice(literal.contentStart, literal.contentEnd);
        cursor = literal.end;
        continue;
      }
      if (command.name === 'label') {
        cursor = readGroup(source, command.end, groups)?.end ?? command.end;
        continue;
      }
      if (formatting.test(command.name)) {
        cursor = command.end;
        preserveNextGroup = false;
        stripNextGroup = true;
        continue;
      }
      if (command.name === 'LaTeX' || command.name === 'TeX') {
        result += command.name;
        cursor = command.end;
        continue;
      }
      if (/^[%&_#$ {}]$/.test(command.name)) {
        result += command.name;
        cursor = command.end;
        preserveNextGroup = false;
        continue;
      }
      if (command.name === '\\' || /^[,;:!>]$/.test(command.name) || command.name === 'quad' || command.name === 'qquad') {
        result += ' ';
        cursor = command.end;
        continue;
      }
      if (/^["'`^~=.uvHckbdtr]$/.test(command.name)) {
        const next = skipWhitespace(source, command.end);
        const group = readGroup(source, next, groups);
        if (group && group.contentEnd - group.contentStart === 1) {
          result += source[group.contentStart];
          cursor = group.end;
          continue;
        }
        if (/[A-Za-z]/.test(source[next] ?? '')) {
          result += source[next];
          cursor = next + 1;
          continue;
        }
      }
      if (command.name === '(' || command.name === '[') {
        math = true;
      } else if (command.name === ')' || command.name === ']') {
        math = false;
      }
      result += source.slice(cursor, command.end);
      preserveNextGroup = true;
      stripNextGroup = false;
      cursor = command.end;
      continue;
    }
    if (character === '{') {
      const preserve = !stripNextGroup && (math || preserveNextGroup);
      braces.push(preserve);
      if (preserve) {
        result += character;
      }
      preserveNextGroup = false;
      stripNextGroup = false;
    } else if (character === '}') {
      const preserve = braces.pop() ?? false;
      if (preserve) {
        result += character;
      }
      preserveNextGroup = preserve;
    } else {
      if (character === '$') {
        math = !math;
        if (source[cursor + 1] === '$') {
          result += '$';
          cursor++;
        }
      }
      result += character === '~' ? ' ' : character;
      if (!/\s/.test(character)) {
        preserveNextGroup = false;
        stripNextGroup = false;
      }
    }
    cursor++;
  }
  return result.replace(/\s+/g, ' ').trim();
}

export function isStructureTrivia(source: string): boolean {
  return maskComments(source).trim().length === 0;
}

function collectTitleEvents(source: string, masked: string, groups: Map<number, number>, start: number, end: number, events: StructureEvent[]): void {
  for (let cursor = start; cursor < end;) {
    if (masked[cursor] !== '\\') {
      cursor++;
      continue;
    }
    const commandStart = cursor;
    const command = readCommand(masked, cursor);
    cursor = command.end;
    if (command.name === 'label') {
      const group = readGroup(masked, cursor, groups);
      if (group && group.end <= end) {
        const key = masked.slice(group.contentStart, group.contentEnd).trim();
        if (key) {
          events.push({ type: 'label', key, start: commandStart, end: group.end });
        }
        cursor = group.end;
      }
    } else if (command.name === 'caption') {
      const title = readTitle(masked, cursor, groups);
      if (title && title.end <= end) {
        events.push({ type: 'caption', title: structurePlainText(source.slice(title.contentStart, title.contentEnd)), start: commandStart, end: title.end });
      }
    } else {
      cursor = skipDefinition(masked, command, groups) ?? cursor;
    }
  }
}

function readCommand(source: string, start: number): Command {
  let end = start + 1;
  if (/[A-Za-z@]/.test(source[end] ?? '')) {
    while (end < source.length && /[A-Za-z@]/.test(source[end])) {
      end++;
    }
  } else if (end < source.length) {
    end++;
  }
  return { name: source.slice(start + 1, end), end };
}

function skipWhitespace(source: string, start: number): number {
  while (start < source.length && /\s/.test(source[start])) {
    start++;
  }
  return start;
}

function skipStar(source: string, start: number): number {
  const cursor = skipWhitespace(source, start);
  return skipWhitespace(source, source[cursor] === '*' ? cursor + 1 : cursor);
}

function readGroup(source: string, start: number, groups: Map<number, number>, opening = '{'): Group | undefined {
  start = skipWhitespace(source, start);
  const closing = groups.get(start);
  if (source[start] !== opening || closing === undefined) {
    return undefined;
  }
  return { start, end: closing + 1, contentStart: start + 1, contentEnd: closing };
}

function readTitle(source: string, start: number, groups: Map<number, number>): TitleArgument | undefined {
  let cursor = skipStar(source, start);
  if (source[cursor] === '[') {
    const optional = readGroup(source, cursor, groups, '[');
    if (!optional) {
      return undefined;
    }
    cursor = optional.end;
  }
  return readGroup(source, cursor, groups);
}

/** Precomputing pairs lets incomplete arguments recover without repeated scans to EOF. */
function matchGroups(source: string): Map<number, number> {
  const pairs = new Map<number, number>();
  const braces: number[] = [];
  const brackets: number[][] = [[]];
  for (let cursor = 0; cursor < source.length; cursor++) {
    const character = source[cursor];
    if (character === '\\') {
      cursor = readCommand(source, cursor).end - 1;
    } else if (character === '{') {
      braces.push(cursor);
      brackets.push([]);
    } else if (character === '}' && braces.length > 0) {
      pairs.set(braces.pop()!, cursor);
      brackets.pop();
    } else if (character === '[') {
      brackets[brackets.length - 1].push(cursor);
    } else if (character === ']') {
      const opening = brackets[brackets.length - 1].pop();
      if (opening !== undefined) {
        pairs.set(opening, cursor);
      }
    }
  }
  return pairs;
}

function skipDefinition(source: string, command: Command, groups: Map<number, number>): number | undefined {
  const primitive = primitiveDefinitions.has(command.name);
  const ordinary = commandDefinitions.has(command.name);
  const documentCommand = documentCommandDefinitions.has(command.name);
  const environment = environmentDefinitions.has(command.name);
  const documentEnvironment = documentEnvironmentDefinitions.has(command.name);
  if (!primitive && !ordinary && !documentCommand && !environment && !documentEnvironment) {
    return undefined;
  }
  let cursor = skipStar(source, command.end);
  const name = readGroup(source, cursor, groups);
  if (name) {
    cursor = name.end;
  } else if (source[cursor] === '\\') {
    cursor = readCommand(source, cursor).end;
  } else {
    return cursor;
  }
  if (primitive) {
    while (cursor < source.length && source[cursor] !== '{' && source[cursor] !== '\\') {
      cursor++;
    }
    return readGroup(source, cursor, groups)?.end ?? cursor;
  }
  if (ordinary || environment) {
    for (let argument = 0; argument < 2; argument++) {
      cursor = readGroup(source, cursor, groups, '[')?.end ?? cursor;
    }
  }
  const count = documentCommand ? 2 : documentEnvironment ? 3 : environment ? 2 : 1;
  for (let argument = 0; argument < count; argument++) {
    const group = readGroup(source, cursor, groups);
    if (!group) {
      break;
    }
    cursor = group.end;
  }
  return cursor;
}

function commentEnd(source: string, start: number): number {
  while (start < source.length && source[start] !== '\r' && source[start] !== '\n') {
    start++;
  }
  return start;
}

function maskComments(source: string): string {
  const characters = source.split('');
  for (let cursor = 0; cursor < source.length;) {
    if (source[cursor] === '\\') {
      cursor = readCommand(source, cursor).end;
    } else if (source[cursor] === '%') {
      const end = commentEnd(source, cursor);
      characters.fill(' ', cursor, end);
      cursor = end;
    } else {
      cursor++;
    }
  }
  return characters.join('');
}

function maskIgnoredSource(source: string): string {
  const characters = source.split('');
  const mask = (start: number, end: number): void => {
    for (let cursor = start; cursor < end; cursor++) {
      if (source[cursor] !== '\r' && source[cursor] !== '\n') {
        characters[cursor] = ' ';
      }
    }
  };
  const environmentName = /\s*\{\s*([^{}\s]+)\s*\}/y;
  for (let cursor = 0; cursor < source.length;) {
    if (source[cursor] === '%') {
      const end = commentEnd(source, cursor);
      mask(cursor, end);
      cursor = end;
      continue;
    }
    if (source[cursor] !== '\\') {
      cursor++;
      continue;
    }
    const start = cursor;
    const command = readCommand(source, cursor);
    cursor = command.end;
    const literal = readInlineLiteral(source, command);
    if (literal) {
      mask(start, literal.end);
      cursor = literal.end;
    } else if (command.name === 'begin') {
      let nameStart = skipWhitespace(source, cursor);
      while (source[nameStart] === '%') {
        const end = commentEnd(source, nameStart);
        mask(nameStart, end);
        nameStart = skipWhitespace(source, end);
      }
      environmentName.lastIndex = nameStart;
      const match = environmentName.exec(source);
      if (match && literalEnvironments.has(match[1])) {
        const openingEnd = environmentName.lastIndex;
        const escapedName = match[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const closing = new RegExp(`\\\\end\\s*\\{\\s*${escapedName}\\s*\\}`, 'g');
        closing.lastIndex = openingEnd;
        const end = closing.exec(source);
        mask(openingEnd, end?.index ?? source.length);
        cursor = end ? closing.lastIndex : source.length;
      }
    }
  }
  return characters.join('');
}

function readInlineLiteral(source: string, command: Command): InlineLiteral | undefined {
  if (command.name !== 'verb' && command.name !== 'Verb' && command.name !== 'lstinline' && command.name !== 'mintinline') {
    return undefined;
  }
  let cursor = source[command.end] === '*' ? command.end + 1 : command.end;
  if (command.name !== 'verb') {
    cursor = skipWhitespace(source, cursor);
    if (source[cursor] === '[') {
      const optionalEnd = rawGroupEnd(source, cursor, '[', ']');
      if (optionalEnd === undefined) {
        return undefined;
      }
      cursor = skipWhitespace(source, optionalEnd);
    }
  }
  if (command.name === 'mintinline') {
    const languageEnd = source[cursor] === '{' ? rawGroupEnd(source, cursor) : undefined;
    if (languageEnd === undefined) {
      return undefined;
    }
    cursor = skipWhitespace(source, languageEnd);
  }
  if ((command.name === 'lstinline' || command.name === 'mintinline') && source[cursor] === '{') {
    const end = rawGroupEnd(source, cursor);
    return end === undefined ? undefined : { contentStart: cursor + 1, contentEnd: end - 1, end };
  }
  if (cursor >= source.length || /\s/.test(source[cursor])) {
    return undefined;
  }
  let end = cursor + 1;
  while (end < source.length && source[end] !== source[cursor] && source[end] !== '\r' && source[end] !== '\n') {
    end++;
  }
  const contentEnd = end;
  if (source[end] === source[cursor]) {
    end++;
  }
  return { contentStart: cursor + 1, contentEnd, end };
}

/** Raw code arguments have literal percent characters, so comment rules do not apply. */
function rawGroupEnd(source: string, start: number, opening = '{', closing = '}'): number | undefined {
  let depth = 1;
  for (let cursor = start + 1; cursor < source.length; cursor++) {
    if (source[cursor] === '\\') {
      cursor++;
    } else if (source[cursor] === opening) {
      depth++;
    } else if (source[cursor] === closing && --depth === 0) {
      return cursor + 1;
    }
  }
  return undefined;
}
