import { CitationContext } from './citation/Citation';
import { findCitationContext } from './citation/CitationSearch';
import { CommandContext, findCommandContext } from './command/CommandParser';
import { EnvironmentCompletionContext, findEnvironmentCompletionContext } from './environment/EnvironmentParser';
import { findReferenceContext, ReferenceContext } from './reference/LabelParser';
import * as LaTeXParser from '../latex-parser';

export type CompletionContext =
  | ({ kind: 'reference' } & ReferenceContext)
  | ({ kind: 'citation' } & CitationContext)
  | ({ kind: 'environment' } & EnvironmentCompletionContext)
  | ({ kind: 'command' } & CommandContext);

/** Classifies one line, returning replacement offsets relative to the document. */
export function findCompletionContext(line: string, character: number, lineOffset = 0): CompletionContext | undefined {
  const prefix = line.slice(0, character);
  const scanner = new LaTeXParser.SourceScanner(prefix);
  if (scanner.ignoredRanges.some(range => range.end === prefix.length
    && (range.kind === 'comment' || !range.closed))) {
    return undefined;
  }

  // A command being typed inside an argument takes precedence over that argument.
  const command = findCommandContext(prefix, lineOffset);
  if (command) {
    return { kind: 'command', ...command };
  }
  const reference = findReferenceContext(prefix);
  if (reference) {
    return { kind: 'reference', ...reference, queryStart: lineOffset + reference.queryStart };
  }
  const citation = findCitationContext(prefix);
  if (citation) {
    return { kind: 'citation', ...citation, queryStart: lineOffset + citation.queryStart };
  }
  // The suffix is needed only to consume an existing closing brace or \\].
  const environment = findEnvironmentCompletionContext(line, character);
  if (environment) {
    return {
      kind: 'environment',
      ...environment,
      queryStart: lineOffset + environment.queryStart,
      replaceEnd: lineOffset + environment.replaceEnd
    };
  }
  return undefined;
}
