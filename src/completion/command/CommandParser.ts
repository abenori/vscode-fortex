import * as LaTeXParser from '../../latex-parser';

export interface CommandContext {
  query: string;
  start: number;
}

/** Finds the control-word fragment immediately before the cursor. */
export function findCommandContext(input: string | LaTeXParser.LaTeXSource, lineOffset = 0): CommandContext | undefined {
  // Only scan the current line; querying a fragment must not parse the document.
  const syntax = typeof input === 'string' ? new LaTeXParser.LaTeXSource(input) : input;
  const linePrefix = syntax.source;
  const scanner = syntax.sourceScanner;
  const command = scanner.commands.at(-1);
  if (!command || scanner.maskedSource[command.start] !== '\\') {
    return undefined;
  }
  const query = linePrefix.slice(command.start + 1);
  return /^[A-Za-z@]*\*?$/.test(query)
    ? { query, start: lineOffset + command.start }
    : undefined;
}
