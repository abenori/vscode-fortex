import LaTeXSource from '../latex-parser/LaTeXSource';
import type { DefinitionDeclaration } from '../latex-parser/DefinitionParser';
import type { MacroBinding } from '../latex-parser/InputFilename';
export type { MacroBinding, MacroLookup } from '../latex-parser/InputFilename';

/** 対応するTeX定義の一部を，ソース位置に応じた状態として保持する． */
export class MacroState {
  /** 現在のスコープで有効なマクロ名から束縛への表． */
  private readonly bindings = new Map<string, MacroBinding>();
  /** 各ローカルスコープの開始前の束縛を復元するための履歴． */
  private readonly scopes: Map<string, MacroBinding | undefined>[] = [];

  /**
   * 現在のスコープで有効なマクロの束縛を取得する．
   * @param name 対象を識別する名前．
   * @returns 置換本文または展開不可を表す束縛．未定義ならundefined．
   */
  public lookup(name: string): MacroBinding | undefined {
    return this.bindings.get(name);
  }

  /**
   * ローカルなマクロ定義を記録する新しいスコープを開始する．
   * 引数はない．
   * @returns なし．
   */
  public pushScope(): void {
    this.scopes.push(new Map());
  }

  /**
   * 現在のスコープを閉じ，その中で変更したマクロの束縛を復元する．
   * 引数はない．
   * @returns なし．
   */
  public popScope(): void {
    const previous = this.scopes.pop();
    if (!previous) { return; }
    for (const [name, binding] of previous) {
      if (binding) { this.bindings.set(name, binding); }
      else { this.bindings.delete(name); }
    }
  }

  /**
   * 認識した定義をファイル名展開用のマクロ状態へ反映する．
   * @param source 読み取りと範囲の基準となる共有LaTeXソース．
   * @param definition コマンド・環境・定理の定義名，引数情報，および読み取った本文の範囲．
   * @returns なし．
   */
  public apply(source: LaTeXSource, definition: DefinitionDeclaration): void {
    const { command, name } = definition;
    if ((command === 'providecommand' || command === 'provideenvironment') && this.bindings.has(name)) { return; }
    const global = command === 'gdef' || command === 'xdef';
    if (global) {
      // 大域的な代入は，現在開いているすべてのローカルグループを抜けても有効なままにする．
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
    // 非対応の宣言でも，同名の以前の展開可能な定義を隠す必要がある．
    this.bindings.set(name, supported
      ? { kind: 'replacement', source, body }
      : { kind: 'opaque' });
  }
}
