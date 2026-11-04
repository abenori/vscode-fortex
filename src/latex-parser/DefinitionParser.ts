import SourceScanner, { readCommand } from './SourceScanner';
import type { CommandToken, SourceRange } from './SourceScanner';
import ArgumentScanner from './ArgumentScanner';
import type { ArgumentOpening, ScannedArgument } from './ArgumentScanner';
import {
  CLASSIC_COMMAND_DECLARATIONS, CLASSIC_ENVIRONMENT_DECLARATIONS,
  DOCUMENT_COMMAND_DECLARATIONS, DOCUMENT_ENVIRONMENT_DECLARATIONS, PRIMITIVE_COMMAND_DECLARATIONS
} from './DefinitionCommands';

/** マクロ展開やxparseの引数仕様の解釈を行わず，字句として読み取った定義宣言． */
export interface DefinitionDeclaration extends SourceRange {
  /** この項目の種別を表す識別値． */
  readonly kind: 'command' | 'environment' | 'theorem';
  /** この定義に使用された宣言コマンドの名前． */
  readonly command: string;
  /** コマンド名は先頭のバックスラッシュを含めない． */
  readonly name: string;
  /** 名前部分の開始位置．元ソースのUTF-16単位． */
  readonly nameStart: number;
  /** 名前部分の終端．このUTF-16位置は含まない． */
  readonly nameEnd: number;
  /** 必要な引数と閉じ区切りがそろっている場合はtrue． */
  readonly complete: boolean;
  /** 完全に読み取った先頭部分の終端．閉じていない引数は含めない． */
  readonly consumedEnd: number;
  /** 閉じている定義本文の範囲．外側の波括弧は含めず，不完全な入力からの復帰のため，閉じていない本文は除外する． */
  readonly bodyRanges: readonly SourceRange[];
  /** 定義された引数の個数．不明な定義形式では未設定． */
  readonly argumentCount?: number;
  /** 先頭の引数に省略可能な既定値がある場合はtrue． */
  readonly optionalFirstArgument?: boolean;
  /** コメントと改行を保持した，定理の題名の元の表記． */
  readonly title?: string;
}

const classicCommands = new Set<string>(CLASSIC_COMMAND_DECLARATIONS);
const classicEnvironments = new Set<string>(CLASSIC_ENVIRONMENT_DECLARATIONS);
const documentCommands = new Set<string>(DOCUMENT_COMMAND_DECLARATIONS);
const documentEnvironments = new Set<string>(DOCUMENT_ENVIRONMENT_DECLARATIONS);
const primitiveCommands = new Set<string>(PRIMITIVE_COMMAND_DECLARATIONS);
const definitionCommands = new Set([
  ...classicCommands, ...classicEnvironments, ...documentCommands,
  ...documentEnvironments, ...primitiveCommands, 'DeclareMathOperator', 'newtheorem'
]);

interface DefinitionName {
  /** 対象の名前． */
  readonly name: string;
  /** 名前部分の開始位置．元ソースのUTF-16単位． */
  readonly nameStart: number;
  /** 名前部分の終端．このUTF-16位置は含まない． */
  readonly nameEnd: number;
}

/**
 * コマンド・環境・定理の定義をソース順に探す．閉じた引数は一度だけ読み取り，定義本文内の宣言を別の候補として扱わない．閉じていない引数の後の宣言は復帰のために解析できるよう残す．
 * すべての範囲は元ソースのUTF-16位置で表す．
 */
export default class DefinitionParser {
  /** 解析対象の元のソース本文． */
  public readonly source: string;
  /** 出現順に抽出したコマンド・環境・定理の定義． */
  public readonly definitions: readonly DefinitionDeclaration[];
  /** 認識した構文のうち，完全に読み取った先頭部分の範囲．不正な名前の宣言も含む． */
  public readonly consumedRanges: readonly SourceRange[];

