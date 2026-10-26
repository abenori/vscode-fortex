import { latexToPlainText } from '../citation/CitationSearch';
import * as LaTeXParser from '../../latex-parser';

/** A label and the nearby source shown in reference completion details. */
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

/** Extracts unique labels and completion-specific descriptions. */
export function findLabels(input: string | LaTeXParser.LaTeXSource | LaTeXParser.ReferenceParser): LabelEntry[] {
  const parser = typeof input === 'string' ? new LaTeXParser.LaTeXSource(input).referenceParser
    : input instanceof LaTeXParser.LaTeXSource ? input.referenceParser : input;
  const source = parser.source;
  const tokens = parser.tokens.filter(token => token.kind === 'label');
  const sourceLines = source.split(/\r\n|\r|\n/);
  const summaryCharacters = source.split('');
  for (const token of tokens) {
    for (let offset = token.commandStart; offset < token.commandEnd; offset++) {
      if (source[offset] !== '\r' && source[offset] !== '\n') {
        summaryCharacters[offset] = ' ';
      }
    }
  }
  const summaryLines = summaryCharacters.join('').split(/\r\n|\r|\n/);
  const lineOffsets = makeLineOffsets(source);
  const labels: LabelEntry[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    const key = token.key;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const line = lineAtOffset(lineOffsets, token.commandStart);
    labels.push({
      key,
      line,
      context: makeContext(sourceLines, line),
      summary: makeSummary(summaryLines, line)
    });
  }
  return labels;
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

function makeContext(lines: readonly string[], targetLine: number): string {
  // Include two lines on either side, trimming blank edges so the documentation
  // popup remains compact while retaining the original LaTeX source.
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
  // Prefer the label's line, then nearby lines, and remove formatting commands for
  // the short description displayed beside the completion key.
  const candidateLines = [
    lines[targetLine],
    ...lines.slice(Math.max(0, targetLine - 2), targetLine).reverse(),
    ...lines.slice(targetLine + 1, Math.min(lines.length, targetLine + 3))
  ];
  for (const line of candidateLines) {
    const plain = latexToPlainText(line).trim();
    if (plain) {
      return plain.length > 100 ? `${plain.slice(0, 97)}...` : plain;
    }
  }
  return '(No nearby text)';
}
