import * as LaTeXParser from '../../latex-parser';

export interface ReferenceContext {
  query: string;
  queryStart: number;
}

export function findReferenceContext(input: string | LaTeXParser.LaTeXSource, offset?: number): ReferenceContext | undefined {
  const source = typeof input === 'string' ? input : input.source;
  offset ??= source.length;
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length) {
    return undefined;
  }

  // As with citation completion, a bounded look-behind avoids rescanning an entire
  // large document on every keystroke.
  const start = Math.max(0, offset - 20000);
  const prefix = source.slice(start, offset);
  const syntax = input instanceof LaTeXParser.LaTeXSource && start === 0 && offset === source.length
    ? input : new LaTeXParser.LaTeXSource(prefix);
  const scanner = syntax.sourceScanner;
  if (scanner.ignoredRanges.some(range => range.end === prefix.length
    && (range.kind === 'comment' || !range.closed))) {
    return undefined;
  }
  const argumentsScanner = syntax.argumentScanner;
  for (let index = scanner.commands.length - 1; index >= 0; index--) {
    const command = scanner.commands[index];
    if (!LaTeXParser.ReferenceParser.isReferenceCommand(command.name)) {
      continue;
    }
    const star = argumentsScanner.readStar(command.end);
    const argument = argumentsScanner.readArgument(star?.end ?? command.end);
    if (!argument || argument.complete) {
      continue;
    }
    let fragmentStart = argument.contentStart;
    let nestedCommandIndex = index + 1;
    for (let cursor = argument.contentStart; cursor < prefix.length; cursor++) {
      const nestedCommand = scanner.commands[nestedCommandIndex];
      if (nestedCommand?.start === cursor) {
        cursor = nestedCommand.end - 1;
        nestedCommandIndex++;
        continue;
      }
      const character = scanner.maskedSource[cursor];
      // A nested argument is not a reference-key fragment. The dispatch layer
      // can still offer command completion within it.
      if (character === '{' || character === '}') {
        return undefined;
      }
      if (character === ',') {
        fragmentStart = cursor + 1;
      }
    }
    const queryStart = scanner.skipTrivia(fragmentStart)!;
    return {
      query: scanner.textWithoutComments(queryStart, prefix.length) ?? '',
      queryStart: start + queryStart
    };
  }
  return undefined;
}