  /**
   * DefinitionParserの初期状態と所有するリソースを準備する．
   * @param source 解析対象の本文，または同じ本文をすでに走査した字句解析器．
   * @param sharedArgumentsScanner すでに作成した引数解析器．省略時は新しく作成する．
   * @returns 新しいインスタンス．コンストラクタから明示的な値は返さない．
   */
  public constructor(source: string | SourceScanner, sharedArgumentsScanner?: ArgumentScanner) {
    const scanner = typeof source === 'string' ? new SourceScanner(source) : source;
    const argumentsScanner = sharedArgumentsScanner ?? new ArgumentScanner(scanner);
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
  /** 完全に読み取った部分の直後を表すUTF-16位置． */
  public consumedEnd = 0;
  /** 次に読み取る位置．元ソースのUTF-16単位． */
  private cursor: number;
  /** 元ソースにおける範囲の終端．0始まりのUTF-16単位で，この位置を含まない． */
  private end: number;
  /** 必要な引数と閉じ区切りがそろっている場合はtrue． */
  private complete = true;
  /** 未完了の必須引数により後続の読み取りを停止した場合はtrue． */
  private blocked = false;
  /** 完全に閉じた定義本文の範囲．外側の波括弧は含まない． */
  private readonly bodyRanges: SourceRange[] = [];

  /**
   * DefinitionReaderの初期状態と所有するリソースを準備する．
   * @param scanner 元のソースに対する共有字句解析結果．
   * @param argumentsScanner 同じソースに対する引数区切りの解析器．
   * @param token 元ソース中の対象トークンとその範囲．
   * @returns 新しいインスタンス．コンストラクタから明示的な値は返さない．
   */
  public constructor(
    /** 同じソースに対する共有字句解析器． */
    private readonly scanner: SourceScanner,
    /** 必要に応じて作成する共有の引数解析器． */
    private readonly argumentsScanner: ArgumentScanner,
    /** 処理のキャンセル状態を確認するトークン． */
    private readonly token: CommandToken
  ) {
    this.cursor = this.end = token.end;
    this.consumedEnd = token.end;
  }

  /**
   * 現在の定義宣言から名前，引数，および本文の情報を読み取る．
   * 引数はない．
   * @returns コマンド・環境・定理の定義情報．名前を読めなければundefined．
   */
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
      // 区切り・引数処理器・入れ子の既定値は，mの個数だけでは解析できない．引数仕様を未設定にし，補完では名前だけを挿入する．
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

  /**
   * 定義宣言の対象となるコマンド名を読み取る．
   * @param allowGroup コマンド名を囲む波括弧を許可する場合はtrue．
   * @returns 先頭のバックスラッシュを除く名前とその範囲．不正ならundefined．
   */
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

  /**
   * 定義宣言の必須引数から環境名を読み取る．
   * 引数はない．
   * @returns 環境名と元ソース内の名前の範囲．不正な名前ならundefined．
   */
  private readEnvironmentName(): DefinitionName | undefined {
    const group = this.readGroup('{', true);
    if (!group) {
      return undefined;
    }
    const name = this.scanner.textWithoutComments(group.contentStart, group.contentEnd)?.trim() ?? '';
    if (!name || /[\s{}\\]/.test(name)) {
      return undefined;
    }
    // コメントで行が継続する場合も，マスクされた空白を使って元の名前の範囲を求める．
    const masked = this.scanner.maskedSource.slice(group.contentStart, group.contentEnd);
    const nameStart = group.contentStart + masked.length - masked.trimStart().length;
    const nameEnd = group.contentEnd - (masked.length - masked.trimEnd().length);
    return { name, nameStart, nameEnd };
  }

  /**
   * 定義宣言の次の引数を読み取り，宣言の完全性と消費位置を更新する．
   * @param opening 読み取る引数の開き区切り．{は必須引数，[は省略可能引数．
   * @param required 欠落した引数を不完全な宣言として扱う場合はtrue．
   * @returns 読み取った引数．欠落または先行する不完全な引数により読めなければundefined．
   */
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

  /**
   * 閉じた定義本文の範囲を登録し，読み取り位置を進める．
   * 引数はない．
   * @returns なし．
   */
  private readBody(): void {
    const body = this.readGroup('{', true);
    if (body?.complete) {
      this.bodyRanges.push({ start: body.contentStart, end: body.contentEnd });
    }
  }

  /**
   * 定義宣言の省略可能引数から引数の個数を読み取る．
   * @param group 区切りを含む引数の範囲，本文の範囲，および閉じ区切りの有無．
   * @returns 0から9までの整数．不正な指定ならundefined．
   */
  private readArgumentCount(group: ScannedArgument): number | undefined {
    const text = this.scanner.textWithoutComments(group.contentStart, group.contentEnd)?.trim() ?? '';
    const count = /^[0-9]+$/.test(text) ? Number.parseInt(text, 10) : Number.NaN;
    return Number.isInteger(count) && count <= 9 ? count : undefined;
  }

  /**
   * TeXプリミティブ定義のパラメータと本文を読み取る．
   * 引数はない．
   * @returns 現れた最大のパラメータ番号．本文を読めなければundefined．
   */
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
