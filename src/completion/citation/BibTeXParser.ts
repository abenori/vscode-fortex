import { ParsedBibEntry } from './Citation';

interface ParsedValue {
  value: string;
  next: number;
}

/**
 * Parses the parts of BibTeX needed by citation completion. The scanner keeps
 * track of nested braces and quoted strings, so commas in titles do not split
 * fields accidentally.
 */
export function parseBibTeX(text: string): ParsedBibEntry[] {
  const entries: ParsedBibEntry[] = [];
  const strings = new Map<string, string>();
  let offset = 0;

  while (offset < text.length) {
    const at = findNextEntryStart(text, offset);
    if (at < 0) {
      break;
    }

    let cursor = skipWhitespace(text, at + 1);
    const typeStart = cursor;
    while (cursor < text.length && /[A-Za-z]/.test(text[cursor])) {
      cursor++;
    }
    const type = text.slice(typeStart, cursor).toLowerCase();
    cursor = skipWhitespace(text, cursor);
    const open = text[cursor];
    if (!type || (open !== '{' && open !== '(')) {
      offset = at + 1;
      continue;
    }

    const end = findEntryEnd(text, cursor, open === '{' ? '}' : ')');
    if (end < 0) {
      break;
    }

    const body = text.slice(cursor + 1, end);
    if (type === 'string') {
      parseStringDefinition(body, strings);
    } else if (type !== 'comment' && type !== 'preamble') {
      const entry = parseRegularEntry(type, body, strings);
      if (entry) {
        entries.push(entry);
      }
    }
    offset = end + 1;
  }

  return entries;
}

function findNextEntryStart(text: string, start: number): number {
  let inComment = false;
  for (let cursor = start; cursor < text.length; cursor++) {
    const char = text[cursor];
    if (inComment) {
      if (char === '\n' || char === '\r') {
        inComment = false;
      }
    } else if (char === '%') {
      inComment = true;
    } else if (char === '@') {
      return cursor;
    }
  }
  return -1;
}

function findEntryEnd(text: string, openOffset: number, close: string): number {
  const open = text[openOffset];
  let outerDepth = 1;
  let braceDepth = 0;
  let quoted = false;

  for (let i = openOffset + 1; i < text.length; i++) {
    const char = text[i];
    if (char === '"' && !isEscaped(text, i)) {
      quoted = !quoted;
      continue;
    }
    if (quoted) {
      continue;
    }

    if (open === '{') {
      if (char === '{' && !isEscaped(text, i)) {
        outerDepth++;
      } else if (char === '}' && !isEscaped(text, i)) {
        outerDepth--;
        if (outerDepth === 0) {
          return i;
        }
      }
    } else {
      if (char === '{' && !isEscaped(text, i)) {
        braceDepth++;
      } else if (char === '}' && !isEscaped(text, i) && braceDepth > 0) {
        braceDepth--;
      } else if (char === '(' && braceDepth === 0 && !isEscaped(text, i)) {
        outerDepth++;
      } else if (char === close && braceDepth === 0 && !isEscaped(text, i)) {
        outerDepth--;
        if (outerDepth === 0) {
          return i;
        }
      }
    }
  }
  return -1;
}

function parseStringDefinition(body: string, strings: Map<string, string>): void {
  let cursor = skipSeparators(body, 0);
  const nameStart = cursor;
  while (cursor < body.length && /[A-Za-z0-9_:\-.]/.test(body[cursor])) {
    cursor++;
  }
  const name = body.slice(nameStart, cursor).trim().toLowerCase();
  cursor = skipWhitespace(body, cursor);
  if (!name || body[cursor] !== '=') {
    return;
  }
  const parsed = parseValue(body, cursor + 1, strings);
  strings.set(name, parsed.value);
}

function parseRegularEntry(type: string, body: string, strings: ReadonlyMap<string, string>): ParsedBibEntry | undefined {
  const comma = findTopLevelComma(body, 0);
  if (comma < 0) {
    return undefined;
  }
  const key = body.slice(0, comma).trim();
  if (!key) {
    return undefined;
  }

  const fields: Record<string, string> = {};
  let cursor = comma + 1;
  while (cursor < body.length) {
    cursor = skipSeparators(body, cursor);
    if (cursor >= body.length) {
      break;
    }

    const nameStart = cursor;
    while (cursor < body.length && /[A-Za-z0-9_:\-.]/.test(body[cursor])) {
      cursor++;
    }
    const name = body.slice(nameStart, cursor).trim().toLowerCase();
    cursor = skipWhitespace(body, cursor);
    if (!name || body[cursor] !== '=') {
      const next = findTopLevelComma(body, cursor);
      if (next < 0) {
        break;
      }
      cursor = next + 1;
      continue;
    }

    const parsed = parseValue(body, cursor + 1, strings);
    fields[name] = parsed.value.trim();
    cursor = parsed.next;
  }

  return { key, type, fields };
}

