import { CitationContext, CitationEntry } from './Citation';

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
  return latexToPlainText(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function latexToPlainText(value: string): string {
  return value
    .replace(/\\(?:LaTeX|TeX)\b/g, (command) => command.slice(1))
    .replace(/\\["'`^~=.uvHckbdtr]\s*\{?([A-Za-z])\}?/g, '$1')
    .replace(/\\([%&_#$])/g, '$1')
    .replace(/\\[A-Za-z@]+\*?\s*/g, '')
    .replace(/[{}]/g, '')
    .replace(/~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Finds the currently edited key fragment in a cite-like command. */
export function findCitationContext(text: string, offset = text.length): CitationContext | undefined {
  const lineStart = Math.max(text.lastIndexOf('\n', offset - 1), text.lastIndexOf('\r', offset - 1)) + 1;
  for (let cursor = lineStart; cursor < offset; cursor++) {
    if (text[cursor] === '%' && !isEscaped(text, cursor)) {
      return undefined;
    }
  }

  const prefix = text.slice(Math.max(0, offset - 20000), offset);
  const baseOffset = Math.max(0, offset - 20000);
  const citePattern = /\\(?:cite|citep|citet|citealp|citealt|citeauthor|citeyear|citeyearpar|autocite|parencite|textcite|footcite|footcitetext|smartcite|supercite|fullcite|volcite|pvolcite|fvolcite|notecite|nocite)\*?\s*(?:\[[^\]]*\]\s*)*\{([^{}]*)$/i;
  const match = citePattern.exec(prefix);
  if (!match) {
    return undefined;
  }

  const content = match[1];
  const comma = content.lastIndexOf(',');
  const fragment = content.slice(comma + 1);
  const leadingWhitespace = fragment.match(/^\s*/)?.[0].length ?? 0;
  return {
    query: fragment.slice(leadingWhitespace),
    queryStart: baseOffset + match.index + match[0].length - fragment.length + leadingWhitespace
  };
}

function isEscaped(text: string, offset: number): boolean {
  let slashCount = 0;
  for (let cursor = offset - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) {
    slashCount++;
  }
  return slashCount % 2 === 1;
}
