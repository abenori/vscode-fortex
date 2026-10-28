import LaTeXSource from '../latex-parser/LaTeXSource';
import type { DefinitionDeclaration } from '../latex-parser/DefinitionParser';
import type { MacroBinding } from '../latex-parser/InputFilename';
export type { MacroBinding, MacroLookup } from '../latex-parser/InputFilename';

/** The supported, position-dependent subset of TeX's command definitions. */
export class MacroState {
  private readonly bindings = new Map<string, MacroBinding>();
  private readonly scopes: Map<string, MacroBinding | undefined>[] = [];

  public lookup(name: string): MacroBinding | undefined {
    return this.bindings.get(name);
  }

  public pushScope(): void {
    this.scopes.push(new Map());
  }

  public popScope(): void {
    const previous = this.scopes.pop();
    if (!previous) { return; }
    for (const [name, binding] of previous) {
      if (binding) { this.bindings.set(name, binding); }
      else { this.bindings.delete(name); }
    }
  }

  public apply(source: LaTeXSource, definition: DefinitionDeclaration): void {
    const { command, name } = definition;
    if ((command === 'providecommand' || command === 'provideenvironment') && this.bindings.has(name)) { return; }
    const global = command === 'gdef' || command === 'xdef';
    if (global) {
      // A global assignment also survives every currently open local group.
      for (const scope of this.scopes) { scope.delete(name); }
    } else {
      const scope = this.scopes.at(-1);
      if (scope && !scope.has(name)) { scope.set(name, this.bindings.get(name)); }
    }
    const body = definition.bodyRanges[0];
    const classic = command === 'newcommand' || command === 'renewcommand' || command === 'providecommand';
    const primitive = command === 'def' || command === 'gdef';
    const simpleParameters = body && source.sourceScanner
      .textWithoutComments(definition.nameEnd, body.start - 1)?.trim() === '';
    const supported = definition.kind === 'command' && definition.complete && definition.argumentCount === 0
      && !definition.optionalFirstArgument && body && (classic || (primitive && simpleParameters));
    // Unsupported declarations must shadow earlier resolvable definitions.
    this.bindings.set(name, supported
      ? { kind: 'replacement', source, body }
      : { kind: 'opaque' });
  }
}
