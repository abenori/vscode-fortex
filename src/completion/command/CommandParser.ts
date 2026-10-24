import * as LaTeXParser from '../../latex-parser';

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
  // Only scan the current line; querying a fragment must not parse the document.
  const scanner = new LaTeXParser.SourceScanner(linePrefix);
  const command = scanner.commands.at(-1);
  if (!command || scanner.maskedSource[command.start] !== '\\') {
    return undefined;
  }
  const query = linePrefix.slice(command.start + 1);
  return /^[A-Za-z@]*\*?$/.test(query)
    ? { query, start: lineOffset + command.start }
    : undefined;
}

/** Adapts shared lexical definitions to document-local command completions. */
export function findCustomCommands(source: string | LaTeXParser.DefinitionParser): CustomCommandDefinition[] {
  const parser = typeof source === 'string' ? new LaTeXParser.DefinitionParser(source) : source;
  const lineOffsets = makeLineOffsets(parser.source);
  const commands = new Map<string, CustomCommandDefinition>();
  for (const definition of parser.definitions) {
    if (definition.kind !== 'command' || !/^[A-Za-z@]+$/.test(definition.name)) {
      continue;
    }
    commands.set(definition.name, {
      name: definition.name,
      argumentCount: definition.argumentCount ?? 0,
      optionalFirstArgument: definition.optionalFirstArgument ?? false,
      line: lineAtOffset(lineOffsets, definition.start)
    });
  }

  return [...commands.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function makeLineOffsets(source: string): number[] {
  const offsets = [0];
  for (let offset = 0; offset < source.length; offset++) {
    if (source[offset] === '\r') {
      if (source[offset + 1] === '\n') {
        offset++;
      }
      offsets.push(offset + 1);
    } else if (source[offset] === '\n') {
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
