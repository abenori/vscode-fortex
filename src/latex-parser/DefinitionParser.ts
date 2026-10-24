import SourceScanner, { readCommand } from './SourceScanner';
import type { CommandToken, SourceRange } from './SourceScanner';
import ArgumentScanner from './ArgumentScanner';
import type { ArgumentOpening, ScannedArgument } from './ArgumentScanner';

/** A lexical definition, without macro expansion or interpretation of xparse specifications. */
export interface DefinitionDeclaration extends SourceRange {
  readonly kind: 'command' | 'environment' | 'theorem';
  readonly command: string;
  /** Command names exclude their leading backslash. */
  readonly name: string;
  readonly nameStart: number;
  readonly nameEnd: number;
  readonly complete: boolean;
  /** End of the fully consumed prefix, before any unclosed argument. */
  readonly consumedEnd: number;
  /** Closed definition bodies, excluding their braces. Unclosed bodies are omitted for recovery. */
  readonly bodyRanges: readonly SourceRange[];
  readonly argumentCount?: number;
  readonly optionalFirstArgument?: boolean;
  /** Raw theorem title, preserving comments and line endings. */
  readonly title?: string;
}

const classicCommands = new Set(['newcommand', 'renewcommand', 'providecommand', 'DeclareRobustCommand']);
const classicEnvironments = new Set(['newenvironment', 'renewenvironment', 'provideenvironment']);
const documentCommands = new Set([
  'NewDocumentCommand', 'RenewDocumentCommand', 'ProvideDocumentCommand', 'DeclareDocumentCommand',
  'NewExpandableDocumentCommand', 'RenewExpandableDocumentCommand',
  'ProvideExpandableDocumentCommand', 'DeclareExpandableDocumentCommand'
]);
const documentEnvironments = new Set([
  'NewDocumentEnvironment', 'RenewDocumentEnvironment', 'ProvideDocumentEnvironment', 'DeclareDocumentEnvironment'
]);
const primitiveCommands = new Set(['def', 'gdef', 'edef', 'xdef']);
const definitionCommands = new Set([
  ...classicCommands, ...classicEnvironments, ...documentCommands,
  ...documentEnvironments, ...primitiveCommands, 'DeclareMathOperator', 'newtheorem'
]);

interface DefinitionName {
  readonly name: string;
  readonly nameStart: number;
  readonly nameEnd: number;
}

/**
 * Finds command, environment and theorem declarations in source order. Completed
 * arguments are consumed once, so declarations inside definition bodies do not
 * become independent candidates. An unclosed argument leaves later declarations
 * available for recovery while editing. All ranges use original UTF-16 offsets.
 */
export default class DefinitionParser {
  public readonly source: string;
  public readonly definitions: readonly DefinitionDeclaration[];
  /** Fully consumed prefixes of recognized syntax, including invalid names. */
  public readonly consumedRanges: readonly SourceRange[];

  public constructor(source: string | SourceScanner) {
    const scanner = typeof source === 'string' ? new SourceScanner(source) : source;
    const argumentsScanner = new ArgumentScanner(scanner);
    this.source = scanner.source;
    const definitions: DefinitionDeclaration[] = [];
    const consumedRanges: SourceRange[] = [];
    let consumedEnd = 0;
    for (const token of scanner.commands) {
      if (token.start < consumedEnd || !definitionCommands.has(token.name)) {
        continue;
      }
      const reader = new DefinitionReader(scanner, argumentsScanner, token);
      const definition = reader.read();
      consumedEnd = Math.max(consumedEnd, reader.consumedEnd);
      consumedRanges.push({ start: token.start, end: reader.consumedEnd });
      if (definition) {
        definitions.push(definition);
      }
    }
    this.definitions = definitions;
    this.consumedRanges = consumedRanges;
  }
}

class DefinitionReader {
  public consumedEnd = 0;
  private cursor: number;
  private end: number;
  private complete = true;
  private blocked = false;
  private readonly bodyRanges: SourceRange[] = [];

  public constructor(
    private readonly scanner: SourceScanner,
    private readonly argumentsScanner: ArgumentScanner,
    private readonly token: CommandToken
  ) {
    this.cursor = this.end = token.end;
    this.consumedEnd = token.end;
  }

