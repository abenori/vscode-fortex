/** Programs permitted by default when a source-file `%#` directive names one. */
export const DEFAULT_ALLOWED_PROGRAMS = [
  'tex',
  'pdftex',
  'luatex',
  'xetex',
  'ptex',
  'uptex',
  'latex',
  'pdflatex',
  'lualatex',
  'xelatex',
  'platex',
  'uplatex',
  'dvipdfmx',
  'dvispk',
  'bibtex',
  'upbibtex',
  'biber',
  'mendex',
  'makeindex',
  'upmendex'
] as const;

/** Result of parsing a command line without delegating any work to a shell. */
export interface ParsedCommandLine {
  executable: string;
  args: string[];
}

/** A malformed `%#!` command is rejected before the build starts. */
export class CommandLineParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandLineParseError';
  }
}

/**
 * Splits a command line into an executable and arguments. Single and double
 * quotes group whitespace and are removed; a backslash only escapes a matching
 * quote, so Windows paths retain their directory separators.
 */
export function parseCommandLine(commandLine: string): ParsedCommandLine {
  const tokens: string[] = [];
  let token = '';
  let tokenStarted = false;
  let quote: '"' | "'" | undefined;

  for (let offset = 0; offset < commandLine.length; offset++) {
    const char = commandLine[offset];
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else if (char === '\\' && commandLine[offset + 1] === quote) {
        token += quote;
        offset++;
      } else {
        token += char;
      }
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(token);
        token = '';
        tokenStarted = false;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (char === '\\' && (commandLine[offset + 1] === '"' || commandLine[offset + 1] === "'")) {
      token += commandLine[offset + 1];
      tokenStarted = true;
      offset++;
      continue;
    }
    token += char;
    tokenStarted = true;
  }

  if (quote) {
    throw new CommandLineParseError(`Unclosed ${quote} quote in command line.`);
  }
  if (tokenStarted) {
    tokens.push(token);
  }
  if (!tokens[0]) {
    throw new CommandLineParseError('The command line does not contain an executable program.');
  }
  return { executable: tokens[0], args: tokens.slice(1) };
}

/** Returns the next action separator, ignoring semicolons inside quoted args. */
export function findCommandSeparator(commandLine: string, start = 0): number {
  let quote: '"' | "'" | undefined;
  for (let offset = start; offset < commandLine.length; offset++) {
    const char = commandLine[offset];
    if (quote) {
      if (char === '\\' && commandLine[offset + 1] === quote) {
        offset++;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ';') {
      return offset;
    }
  }
  if (quote) {
    throw new CommandLineParseError(`Unclosed ${quote} quote in command line.`);
  }
  return -1;
}

/** A one-token `%#!` directive selects the engine for the standard pipeline. */
export function singleProgramFromDirective(directive: string): string | undefined {
  if (findCommandSeparator(directive) >= 0 || directive.trimStart().startsWith('$(')) {
    return undefined;
  }
  const parsed = parseCommandLine(directive);
  return parsed.args.length === 0 ? parsed.executable : undefined;
}

/** Tests membership literally; only a standalone `*` wildcard permits all. */
export function isProgramAllowed(program: string, allowedPrograms: readonly string[]): boolean {
  const normalized = allowedPrograms.map((entry) => entry.trim()).filter(Boolean);
  return normalized.includes('*') || normalized.includes(program);
}

/** Throws a user-facing preflight error for a disallowed `%#` program. */
export function assertProgramAllowed(
  program: string,
  allowedPrograms: readonly string[],
  directive: string
): void {
  if (!isProgramAllowed(program, allowedPrograms)) {
    throw new Error(
      `Program "${program}" from ${directive} is not allowed by vscode-fortex.compile.allowedPrograms.`
    );
  }
}
