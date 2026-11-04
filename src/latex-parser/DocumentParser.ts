import SourceScanner from './SourceScanner';
import type { SourceRange } from './SourceScanner';
import ArgumentScanner from './ArgumentScanner';
import type { ScannedArgument } from './ArgumentScanner';

export type DocumentCommand = 'documentclass' | 'usepackage' | 'RequirePackage'
  | 'input' | 'include' | 'bibliography' | 'addbibresource';

export type DocumentDeclarationKind = 'documentClass' | 'package' | 'include' | 'bibliography';

/** 元の本文から区切りを除き，コメントと改行は保持する． */
export interface DocumentArgument extends SourceRange {
  /** bracedは波括弧，bracketedは角括弧で囲む引数． */
  readonly form: 'braced' | 'bracketed';
  /** 区切り記号を除く本文の開始位置．元ソースのUTF-16単位． */
  readonly contentStart: number;
  /** 区切り記号を除く本文の終端．このUTF-16位置は含まない． */
  readonly contentEnd: number;
  /** 区切り記号を除き，コメントと改行を保持した元の本文． */
  readonly raw: string;
  /** 必要な引数と閉じ区切りがそろっている場合はtrue． */
  readonly complete: boolean;
}

/** 編集中の不完全な宣言も含め，字句として読み取った文書宣言． */
export interface DocumentDeclaration extends SourceRange {
  /** この項目の種別を表す識別値． */
  readonly kind: DocumentDeclarationKind;
  /** この宣言に使用されたLaTeXコマンド名． */
  readonly command: DocumentCommand;
  /** 宣言に星印が付いている場合はtrue． */
  readonly starred: boolean;
  /** 宣言に付随する省略可能引数．指定がなければ未設定． */
  readonly options?: DocumentArgument;
  /** クラス名・パッケージ名・ファイル名などを記述する必須引数． */
  readonly argument?: DocumentArgument;
  /** 要求する版を記述する末尾の省略可能引数． */
  readonly version?: DocumentArgument;
  /** 本文の妥当性ではなく，必要な引数の有無と閉じているかを表す． */
  readonly complete: boolean;
}

interface DeclarationSyntax {
  /** この項目の種別を表す識別値． */
  readonly kind: DocumentDeclarationKind;
  /** 先頭の省略可能引数を受け付ける場合はtrue． */
  readonly options?: boolean;
  /** 末尾の版指定用の省略可能引数を受け付ける場合はtrue． */
  readonly version?: boolean;
  /** 星付きの記法を受け付ける場合はtrue． */
  readonly star?: boolean;
}

const declarationSyntax = new Map<DocumentCommand, DeclarationSyntax>([
  ['documentclass', { kind: 'documentClass', options: true, version: true }],
  ['usepackage', { kind: 'package', options: true, version: true }],
  ['RequirePackage', { kind: 'package', options: true, version: true }],
  ['input', { kind: 'include' }],
  ['include', { kind: 'include' }],
  ['bibliography', { kind: 'bibliography' }],
  ['addbibresource', { kind: 'bibliography', options: true, star: true }]
]);

/**
 * マクロ展開やパス解決を行わず，文書宣言を抽出する．ソース順と重複を保持し，カンマ区切りの名前も1つの引数として返す．名前・オプション・ファイル名の解釈は呼び出し側で行う．
 * 入力ファイル名には波括弧が必要で，波括弧がなければ不完全な宣言として扱う．SourceScannerと同様に，マクロ定義の本文は通常のソースとして扱う．
 * 閉じた宣言引数の内部は別の宣言として走査せず，不完全な引数があっても後続のコマンドから復帰できる．
 */
export default class DocumentParser {
  /** 解析対象の元のソース本文． */
  public readonly source: string;
  /** 出現順に抽出した文書クラス・パッケージ・入力の宣言． */
  public readonly declarations: readonly DocumentDeclaration[];

  /**
   * DocumentParserの初期状態と所有するリソースを準備する．
   * @param source 解析対象の本文，または同じ本文をすでに走査した字句解析器．
   * @param sharedArgumentsScanner すでに作成した引数解析器．省略時は新しく作成する．
   * @returns 新しいインスタンス．コンストラクタから明示的な値は返さない．
   */
  public constructor(source: string | SourceScanner, sharedArgumentsScanner?: ArgumentScanner) {
    const scanner = typeof source === 'string' ? new SourceScanner(source) : source;
    const argumentsScanner = sharedArgumentsScanner ?? new ArgumentScanner(scanner);
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
        argument = this.argument(argumentsScanner.readArgument(cursor));
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

  /**
   * 読み取った括弧引数を文書宣言の引数情報へ変換する．
   * @param group 区切りを含む引数の範囲，本文の範囲，および閉じ区切りの有無．省略可能．
   * @returns 記法，元の本文，範囲，および閉鎖状態．引数がなければundefined．
   */
  private argument(group: ScannedArgument | undefined): DocumentArgument | undefined {
    return group && {
      form: group.opening === '{' ? 'braced' : 'bracketed',
      start: group.start, end: group.end,
      contentStart: group.contentStart, contentEnd: group.contentEnd,
      raw: this.source.slice(group.contentStart, group.contentEnd),
      complete: group.complete
    };
  }
}
