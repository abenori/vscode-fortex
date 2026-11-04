import SourceScanner from './SourceScanner';
import ArgumentScanner from './ArgumentScanner';
import { splitclist } from './CommaList';

/** 1つのラベルまたは参照キー．位置は元ソースのUTF-16単位で表す． */
export interface ReferenceToken {
  /** この項目の種別を表す識別値． */
  readonly kind: 'label' | 'reference';
  /** 対象のコマンド名または実行ファイル名． */
  readonly command: string;
  /** 参照または検索に使用する識別キー． */
  readonly key: string;
  /** コマンド先頭のバックスラッシュのUTF-16位置． */
  readonly commandStart: number;
  /** 引数を含むコマンド全体の終端．この位置は範囲に含めない． */
  readonly commandEnd: number;
  /** 参照キーの開始位置．元ソースのUTF-16単位． */
  readonly keyStart: number;
  /** 参照キーの終端．このUTF-16位置は含まない． */
  readonly keyEnd: number;
}

const referenceCommands = new Set([
  'ref', 'pageref', 'eqref', 'autoref', 'nameref', 'cref', 'Cref', 'vref', 'Vref'
]);

/**
 * マクロ展開を行わず，完全なラベル・参照宣言を読む．参照は最上位のカンマで分割し，ラベルは1つのキーとして保持する．ソース順と重複を保持する．
 * コメント・リテラル・エスケープされたコマンドはSourceScannerの規則に従い，マクロ定義の本文は通常のソースとして扱う．
 * 元の位置を保つため，キーの範囲には本文から除去したコメントも含める．
 */
export default class ReferenceParser {
  /** 解析対象の元のソース本文． */
  public readonly source: string;
  /** 元ソースに現れた順の解析済みトークン． */
  public readonly tokens: readonly ReferenceToken[];

  /**
   * ReferenceParserの初期状態と所有するリソースを準備する．
   * @param source 解析対象の本文，または同じ本文をすでに走査した字句解析器．
   * @param sharedArgumentsScanner すでに作成した引数解析器．省略時は新しく作成する．
   * @returns 新しいインスタンス．コンストラクタから明示的な値は返さない．
   */
  public constructor(source: string | SourceScanner, sharedArgumentsScanner?: ArgumentScanner) {
    const scanner = typeof source === 'string' ? new SourceScanner(source) : source;
    const argumentsScanner = sharedArgumentsScanner ?? new ArgumentScanner(scanner);
    this.source = scanner.source;
    const tokens: ReferenceToken[] = [];
    let consumedEnd = 0;

    for (const command of scanner.commands) {
      if (command.start < consumedEnd
        || (command.name !== 'label' && !ReferenceParser.isReferenceCommand(command.name))) {
        continue;
      }
      const cursor = command.name === 'label'
        ? command.end
        : argumentsScanner.readStar(command.end)?.end ?? command.end;
      const argument = argumentsScanner.readArgument(cursor);
      if (!argument?.complete) {
        continue;
      }
      consumedEnd = argument.end;
      const segments = command.name === 'label'
        ? [{ start: argument.contentStart, end: argument.contentEnd }]
        : splitclist(scanner, argument.contentStart, argument.contentEnd);
      for (const { start, end } of segments) {
        const key = scanner.textWithoutComments(start, end)?.trim();
        if (!key) {
          continue;
        }
        const keyStart = scanner.skipTrivia(start)!;
        const keyEnd = this.trimKeyEnd(scanner, start, end);
        tokens.push({
          kind: command.name === 'label' ? 'label' : 'reference',
          command: command.name, key, commandStart: command.start,
          commandEnd: argument.end, keyStart, keyEnd
        });
      }
    }
    this.tokens = tokens;
  }

  /**
   * 入力途中の参照を判定する処理と，対応するコマンド名の一覧を共有する．
   * @param name 対象を識別する名前．
   * @returns 名前が対応している参照コマンドであればtrue．
   */
  public static isReferenceCommand(name: string): boolean {
    return referenceCommands.has(name);
  }

  /**
   * 複数キーの参照でコマンド部分や波括弧を選ぶと，最も近いキーを返す．
   * @param offset 対象文字列の先頭を0とするUTF-16位置．
   * @returns 一致するコマンド内で最も近い参照キー．対象外ならundefined．
   */
  public tokenAt(offset: number): ReferenceToken | undefined {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.source.length) {
      return undefined;
    }
    let nearest: ReferenceToken | undefined;
    for (const token of this.tokens) {
      if (token.commandStart > offset) {
        break;
      }
      if (offset <= token.commandEnd
        && (!nearest || distanceFromKey(token, offset) < distanceFromKey(nearest, offset))) {
        nearest = token;
      }
    }
    return nearest;
  }

  /**
   * 参照キー末尾の空白とコメントを取り除いた終端を求める．
   * @param scanner 元のソースに対する共有字句解析結果．
   * @param start 対象範囲の開始位置．UTF-16単位で，範囲に含む．
   * @param end 対象範囲の終端位置．UTF-16単位で，範囲に含まない．
   * @returns キーの最後の有効文字の直後のUTF-16位置．
   */
  private trimKeyEnd(scanner: SourceScanner, start: number, end: number): number {
    let ignoredIndex = lowerBound(scanner.ignoredRanges, end, range => range.start) - 1;
    while (end > start) {
      const ignored = scanner.ignoredRanges[ignoredIndex];
      if (ignored && ignored.start >= end) {
        ignoredIndex--;
      } else if (ignored?.kind === 'comment' && ignored.end >= end) {
        end = Math.max(start, ignored.start);
        ignoredIndex--;
      } else if (/\s/.test(this.source[end - 1])) {
        end--;
      } else {
        break;
      }
    }
    return end;
  }
}

/**
 * 位置と参照キーの範囲の距離を求める．
 * @param token 元ソース中の対象トークンとその範囲．
 * @param offset 対象文字列の先頭を0とするUTF-16位置．
 * @returns 範囲内なら0，範囲外なら近い端までのUTF-16単位の距離．
 */
function distanceFromKey(token: ReferenceToken, offset: number): number {
  return Math.max(token.keyStart - offset, offset - token.keyEnd, 0);
}

/**
 * 位置により整列した配列で二分探索を行う．
 * @param values 探索する値の配列．
 * @param offset 対象文字列の先頭を0とするUTF-16位置．
 * @param position 各要素から比較用のUTF-16位置を取り出す関数．
 * @returns 指定位置以上の最初の要素の添字．該当要素がなければ配列長．
 */
function lowerBound<T>(values: readonly T[], offset: number, position: (value: T) => number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (position(values[middle]) < offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}
