import SourceScanner from './SourceScanner';
import type { SourceRange } from './SourceScanner';
import ArgumentScanner from './ArgumentScanner';
import DefinitionParser from './DefinitionParser';
import DocumentParser from './DocumentParser';
import EnvironmentParser from './EnvironmentParser';
import type { EnvironmentTokenStyle } from './EnvironmentParser';
import ReferenceParser from './ReferenceParser';

/** 1つの不変ソースに対する字句索引と，必要になった時点で実行する共有パーサ． */
export default class LaTeXSource {
  /** コメントとリテラル範囲を認識する共有字句解析器． */
  public readonly sourceScanner: SourceScanner;
  /** 必要に応じて作成する共有の引数解析器． */
  private argumentsScanner?: ArgumentScanner;
  /** 必要になった時点で作成する共有の定義解析器． */
  private definitions?: DefinitionParser;
  /** 必要になった時点で作成する文書宣言解析器． */
  private document?: DocumentParser;
  /** 必要になった時点で作成するラベル・参照解析器． */
  private references?: ReferenceParser;

  /**
   * LaTeXSourceの初期状態と所有するリソースを準備する．
   * @param source 解析対象の本文，または同じ本文をすでに走査した字句解析器．
   * @returns 新しいインスタンス．コンストラクタから明示的な値は返さない．
   */
  public constructor(source: string | SourceScanner) {
    this.sourceScanner = typeof source === 'string' ? new SourceScanner(source) : source;
  }

  /**
   * 解析対象の元のソース文字列を取得する．
   * 引数はない．
   * @returns コメントやリテラルを含む元のソース全文．
   */
  public get source(): string {
    return this.sourceScanner.source;
  }

  /**
   * 共有する引数解析器を必要になった時点で作成する．
   * 引数はない．
   * @returns 同じソースに対する引数区切りの解析器．
   */
  public get argumentScanner(): ArgumentScanner {
    return this.argumentsScanner ??= new ArgumentScanner(this.sourceScanner);
  }

  /**
   * 共有する定義解析器を必要になった時点で作成する．
   * 引数はない．
   * @returns 同じソースに対するコマンド・環境定義の解析器．
   */
  public get definitionParser(): DefinitionParser {
    return this.definitions ??= new DefinitionParser(this.sourceScanner, this.argumentScanner);
  }

  /**
   * 共有する文書宣言解析器を必要になった時点で作成する．
   * 引数はない．
   * @returns 同じソースに対するクラス・パッケージ・入力宣言の解析器．
   */
  public get documentParser(): DocumentParser {
    return this.document ??= new DocumentParser(this.sourceScanner, this.argumentScanner);
  }

  /**
   * 共有する参照解析器を必要になった時点で作成する．
   * 引数はない．
   * @returns 同じソースに対するラベル・参照の解析器．
   */
  public get referenceParser(): ReferenceParser {
    return this.references ??= new ReferenceParser(this.sourceScanner, this.argumentScanner);
  }

  /**
   * 除外範囲と有効な記法が対応付けに影響するため，要求ごとに独立した解析器を作る．
   * @param excludedRanges 環境の対応付けから除外するソース範囲．省略時は[]．
   * @param styles 認識を有効にする環境・数式区切りの記法．省略可能．
   * @returns 指定した除外範囲と記法を適用した，新しい環境解析器．
   */
  public createEnvironmentParser(
    excludedRanges: readonly SourceRange[] = [],
    styles?: readonly EnvironmentTokenStyle[]
  ): EnvironmentParser {
    return new EnvironmentParser(this.sourceScanner, excludedRanges, styles, this.argumentScanner);
  }
}
