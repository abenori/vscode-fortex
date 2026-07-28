import { latexToPlainText } from '../citation/CitationSearch';

export interface LabelEntry {
  key: string;
  line: number;
  context: string;
  summary: string;
}

export interface ReferenceContext {
  query: string;
  queryStart: number;
}

export function findLabels(source: string): LabelEntry[] {
  const masked = maskComments(source);
  const sourceLines = source.split(/\r?\n/);
  const lineOffsets = makeLineOffsets(source);
  const labels: LabelEntry[] = [];
  const seen = new Set<string>();

  for (const match of masked.matchAll(/\\label\s*\{([^{}\r\n]+)\}/g)) {
    const key = match[1].trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    const line = lineAtOffset(lineOffsets, match.index);
    labels.push({
      key,
      line,
      context: makeContext(sourceLines, line),
      summary: makeSummary(sourceLines, line)
    });
  }
  return labels;
}

export function findReferenceContext(source: string, offset = source.length): ReferenceContext | undefined {
  const lineStart = Math.max(source.lastIndexOf('\n', offset - 1), source.lastIndexOf('\r', offset - 1)) + 1;
  for (let cursor = lineStart; cursor < offset; cursor++) {
    if (source[cursor] === '%' && !isEscaped(source, cursor)) {
      return undefined;
    }
  }

  const start = Math.max(0, offset - 20000);
  const prefix = source.slice(start, offset);
  const match = /\\(?:ref|pageref|eqref|autoref|nameref|cref|Cref|vref|Vref)\*?\s*\{([^{}]*)$/.exec(prefix);
  if (!match) {
    return undefined;
  }
  const content = match[1];
  const comma = content.lastIndexOf(',');
  const fragment = content.slice(comma + 1);
  const leadingWhitespace = fragment.match(/^\s*/)?.[0].length ?? 0;
  return {
    query: fragment.slice(leadingWhitespace),
    queryStart: start + match.index + match[0].length - fragment.length + leadingWhitespace
  };
}

function makeLineOffsets(source: string): number[] {
  const offsets = [0];
  for (let offset = 0; offset < source.length; offset++) {
    if (source[offset] === '\n') {
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

function makeContext(lines: readonly string[], targetLine: number): string {
  let start = Math.max(0, targetLine - 2);
  let end = Math.min(lines.length, targetLine + 3);
  while (start < targetLine && lines[start].trim() === '') {
    start++;
  }
  while (end > targetLine + 1 && lines[end - 1].trim() === '') {
    end--;
  }
  return lines.slice(start, end).map((line) => line.length > 300 ? `${line.slice(0, 297)}...` : line).join('\n');
}

function makeSummary(lines: readonly string[], targetLine: number): string {
  const candidateLines = [
    lines[targetLine],
    ...lines.slice(Math.max(0, targetLine - 2), targetLine).reverse(),
    ...lines.slice(targetLine + 1, Math.min(lines.length, targetLine + 3))
  ];
  for (const line of candidateLines) {
    const plain = latexToPlainText(line.replace(/\\label\s*\{[^{}]*\}/g, '')).trim();
    if (plain) {
      return plain.length > 100 ? `${plain.slice(0, 97)}...` : plain;
    }
  }
  return '(No nearby text)';
}

function maskComments(source: string): string {
  let result = '';
  let inComment = false;
  let slashCount = 0;
  for (const char of source) {
    if (inComment) {
      if (char === '\r' || char === '\n') {
        inComment = false;
        result += char;
      } else {
        result += ' ';
      }
      continue;
    }
    if (char === '%' && slashCount % 2 === 0) {
      inComment = true;
      result += ' ';
      slashCount = 0;
      continue;
    }
    result += char;
    slashCount = char === '\\' ? slashCount + 1 : 0;
  }
  return result;
}

function isEscaped(source: string, offset: number): boolean {
  let slashCount = 0;
  for (let cursor = offset - 1; cursor >= 0 && source[cursor] === '\\'; cursor--) {
    slashCount++;
  }
  return slashCount % 2 === 1;
}

