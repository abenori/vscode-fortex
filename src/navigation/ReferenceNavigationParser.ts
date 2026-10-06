/** A label or one key within a reference command, with its source offsets. */
export interface ReferenceNavigationToken {
  kind: 'label' | 'reference';
  command: string;
  key: string;
  commandStart: number;
  commandEnd: number;
  keyStart: number;
  keyEnd: number;
}

const REFERENCE_COMMANDS = 'ref|pageref|eqref|autoref|nameref|cref|Cref|vref|Vref';

/**
 * Finds label and reference commands without changing source offsets. Reference
 * commands containing several comma-separated keys produce one token per key.
 */
export function findReferenceNavigationTokens(source: string): ReferenceNavigationToken[] {
  const masked = maskComments(source);
  const pattern = new RegExp(`\\\\(label|${REFERENCE_COMMANDS})\\*?\\s*\\{([^{}\\r\\n]*)\\}`, 'g');
  const tokens: ReferenceNavigationToken[] = [];

  for (const match of masked.matchAll(pattern)) {
    const commandStart = match.index;
    if (isEscapedBackslash(source, commandStart)) {
      continue;
    }

    const command = match[1];
    const rawKeys = match[2];
    const keysStart = commandStart + match[0].lastIndexOf('{') + 1;
    const segments = command === 'label' ? [[0, rawKeys.length] as const] : findCommaSeparatedSegments(rawKeys);
    for (const [segmentStart, segmentEnd] of segments) {
      const rawKey = rawKeys.slice(segmentStart, segmentEnd);
      const leadingWhitespace = rawKey.length - rawKey.trimStart().length;
      const key = rawKey.trim();
      if (!key) {
        continue;
      }
      const keyStart = keysStart + segmentStart + leadingWhitespace;
      tokens.push({
        kind: command === 'label' ? 'label' : 'reference',
        command,
        key,
        commandStart,
        commandEnd: commandStart + match[0].length,
        keyStart,
        keyEnd: keyStart + key.length
      });
    }
  }
  return tokens;
}

/**
 * Returns the key addressed by the cursor. When the cursor is on the command or
 * braces of a multi-key reference, the nearest key is used.
 */
export function findReferenceNavigationTokenAtOffset(
  source: string,
  offset: number
): ReferenceNavigationToken | undefined {
  const candidates = findReferenceNavigationTokens(source).filter(
    (token) => token.commandStart <= offset && offset <= token.commandEnd
  );
  if (candidates.length === 0) {
    return undefined;
  }

  return candidates.reduce((nearest, token) =>
    distanceFromKey(token, offset) < distanceFromKey(nearest, offset) ? token : nearest
  );
}

function findCommaSeparatedSegments(source: string): Array<readonly [number, number]> {
  const segments: Array<readonly [number, number]> = [];
  let start = 0;
  for (let offset = 0; offset <= source.length; offset++) {
    if (offset === source.length || source[offset] === ',') {
      segments.push([start, offset]);
      start = offset + 1;
    }
  }
  return segments;
}

function distanceFromKey(token: ReferenceNavigationToken, offset: number): number {
  if (offset < token.keyStart) {
    return token.keyStart - offset;
  }
  if (offset > token.keyEnd) {
    return offset - token.keyEnd;
  }
  return 0;
}

function maskComments(source: string): string {
  // Replacing comment characters with spaces keeps every recorded offset aligned
  // with the original document.
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
