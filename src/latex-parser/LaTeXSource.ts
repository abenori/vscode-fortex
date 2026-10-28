import SourceScanner from './SourceScanner';
import type { SourceRange } from './SourceScanner';
import ArgumentScanner from './ArgumentScanner';
import DefinitionParser from './DefinitionParser';
import DocumentParser from './DocumentParser';
import EnvironmentParser from './EnvironmentParser';
import type { EnvironmentTokenStyle } from './EnvironmentParser';
import ReferenceParser from './ReferenceParser';

/** Shared lexical indexes and lazy parsers for one immutable source snapshot. */
export default class LaTeXSource {
  public readonly sourceScanner: SourceScanner;
  private argumentsScanner?: ArgumentScanner;
  private definitions?: DefinitionParser;
  private document?: DocumentParser;
  private references?: ReferenceParser;

  public constructor(source: string | SourceScanner) {
    this.sourceScanner = typeof source === 'string' ? new SourceScanner(source) : source;
  }

  public get source(): string {
    return this.sourceScanner.source;
  }

  public get argumentScanner(): ArgumentScanner {
    return this.argumentsScanner ??= new ArgumentScanner(this.sourceScanner);
  }

  public get definitionParser(): DefinitionParser {
    return this.definitions ??= new DefinitionParser(this.sourceScanner, this.argumentScanner);
  }

  public get documentParser(): DocumentParser {
    return this.document ??= new DocumentParser(this.sourceScanner, this.argumentScanner);
  }

  public get referenceParser(): ReferenceParser {
    return this.references ??= new ReferenceParser(this.sourceScanner, this.argumentScanner);
  }

  /** Exclusions and enabled styles affect pairing, so each request is independent. */
  public createEnvironmentParser(
    excludedRanges: readonly SourceRange[] = [],
    styles?: readonly EnvironmentTokenStyle[]
  ): EnvironmentParser {
    return new EnvironmentParser(this.sourceScanner, excludedRanges, styles, this.argumentScanner);
  }
}