  public read(): DefinitionDeclaration | undefined {
    const command = this.token.name;
    const environment = classicEnvironments.has(command) || documentEnvironments.has(command);
    const theorem = command === 'newtheorem';
    const primitive = primitiveCommands.has(command);
    const xparse = documentCommands.has(command) || documentEnvironments.has(command);
    if (!primitive && !xparse) {
      const star = this.argumentsScanner.readStar(this.cursor);
      if (star?.starred) {
        this.cursor = this.end = star.end;
      }
    }
    const name = environment || theorem ? this.readEnvironmentName() : this.readCommandName(!primitive);
    if (!name && this.consumedEnd === this.token.end) {
      return undefined;
    }
    let argumentCount: number | undefined;
    let optionalFirstArgument: boolean | undefined;
    let title: string | undefined;
    if (theorem) {
      const sharedCounter = this.readGroup('[', false);
      const heading = this.readGroup('{', true);
      if (heading) {
        title = this.scanner.source.slice(heading.contentStart, heading.contentEnd);
      }
      if (!sharedCounter) {
        this.readGroup('[', false);
      }
    } else if (primitive) {
      argumentCount = this.readPrimitiveBody();
      optionalFirstArgument = false;
    } else if (xparse) {
      // Delimiters, processors and nested defaults require more than counting m's.
      // Leave the signature unspecified so completion inserts only the name.
      this.readGroup('{', true);
      this.readBody();
      if (environment) {
        this.readBody();
      }
    } else if (command === 'DeclareMathOperator') {
      argumentCount = 0;
      optionalFirstArgument = false;
      this.readBody();
    } else {
      const count = this.readGroup('[', false);
      argumentCount = count
        ? this.readArgumentCount(count)
        : 0;
      const defaultArgument = count ? this.readGroup('[', false) : undefined;
      optionalFirstArgument = Boolean(defaultArgument && argumentCount && argumentCount > 0);
      this.readBody();
      if (environment) {
        this.readBody();
      }
    }
    return name ? {
      ...name, kind: theorem ? 'theorem' : environment ? 'environment' : 'command',
      command, start: this.token.start, end: this.end, complete: this.complete,
      consumedEnd: this.consumedEnd,
      bodyRanges: this.bodyRanges, argumentCount, optionalFirstArgument, title
    } : undefined;
  }

  private readCommandName(allowGroup: boolean): DefinitionName | undefined {
    const group = allowGroup ? this.readGroup('{', false) : undefined;
    const start = this.scanner.skipTrivia(group?.contentStart ?? this.cursor);
    if (start === undefined || (group && start >= group.contentEnd)) {
      return undefined;
    }
    const command = readCommand(this.scanner.source, start);
    if (!command?.name || this.scanner.maskedSource[start] !== '\\') {
      return undefined;
    }
    if (group) {
      if (command.end > group.contentEnd || (group.complete && this.scanner.skipTrivia(command.end) !== group.contentEnd)) {
        return undefined;
      }
    } else {
      this.cursor = this.end = command.end;
      this.consumedEnd = command.end;
    }
    return { name: command.name, nameStart: command.start + 1, nameEnd: command.end };
  }

  private readEnvironmentName(): DefinitionName | undefined {
    const group = this.readGroup('{', true);
    if (!group) {
      return undefined;
    }
    const name = this.scanner.textWithoutComments(group.contentStart, group.contentEnd)?.trim() ?? '';
    if (!name || /[\s{}\\]/.test(name)) {
      return undefined;
    }
    // Masked whitespace locates the original range even for comment continuations.
    const masked = this.scanner.maskedSource.slice(group.contentStart, group.contentEnd);
    const nameStart = group.contentStart + masked.length - masked.trimStart().length;
    const nameEnd = group.contentEnd - (masked.length - masked.trimEnd().length);
    return { name, nameStart, nameEnd };
  }

  private readGroup(opening: ArgumentOpening, required: boolean): ScannedArgument | undefined {
    if (this.blocked) {
      return undefined;
    }
    const group = this.argumentsScanner.readArgument(this.cursor, opening);
    if (!group) {
      if (required) {
        this.complete = false;
        this.blocked = true;
      }
      return undefined;
    }
    this.cursor = this.end = group.end;
    if (group.complete) {
      this.consumedEnd = group.end;
    } else {
      this.complete = false;
      this.blocked = true;
    }
    return group;
  }

  private readBody(): void {
    const body = this.readGroup('{', true);
    if (body?.complete) {
      this.bodyRanges.push({ start: body.contentStart, end: body.contentEnd });
    }
  }

  private readArgumentCount(group: ScannedArgument): number | undefined {
    const text = this.scanner.textWithoutComments(group.contentStart, group.contentEnd)?.trim() ?? '';
    const count = /^[0-9]+$/.test(text) ? Number.parseInt(text, 10) : Number.NaN;
    return Number.isInteger(count) && count <= 9 ? count : undefined;
  }

  private readPrimitiveBody(): number | undefined {
    if (this.blocked) {
      return undefined;
    }
    const parameterStart = this.cursor;
    let cursor = this.cursor;
    while (cursor < this.scanner.source.length) {
      if (this.scanner.maskedSource[cursor] === '{') {
        const parameters = this.scanner.maskedSource.slice(parameterStart, cursor);
        const parameterNumbers = [...parameters.matchAll(/#([1-9])/g)].map(match => Number.parseInt(match[1], 10));
        this.cursor = cursor;
        this.readBody();
        return parameterNumbers.reduce((largest, parameter) => Math.max(largest, parameter), 0);
      }
      if (this.scanner.maskedSource[cursor] === '\\') {
        const command = readCommand(this.scanner.source, cursor)!;
        if (definitionCommands.has(command.name)) {
          break;
        }
        cursor = command.end;
      } else {
        cursor++;
      }
    }
    this.complete = false;
    return undefined;
  }
}
