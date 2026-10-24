import * as LaTeXParser from '../latex-parser';

/** Selects a literal package/class name from shared declarations at the cursor. */
export function findDocumentationQuery(source: string, offset: number): string | undefined {
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length) {
    return undefined;
  }
  const scanner = new LaTeXParser.SourceScanner(source);
  if (scanner.ignoredRanges.some(range => range.start <= offset
    && (offset < range.end || (range.kind === 'comment' && offset === range.end)))) {
    return undefined;
  }
  const document = new LaTeXParser.DocumentParser(scanner);
  for (const declaration of document.declarations) {
    const argument = declaration.argument;
    if ((declaration.kind !== 'package' && declaration.kind !== 'documentClass')
      || !argument?.complete || (declaration.options && !declaration.options.complete)
      || offset < declaration.start || offset > argument.contentEnd) {
      continue;
    }
    // Locate comma boundaries without shifting source offsets. Validate original
    // content so a masked literal or macro cannot become a plausible filename.
    const names = scanner.maskedSource.slice(argument.contentStart, argument.contentEnd).split(',');
    const literalName = (start: number, end: number): string | undefined => {
      const name = scanner.textWithoutComments(start, end)?.trim() ?? '';
      return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name) ? name : undefined;
    };
    if (offset <= argument.start) {
      return names.length === 1 ? literalName(argument.contentStart, argument.contentEnd) : undefined;
    }
    let nameStart = argument.contentStart;
    for (const name of names) {
      const nameEnd = nameStart + name.length;
      // Before a comma addresses the preceding name; after it addresses the next.
      if (nameStart <= offset && offset <= nameEnd) {
        return literalName(nameStart, nameEnd);
      }
      nameStart = nameEnd + 1;
    }
  }
  return undefined;
}
