/** Finds a literal package or class name addressed by the cursor. */
export function findDocumentationQuery(source: string, offset: number): string | undefined {
  if (offset < 0 || offset > source.length) {
    return undefined;
  }
  const masked = maskIgnoredText(source, offset);
  if (masked === undefined) {
    return undefined;
  }

  const commands = /\\(?:usepackage|RequirePackage|documentclass)(?![A-Za-z@])/g;
  for (const command of masked.matchAll(commands)) {
    const commandStart = command.index;
    if (commandStart > offset || isEscaped(masked, commandStart)) {
      continue;
    }
    let argumentStart = skipWhitespace(masked, commandStart + command[0].length);
    if (masked[argumentStart] === '[') {
      const optionEnd = findGroupEnd(masked, argumentStart);
      if (optionEnd === undefined) {
        continue;
      }
      argumentStart = skipWhitespace(masked, optionEnd + 1);
    }
    if (masked[argumentStart] !== '{') {
      continue;
    }
    const argumentEnd = findGroupEnd(masked, argumentStart);
    if (argumentEnd === undefined || offset > argumentEnd) {
      continue;
    }

    const names = masked.slice(argumentStart + 1, argumentEnd).split(',');
    const literalName = (name: string): string | undefined => {
      const trimmed = name.trim();
      return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(trimmed) ? trimmed : undefined;
    };
    // The command and its options identify a name only for a single argument.
    if (offset <= argumentStart) {
      return names.length === 1 ? literalName(names[0]) : undefined;
    }
    let nameStart = argumentStart + 1;
    for (const name of names) {
      const nameEnd = nameStart + name.length;
      // A cursor immediately before a comma belongs to the preceding name;
      // immediately after it, it belongs to the following name.
      if (nameStart <= offset && offset <= nameEnd) {
        return literalName(name);
      }
      nameStart = nameEnd + 1;
    }
  }
  return undefined;
}

function skipWhitespace(source: string, offset: number): number {
  while (offset < source.length && /\s/.test(source[offset])) {
    offset++;
  }
  return offset;
}

/** Optional arguments may contain closing brackets protected by braces. */
function findGroupEnd(source: string, start: number): number | undefined {
  const optional = source[start] === '[';
  let braceDepth = optional ? 0 : 1;
  for (let offset = start + 1; offset < source.length; offset++) {
    const character = source[offset];
    if (character === '\\') {
      offset++;
    } else if (character === '{') {
      braceDepth++;
    } else if (character === '}') {
      braceDepth--;
      if (braceDepth < 0) {
        return undefined;
      }
      if (!optional && braceDepth === 0) {
        return offset;
      }
    } else if (optional && character === ']' && braceDepth === 0) {
      return offset;
    }
  }
  return undefined;
}

function isEscaped(source: string, offset: number): boolean {
  let precedingSlashes = 0;
  for (let index = offset - 1; index >= 0 && source[index] === '\\'; index--) {
    precedingSlashes++;
  }
  return precedingSlashes % 2 === 1;
}

/** Masks comments and common verbatim constructs without shifting offsets. */
function maskIgnoredText(source: string, cursor: number): string | undefined {
  const masked = source.split('');
  const mask = (start: number, end: number): boolean => {
    if (start <= cursor && cursor < end) {
      return false;
    }
    for (let index = start; index < end; index++) {
      if (source[index] !== '\r' && source[index] !== '\n') {
        masked[index] = ' ';
      }
    }
    return true;
  };
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '%') {
      let end = index + 1;
      while (end < source.length && source[end] !== '\r' && source[end] !== '\n') {
        end++;
      }
      if (cursor === end || !mask(index, end)) {
        return undefined;
      }
      index = end - 1;
    } else if (source[index] === '\\') {
      const verb = /^\\verb\*?(?![A-Za-z])([^\sA-Za-z])/.exec(source.slice(index));
      if (verb) {
        const delimiter = verb[1];
        let end = index + verb[0].length;
        while (end < source.length && source[end] !== delimiter && source[end] !== '\r' && source[end] !== '\n') {
          end++;
        }
        if (source[end] === delimiter) {
          end++;
        }
        if (!mask(index, end)) {
          return undefined;
        }
        index = end - 1;
        continue;
      }
      const environment = /^\\begin\s*\{(verbatim\*?|Verbatim|BVerbatim|LVerbatim|lstlisting|minted|comment)\}/.exec(source.slice(index));
      if (environment) {
        const closing = `\\end{${environment[1]}}`;
        const closingStart = source.indexOf(closing, index + environment[0].length);
        const end = closingStart < 0 ? source.length : closingStart + closing.length;
        if (!mask(index, end)) {
          return undefined;
        }
        index = end - 1;
      } else {
        // Consume escaped percent signs and double backslashes as control symbols.
        index++;
      }
    }
  }
  return masked.join('');
}
