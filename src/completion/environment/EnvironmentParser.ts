export const DISPLAY_MATH_ENVIRONMENT = '\\[';

/** Distinguishes named `begin/end` commands from the `\[ / \]` shorthand. */
export type EnvironmentTokenStyle = 'named' | 'display';

/** Source offsets for one opening or closing environment token. */
export interface EnvironmentToken {
  kind: 'begin' | 'end';
  style: EnvironmentTokenStyle;
  name: string;
  start: number;
  end: number;
  nameStart: number;
  nameEnd: number;
}

/** A structurally matched opening and closing token. */
export interface EnvironmentPair {
  begin: EnvironmentToken;
  end: EnvironmentToken;
}

/** Replacement range for environment IntelliSense at the cursor. */
export interface EnvironmentCompletionContext {
  style: EnvironmentTokenStyle;
  query: string;
  queryStart: number;
  replaceEnd: number;
}

export const STANDARD_ENVIRONMENTS = [
  'abstract',
  'align',
  'align*',
  'array',
  'cases',
  'center',
  'description',
  'displaymath',
  'document',
  'enumerate',
  'equation',
  'equation*',
  'figure',
  'figure*',
  'flushleft',
  'flushright',
  'gather',
  'gather*',
  'itemize',
  'list',
  'math',
  'minipage',
  'multline',
  'multline*',
  'picture',
  'quote',
  'quotation',
  'split',
  'table',
  'table*',
  'tabular',
  'tabular*',
  'thebibliography',
  'theorem',
  'titlepage',
  'verbatim',
  'verse'
] as const;

/** Tokenizes uncommented named environments and display-math delimiters. */
export function findEnvironmentTokens(source: string): EnvironmentToken[] {
  const masked = maskComments(source);
  const tokens: EnvironmentToken[] = [];
  const pattern = /\\(begin|end)\s*\{([^{}\r\n]+)\}|\\([\[\]])/g;

  for (const match of masked.matchAll(pattern)) {
    const start = match.index;
    if (isEscapedBackslash(source, start)) {
      continue;
    }

    // Display delimiters have no separate name range, so the whole token is used
    // when VS Code asks for the text that can be renamed.
    if (match[3]) {
      tokens.push({
        kind: match[3] === '[' ? 'begin' : 'end',
        style: 'display',
        name: DISPLAY_MATH_ENVIRONMENT,
        start,
        end: start + match[0].length,
        nameStart: start,
        nameEnd: start + match[0].length
      });
      continue;
    }

    const rawName = match[2];
    const name = rawName.trim();
    if (!name) {
      continue;
    }
    const leadingWhitespace = rawName.length - rawName.trimStart().length;
    const brace = match[0].indexOf('{');
    const nameStart = start + brace + 1 + leadingWhitespace;
    tokens.push({
      kind: match[1] === 'begin' ? 'begin' : 'end',
      style: 'named',
      name,
      start,
      end: start + match[0].length,
      nameStart,
      nameEnd: nameStart + name.length
    });
  }
  return tokens;
}

export function findEnvironmentPairs(source: string): EnvironmentPair[] {
  // A stack pairs each closing token with the innermost compatible opening token.
  // Mismatched input remains unpaired instead of risking an edit to the wrong text.
  const stack: EnvironmentToken[] = [];
  const pairs: EnvironmentPair[] = [];
  for (const token of findEnvironmentTokens(source)) {
    if (token.kind === 'begin') {
      stack.push(token);
      continue;
    }
    const begin = stack[stack.length - 1];
    if (begin && begin.name === token.name && begin.style === token.style) {
      stack.pop();
      pairs.push({ begin, end: token });
    }
  }
  return pairs;
}

/**
 * Returns the innermost complete opening token before the cursor that has no
 * structurally matching closing token anywhere in the document.
 */
export function findUnclosedEnvironmentAtOffset(source: string, offset: number): EnvironmentToken | undefined {
  const stack: EnvironmentToken[] = [];
  for (const token of findEnvironmentTokens(source)) {
    if (token.kind === 'begin') {
      stack.push(token);
      continue;
    }
    const begin = stack[stack.length - 1];
    if (begin && begin.name === token.name && begin.style === token.style) {
      stack.pop();
    }
  }

  // An opening command is eligible only after the cursor has passed the complete
  // token. This avoids inserting an end command while `\begin{...}` is still being
  // edited.
  return stack.filter((token) => token.end <= offset).at(-1);
}

export function findEnvironmentTokenAtOffset(source: string, offset: number): EnvironmentToken | undefined {
  return findEnvironmentTokens(source).find((token) => token.start <= offset && offset <= token.end);
}

export function findEnvironmentPairAtOffset(source: string, offset: number): EnvironmentPair | undefined {
  return findEnvironmentPairs(source).find((pair) => isWithin(pair.begin, offset) || isWithin(pair.end, offset));
}

export function findEnvironmentCompletionContext(source: string, offset: number): EnvironmentCompletionContext | undefined {
  const prefix = maskComments(source.slice(0, offset));
  const beginMatch = /\\begin\s*\{([^{}\r\n]*)$/.exec(prefix);
  if (beginMatch) {
    const query = beginMatch[1];
    const queryStart = offset - query.length;
    // VS Code often auto-inserts the closing brace. Replace it with the snippet so
    // accepting a completion does not leave a duplicate `}` behind.
    const closing = /^[^{}\r\n]*\}/.exec(source.slice(offset));
    return {
      style: 'named',
      query,
      queryStart,
      replaceEnd: closing ? offset + closing[0].length : offset
    };
  }

  const displayStart = prefix.length - 2;
  if (displayStart >= 0 && prefix.slice(displayStart) === '\\[' && !isEscapedBackslash(source, displayStart)) {
    return {
      style: 'display',
      query: DISPLAY_MATH_ENVIRONMENT,
      queryStart: displayStart,
      replaceEnd: source.startsWith('\\]', offset) ? offset + 2 : offset
    };
  }
  return undefined;
}

export function collectEnvironmentNames(source: string): string[] {
  // Combine a useful baseline with names used or declared in this document. A set
  // keeps Quick Pick and IntelliSense free of duplicates.
  const names = new Set<string>(STANDARD_ENVIRONMENTS);
  for (const token of findEnvironmentTokens(source)) {
    if (token.style === 'named') {
      names.add(token.name);
    }
  }

  const masked = maskComments(source);
  const definitionPattern = /\\(?:newenvironment|renewenvironment|provideenvironment|NewDocumentEnvironment|RenewDocumentEnvironment|ProvideDocumentEnvironment|DeclareDocumentEnvironment|newtheorem)\*?\s*\{([^{}\r\n]+)\}/g;
  for (const match of masked.matchAll(definitionPattern)) {
    const name = match[1].trim();
    if (name) {
      names.add(name);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

function isWithin(token: EnvironmentToken, offset: number): boolean {
  return token.start <= offset && offset <= token.end;
}

function maskComments(source: string): string {
  // Mask rather than delete comments because completion and rename ranges refer
  // to offsets in the original source.
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

function isEscapedBackslash(source: string, offset: number): boolean {
  let slashCount = 0;
  for (let cursor = offset - 1; cursor >= 0 && source[cursor] === '\\'; cursor--) {
    slashCount++;
  }
  return slashCount % 2 === 1;
}
