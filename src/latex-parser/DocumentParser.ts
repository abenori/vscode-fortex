import SourceScanner from './SourceScanner';
import type { SourceRange } from './SourceScanner';
import ArgumentScanner from './ArgumentScanner';
import type { ScannedArgument } from './ArgumentScanner';

export type DocumentCommand = 'documentclass' | 'usepackage' | 'RequirePackage'
  | 'input' | 'include' | 'bibliography' | 'addbibresource';

export type DocumentDeclarationKind = 'documentClass' | 'package' | 'include' | 'bibliography';

/** Raw content excludes the delimiters and preserves comments and line endings. */
export interface DocumentArgument extends SourceRange {
  readonly form: 'braced' | 'bracketed' | 'bare';
  readonly contentStart: number;
  readonly contentEnd: number;
  readonly raw: string;
  readonly complete: boolean;
}

/** A lexical declaration, including partial declarations during editing. */
export interface DocumentDeclaration extends SourceRange {
  readonly kind: DocumentDeclarationKind;
  readonly command: DocumentCommand;
  readonly starred: boolean;
  readonly options?: DocumentArgument;
  readonly argument?: DocumentArgument;
  readonly version?: DocumentArgument;
  /** Presence/closure of arguments, rather than validity of their contents. */
  readonly complete: boolean;
}

interface DeclarationSyntax {
  readonly kind: DocumentDeclarationKind;
  readonly options?: boolean;
  readonly version?: boolean;
  readonly bare?: boolean;
  readonly star?: boolean;
}

const declarationSyntax = new Map<DocumentCommand, DeclarationSyntax>([
  ['documentclass', { kind: 'documentClass', options: true, version: true }],
  ['usepackage', { kind: 'package', options: true, version: true }],
  ['RequirePackage', { kind: 'package', options: true, version: true }],
  ['input', { kind: 'include', bare: true }],
  ['include', { kind: 'include' }],
  ['bibliography', { kind: 'bibliography' }],
  ['addbibresource', { kind: 'bibliography', options: true, star: true }]
]);

/**
 * Extracts document declarations without expanding macros or resolving paths.
 * Results retain source order and duplicates. Comma-separated names remain one
 * raw argument; callers decide how to interpret names, options and filenames.
 * As with SourceScanner, macro definition bodies are ordinary source. Completed
 * declaration arguments are not scanned as independent declarations. Incomplete
 * arguments do not prevent later commands from being recovered.
 */
export default class DocumentParser {
  public readonly source: string;
  public readonly declarations: readonly DocumentDeclaration[];

  public constructor(source: string | SourceScanner) {
    const scanner = typeof source === 'string' ? new SourceScanner(source) : source;
    const argumentsScanner = new ArgumentScanner(scanner);
    this.source = scanner.source;
    const declarations: DocumentDeclaration[] = [];
    let consumedEnd = 0;

    for (const token of scanner.commands) {
      if (token.start < consumedEnd) {
        continue;
      }
      const command = token.name as DocumentCommand;
      const syntax = declarationSyntax.get(command);
      if (!syntax) {
        continue;
      }
      let cursor = token.end;
      let end = token.end;
      let starred = false;
      let options: DocumentArgument | undefined;
      let argument: DocumentArgument | undefined;
      let version: DocumentArgument | undefined;
      if (syntax.star) {
        const star = argumentsScanner.readStar(cursor);
        if (star?.starred) {
          starred = true;
          cursor = end = star.end;
        }
      }
      if (syntax.options) {
        options = this.argument(argumentsScanner.readArgument(cursor, '['));
        if (options) {
          cursor = end = options.end;
          if (options.complete) {
            consumedEnd = options.end;
          }
        }
      }
      if (!options || options.complete) {
        argument = syntax.bare
          ? this.readInputArgument(scanner, argumentsScanner, cursor)
          : this.argument(argumentsScanner.readArgument(cursor));
        if (argument) {
          cursor = end = argument.end;
          if (argument.complete) {
            consumedEnd = argument.end;
            if (syntax.version) {
              version = this.argument(argumentsScanner.readArgument(cursor, '['));
              if (version) {
                end = version.end;
                if (version.complete) {
                  consumedEnd = version.end;
                }
              }
            }
          }
        }
      }
      declarations.push({
        kind: syntax.kind, command, start: token.start, end,
        starred, options, argument, version,
        complete: Boolean(argument?.complete)
          && (!options || options.complete) && (!version || version.complete)
      });
    }
    this.declarations = declarations;
  }

  private argument(group: ScannedArgument | undefined): DocumentArgument | undefined {
    return group && {
      form: group.opening === '{' ? 'braced' : 'bracketed',
      start: group.start, end: group.end,
      contentStart: group.contentStart, contentEnd: group.contentEnd,
      raw: this.source.slice(group.contentStart, group.contentEnd),
      complete: group.complete
    };
  }

  /**
   * Reads a braced input argument first, retaining an incomplete group. Only a
   * missing group falls back to a bare filename token ending at whitespace, a
   * comment or a control/group boundary. Quotes and TeX filename expansion are
   * not decoded; comment continuation in a bare filename is not interpreted.
   */
  private readInputArgument(scanner: SourceScanner, argumentsScanner: ArgumentScanner, offset: number): DocumentArgument | undefined {
    const group = argumentsScanner.readArgument(offset);
    if (group) {
      return this.argument(group);
    }
    const start = scanner.skipTrivia(offset);
    if (start === undefined || scanner.maskedSource[start] !== this.source[start]) {
      return undefined;
    }
    let end = start;
    while (end < this.source.length && !/[\s%\\{}]/.test(this.source[end])) {
      end++;
    }
    return end === start ? undefined : {
      form: 'bare', start, end, contentStart: start, contentEnd: end,
      raw: this.source.slice(start, end), complete: true
    };
  }
}