function parseValue(text: string, start: number, strings: ReadonlyMap<string, string>): ParsedValue {
  const parts: string[] = [];
  let cursor = start;

  while (cursor < text.length) {
    cursor = skipWhitespaceAndComments(text, cursor);
    const char = text[cursor];
    let part: ParsedValue;
    if (char === '{') {
      part = parseBracedValue(text, cursor);
    } else if (char === '"') {
      part = parseQuotedValue(text, cursor);
    } else {
      part = parseBareValue(text, cursor, strings);
    }
    parts.push(part.value);
    cursor = skipWhitespaceAndComments(text, part.next);
    if (text[cursor] !== '#') {
      break;
    }
    cursor++;
  }

  return { value: parts.join(''), next: cursor };
}

function parseBracedValue(text: string, start: number): ParsedValue {
  let depth = 1;
  for (let cursor = start + 1; cursor < text.length; cursor++) {
    const char = text[cursor];
    if (char === '{' && !isEscaped(text, cursor)) {
      depth++;
    } else if (char === '}' && !isEscaped(text, cursor)) {
      depth--;
      if (depth === 0) {
        return { value: text.slice(start + 1, cursor), next: cursor + 1 };
      }
    }
  }
  return { value: text.slice(start + 1), next: text.length };
}

function parseQuotedValue(text: string, start: number): ParsedValue {
  let braceDepth = 0;
  for (let cursor = start + 1; cursor < text.length; cursor++) {
    const char = text[cursor];
    if (char === '{' && !isEscaped(text, cursor)) {
      braceDepth++;
    } else if (char === '}' && !isEscaped(text, cursor) && braceDepth > 0) {
      braceDepth--;
    } else if (char === '"' && braceDepth === 0 && !isEscaped(text, cursor)) {
      return { value: text.slice(start + 1, cursor), next: cursor + 1 };
    }
  }
  return { value: text.slice(start + 1), next: text.length };
}

function parseBareValue(text: string, start: number, strings: ReadonlyMap<string, string>): ParsedValue {
  let cursor = start;
  while (cursor < text.length && text[cursor] !== ',' && text[cursor] !== '#') {
    cursor++;
  }
  const token = text.slice(start, cursor).trim();
  return { value: strings.get(token.toLowerCase()) ?? token, next: cursor };
}

function findTopLevelComma(text: string, start: number): number {
  let braceDepth = 0;
  let quoted = false;
  for (let cursor = start; cursor < text.length; cursor++) {
    const char = text[cursor];
    if (char === '"' && !isEscaped(text, cursor)) {
      quoted = !quoted;
    } else if (!quoted && char === '{' && !isEscaped(text, cursor)) {
      braceDepth++;
    } else if (!quoted && char === '}' && !isEscaped(text, cursor) && braceDepth > 0) {
      braceDepth--;
    } else if (!quoted && braceDepth === 0 && char === ',') {
      return cursor;
    }
  }
  return -1;
}

function skipSeparators(text: string, start: number): number {
  let cursor = start;
  while (cursor < text.length) {
    cursor = skipWhitespaceAndComments(text, cursor);
    if (text[cursor] !== ',') {
      break;
    }
    cursor++;
  }
  return cursor;
}

function skipWhitespace(text: string, start: number): number {
  let cursor = start;
  while (cursor < text.length && /\s/.test(text[cursor])) {
    cursor++;
  }
  return cursor;
}

function skipWhitespaceAndComments(text: string, start: number): number {
  let cursor = skipWhitespace(text, start);
  while (text[cursor] === '%') {
    const newline = text.indexOf('\n', cursor + 1);
    cursor = newline < 0 ? text.length : skipWhitespace(text, newline + 1);
  }
  return cursor;
}

function isEscaped(text: string, offset: number): boolean {
  let slashCount = 0;
  for (let cursor = offset - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) {
    slashCount++;
  }
  return slashCount % 2 === 1;
}
