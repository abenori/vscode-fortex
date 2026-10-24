import * as LaTeXParser from '../../latex-parser';

/** Completion and environment editing retain the named and display forms. */
export type EnvironmentTokenStyle = 'named' | 'display';

/** Replacement range for environment IntelliSense at the cursor. */
export interface EnvironmentCompletionContext {
  style: EnvironmentTokenStyle;
  query: string;
  queryStart: number;
  replaceEnd: number;
}

export const STANDARD_ENVIRONMENTS = [
  'abstract',
  'align',
  'align*',
  'array',
  'cases',
  'center',
  'description',
  'displaymath',
  'document',
  'enumerate',
  'equation',
  'equation*',
  'figure',
  'figure*',
  'flushleft',
  'flushright',
  'gather',
  'gather*',
  'itemize',
  'list',
  'math',
  'minipage',
  'multline',
  'multline*',
  'picture',
  'quote',
  'quotation',
  'split',
  'table',
  'table*',
  'tabular',
  'tabular*',
  'thebibliography',
  'theorem',
  'titlepage',
  'verbatim',
  'verse'
] as const;

/** Recognizes a partially typed argument; it is deliberately completion-specific. */
export function findEnvironmentCompletionContext(source: string, offset: number): EnvironmentCompletionContext | undefined {
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length) {
    return undefined;
  }
  const scanner = new LaTeXParser.SourceScanner(source);
  const argumentsScanner = new LaTeXParser.ArgumentScanner(scanner);
  for (const command of [...scanner.commands].reverse()) {
    if (command.name !== 'begin' || command.end > offset) {
      continue;
    }
    const argument = argumentsScanner.readArgument(command.end);
    if (!argument || offset < argument.contentStart || offset > argument.contentEnd) {
      continue;
    }
    const query = source.slice(argument.contentStart, offset);
    if (/[{}\r\n]/.test(query) || scanner.maskedSource.slice(argument.contentStart, offset) !== query) {
      continue;
    }
    // Consume an auto-inserted brace only on the current line and at this depth.
    const suffix = source.slice(offset, argument.contentEnd);
    return {
      style: 'named', query, queryStart: argument.contentStart,
      replaceEnd: argument.complete && !/[{}\r\n]/.test(suffix) ? argument.end : offset
    };
  }

  const display = scanner.commands.find(command => command.name === '[' && command.end === offset);
  if (display) {
    return {
      style: 'display', query: LaTeXParser.DISPLAY_MATH_ENVIRONMENT, queryStart: display.start,
      replaceEnd: source.startsWith('\\]', offset) ? offset + 2 : offset
    };
  }
  return undefined;
}

export function collectEnvironmentNames(source: string): string[] {
  const names = new Set<string>(STANDARD_ENVIRONMENTS);
  const scanner = new LaTeXParser.SourceScanner(source);
  for (const token of new LaTeXParser.EnvironmentParser(scanner).tokens) {
    if (token.style === 'named') {
      names.add(token.name);
    }
  }
  for (const definition of new LaTeXParser.DefinitionParser(scanner).definitions) {
    if (definition.kind === 'environment' || definition.kind === 'theorem') {
      names.add(definition.name);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}
