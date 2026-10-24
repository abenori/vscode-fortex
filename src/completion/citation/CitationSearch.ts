import { CitationContext, CitationEntry } from './Citation';
import * as LaTeXParser from '../../latex-parser';

/** Ranks entries using one query shared across author and title fields. */
export function searchCitations(entries: readonly CitationEntry[], query: string): CitationEntry[] {
  const normalizedQuery = normalizeForSearch(query);
  const tokens = normalizedQuery.split(' ').filter(Boolean);

  return entries
    .map((entry) => ({ entry, score: scoreEntry(entry, normalizedQuery, tokens) }))
    .filter((candidate) => candidate.score < Number.POSITIVE_INFINITY)
    .sort((left, right) => left.score - right.score || compareEntries(left.entry, right.entry))
    .map((candidate) => candidate.entry);
}

function scoreEntry(entry: CitationEntry, query: string, tokens: readonly string[]): number {
  if (tokens.length === 0) {
    return 0;
  }

  const author = normalizeForSearch(entry.author);
  const title = normalizeForSearch(entry.title);
  const combined = `${author} ${title}`.trim();
  if (author === query || title === query) {
    return 0;
  }
  if (author.startsWith(query) || title.startsWith(query)) {
    return 5;
  }

  // Lower scores are better: exact words outrank prefixes, which outrank a token
  // appearing elsewhere in the combined author/title text.
  let score = 10;
  const words = combined.split(' ');
  for (const token of tokens) {
    if (!combined.includes(token)) {
      return Number.POSITIVE_INFINITY;
    }
    if (words.some((word) => word === token)) {
      score += 0;
    } else if (words.some((word) => word.startsWith(token))) {
      score += 1;
    } else {
      score += 3;
    }
  }
  return score;
}

function compareEntries(left: CitationEntry, right: CitationEntry): number {
  return left.author.localeCompare(right.author) || left.title.localeCompare(right.title) || left.key.localeCompare(right.key);
}

export function normalizeForSearch(value: string): string {
  // NFKD plus combining-mark removal makes accented names searchable with either
  // their accented or ASCII spelling while retaining non-Latin scripts.
  return latexToPlainText(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function latexToPlainText(value: string): string {
  // This is deliberately a display/search normalizer, not a full TeX parser. The
  // ordering matters: accents must be decoded before generic commands are removed.
  return value
    .replace(/\\(?:LaTeX|TeX)\b/g, (command) => command.slice(1))
    .replace(/\\["'`^~=.]\s*\{?([A-Za-z])\}?/g, '$1')
    .replace(/\\[uvHckbdtr](?:\s*\{([A-Za-z])\}|\s+([A-Za-z]))/g, (_match, braced, spaced) => braced ?? spaced)
    .replace(/\\([%&_#$])/g, '$1')
    .replace(/\\[A-Za-z@]+\*?\s*/g, '')
    .replace(/[{}]/g, '')
    .replace(/~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Finds the currently edited key fragment in a cite-like command. */
export function findCitationContext(text: string, offset = text.length): CitationContext | undefined {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) {
    return undefined;
  }
  // The dispatcher supplies only the current line. Retain a bounded look-behind
  // for callers that supply a longer source snapshot.
  const baseOffset = Math.max(0, offset - 20000);
  const prefix = text.slice(baseOffset, offset);
  const scanner = new LaTeXParser.SourceScanner(prefix);
  if (scanner.ignoredRanges.some(range => range.end === prefix.length
    && (range.kind === 'comment' || !range.closed))) {
    return undefined;
  }
  const argumentsScanner = new LaTeXParser.ArgumentScanner(scanner);
  const citeCommand = /^(?:cite|citep|citet|citealp|citealt|citeauthor|citeyear|citeyearpar|autocite|parencite|textcite|footcite|footcitetext|smartcite|supercite|fullcite|volcite|pvolcite|fvolcite|notecite|nocite)$/i;
  for (let index = scanner.commands.length - 1; index >= 0; index--) {
    const command = scanner.commands[index];
    if (!citeCommand.test(command.name)) { continue; }
    let cursor = argumentsScanner.readStar(command.end)?.end ?? command.end;
    let optional = argumentsScanner.readArgument(cursor, '[');
    while (optional?.complete) {
      cursor = optional.end;
      optional = argumentsScanner.readArgument(cursor, '[');
    }
    if (optional) { continue; }
    const argument = argumentsScanner.readArgument(cursor);
    if (!argument || argument.complete) { continue; }
    let fragmentStart = argument.contentStart;
    let commandIndex = index + 1;
    for (let position = argument.contentStart; position < prefix.length; position++) {
      while (commandIndex < scanner.commands.length && scanner.commands[commandIndex].start < position) {
        commandIndex++;
      }
      const nested = scanner.commands[commandIndex];
      if (nested?.start === position) {
        position = nested.end - 1;
        commandIndex++;
        continue;
      }
      const character = scanner.maskedSource[position];
      if (character === '{' || character === '}') { return undefined; }
      if (character === ',') { fragmentStart = position + 1; }
    }
    const queryStart = scanner.skipTrivia(fragmentStart)!;
    return {
      query: scanner.textWithoutComments(queryStart, prefix.length) ?? '',
      queryStart: baseOffset + queryStart
    };
  }
  return undefined;
}
