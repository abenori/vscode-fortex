import * as LaTeXParser from '../latex-parser';

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
const displayEquationEnvironments = new Set([
  'equation', 'align', 'alignat', 'gather', 'multline', 'flalign', 'displaymath'
]);

/** Builds outline events from shared syntax, without expanding user macros. */
export function parseStructureEvents(source: string): StructureEvent[] {
  const scanner = new LaTeXParser.SourceScanner(source);
  const argumentsScanner = new LaTeXParser.ArgumentScanner(scanner);
  const definitionParser = new LaTeXParser.DefinitionParser(scanner);
  const definitions = definitionParser.definitions;
  // Completed definitions are hidden; partial bodies permit later recovery.
  const hidden = mergeRanges(definitionParser.consumedRanges);
  const commands = new Map(scanner.commands.map(command => [command.start, command]));
  const labels = new Map(new LaTeXParser.ReferenceParser(scanner).tokens
    .filter(token => token.kind === 'label').map(token => [token.commandStart, token]));
  const includes = new Map(new LaTeXParser.DocumentParser(scanner).declarations
    .filter(declaration => declaration.kind === 'include' && declaration.complete)
    .map(declaration => [declaration.start, declaration]));
  const titles = new Map<number, LaTeXParser.ScannedArgument>();
  const environmentTitles = new Map<number, LaTeXParser.ScannedArgument>();
  const mathExcluded = [...hidden];
  for (const command of scanner.commands) {
    if (rangeEndAt(hidden, command.start) !== undefined) { continue; }
    if (headingLevels.has(command.name) || command.name === 'caption') {
      const title = readTitle(argumentsScanner, command.end);
      if (title) {
        titles.set(command.start, title);
        mathExcluded.push({ start: command.end, end: title.end });
      }
    } else if (command.name === 'begin') {
      const nameArgument = argumentsScanner.readArgument(command.end);
      if (!nameArgument?.complete) { continue; }
      const name = scanner.textWithoutComments(nameArgument.contentStart, nameArgument.contentEnd)?.trim() ?? '';
      if (!displayEquationEnvironments.has(name.replace(/\*$/, ''))) {
        const title = argumentsScanner.readArgument(nameArgument.end, '[');
        if (title?.complete) {
          environmentTitles.set(command.start, title);
          mathExcluded.push({ start: title.start, end: title.end });
        }
      }
    }
  }
  // Skipped argument contents must not affect later dollar-delimiter state.
  const environments = new Map(new LaTeXParser.EnvironmentParser(scanner, mathExcluded).tokens
    .map(token => [token.start, token]));
  const events: StructureEvent[] = definitions
    .filter(definition => definition.kind === 'theorem' && definition.complete)
    .map(definition => ({
      type: 'theoremDefinition', name: definition.name,
      title: structurePlainText(definition.title ?? ''), start: definition.start, end: definition.end
    }));

  const collectTitleEvents = (start: number, end: number): void => {
    for (let cursor = start; cursor < end;) {
      const hiddenEnd = rangeEndAt(hidden, cursor);
      if (hiddenEnd !== undefined) {
        cursor = hiddenEnd;
        continue;
      }
      const command = commands.get(cursor);
      if (!command || scanner.maskedSource[cursor] !== '\\') {
        cursor++;
        continue;
      }
      const label = labels.get(cursor);
      if (label && label.commandEnd <= end) {
        events.push({ type: 'label', key: label.key, start: cursor, end: label.commandEnd });
        cursor = label.commandEnd;
        continue;
      }
      if (command.name === 'caption') {
        const title = titles.get(cursor);
        if (title && title.end <= end) {
          events.push({
            type: 'caption', title: structurePlainText(source.slice(title.contentStart, title.contentEnd)),
            start: cursor, end: title.end
          });
        }
      }
      cursor = command.end;
    }
  };

  for (let cursor = 0; cursor < source.length;) {
    const hiddenEnd = rangeEndAt(hidden, cursor);
    if (hiddenEnd !== undefined) {
      cursor = hiddenEnd;
      continue;
    }
    const environment = environments.get(cursor);
    if (environment) {
      const start = cursor;
      cursor = environment.end;
      if (environment.style === 'named' || environment.style === 'display' || environment.style === 'doubleDollar') {
        if (environment.kind === 'end') {
          events.push({ type: 'end', name: environment.name, start, end: cursor });
        } else {
          const title = environmentTitles.get(start);
          cursor = title?.end ?? cursor;
          events.push({
            type: 'begin', name: environment.name, start, end: cursor,
            ...(title ? { title: structurePlainText(source.slice(title.contentStart, title.contentEnd)) } : {})
          });
          if (title) { collectTitleEvents(title.contentStart, title.contentEnd); }
        }
      }
      continue;
    }
    const command = commands.get(cursor);
    if (!command || scanner.maskedSource[cursor] !== '\\') {
      cursor++;
      continue;
    }
    const start = cursor;
    cursor = command.end;
    const title = titles.get(start);
    const level = headingLevels.get(command.name);
    if (title && (level !== undefined || command.name === 'caption')) {
      const text = structurePlainText(source.slice(title.contentStart, title.contentEnd));
      events.push(level !== undefined
        ? { type: 'heading', command: command.name, level, title: text, start, end: title.end }
        : { type: 'caption', title: text, start, end: title.end });
      collectTitleEvents(command.end, title.end);
      cursor = title.end;
    } else if (command.name === 'label') {
      const group = argumentsScanner.readArgument(command.end);
      if (group?.complete) {
        const label = labels.get(start);
        if (label) { events.push({ type: 'label', key: label.key, start, end: group.end }); }
        cursor = group.end;
      }
    } else {
      const declaration = includes.get(start);
      const argument = declaration?.argument;
      if (argument) {
        const path = scanner.textWithoutComments(argument.contentStart, argument.contentEnd)?.trim();
        if (path && !/[\\#${}]/.test(path)) {
          events.push({ type: 'include', command: declaration.command as 'input' | 'include', path, start, end: declaration.end });
        }
        cursor = declaration.end;
      }
    }
  }
  return events.sort((left, right) => left.start - right.start);
}

export interface StructurePlainTextOptions {
  /** Omit real named begin/end declarations when formatting equation summaries. */
  readonly omitEnvironmentCommands?: boolean;
}

/** Normalizes display text without erasing unknown commands such as math macros. */
export function structurePlainText(source: string, options: StructurePlainTextOptions = {}): string {
  const scanner = new LaTeXParser.SourceScanner(source);
  const argumentsScanner = new LaTeXParser.ArgumentScanner(scanner);
  const commands = new Map(scanner.commands.map(command => [command.start, command]));
  const environmentCommands = options.omitEnvironmentCommands
    ? new Map(new LaTeXParser.EnvironmentParser(scanner, [], ['named']).tokens.map(token => [token.start, token]))
    : undefined;
  const ignored = new Map(scanner.ignoredRanges.filter(range => range.start < range.end)
    .map(range => [range.start, range]));
  const formatting = /^(?:text(?:bf|it|sl|sc|sf|tt|rm|up|normal)|emph|underline|mbox|ensuremath|bfseries|itshape|slshape|scshape|sffamily|ttfamily|rmfamily|normalfont|protect)$/;
  const braces: boolean[] = [];
  let result = '';
  let cursor = 0;
  let math = false;
  let preserveNextGroup = false;
  let stripNextGroup = false;
  while (cursor < source.length) {
    const character = source[cursor];
    const range = ignored.get(cursor);
    if (range) {
      result += range.kind === 'comment' ? ' ' : source.slice(range.contentStart, range.contentEnd);
      cursor = range.end;
      continue;
    }
    const environment = environmentCommands?.get(cursor);
    if (environment) {
      // Keep the original scan and literal ranges; a removed declaration must
      // neither reinterpret literal contents nor join neighboring commands.
      result += ' ';
      cursor = environment.end;
      preserveNextGroup = false;
      stripNextGroup = false;
      continue;
    }
    const command = commands.get(cursor);
    if (command) {
      if (command.name === 'label') {
        const group = argumentsScanner.readArgument(command.end);
        cursor = group?.complete ? group.end : command.end;
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
        const next = scanner.skipTrivia(command.end)!;
        const group = argumentsScanner.readArgument(next);
        if (group?.complete && group.contentEnd - group.contentStart === 1) {
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
      if (preserve) { result += character; }
      preserveNextGroup = false;
      stripNextGroup = false;
    } else if (character === '}') {
      const preserve = braces.pop() ?? false;
      if (preserve) { result += character; }
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
  return new LaTeXParser.SourceScanner(source).skipTrivia(0) === source.length;
}

function readTitle(scanner: LaTeXParser.ArgumentScanner, offset: number): LaTeXParser.ScannedArgument | undefined {
  let cursor = scanner.readStar(offset)?.end ?? offset;
  const optional = scanner.readArgument(cursor, '[');
  if (optional) {
    if (!optional.complete) { return undefined; }
    cursor = optional.end;
  }
  const title = scanner.readArgument(cursor);
  return title?.complete ? title : undefined;
}

function mergeRanges(ranges: readonly LaTeXParser.SourceRange[]): LaTeXParser.SourceRange[] {
  const merged: { start: number; end: number }[] = [];
  for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }
  return merged;
}

function rangeEndAt(ranges: readonly LaTeXParser.SourceRange[], offset: number): number | undefined {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (ranges[middle].end <= offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return ranges[low]?.start <= offset ? ranges[low].end : undefined;
}
