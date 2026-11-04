import ArgumentScanner from './ArgumentScanner';
import SourceScanner from './SourceScanner';
import type { SourceRange } from './SourceScanner';

export const DISPLAY_MATH_ENVIRONMENT = '\\[';

/** 名前付き環境と，対応する4種類の数式区切りの記法． */
export type EnvironmentTokenStyle = 'named' | 'display' | 'inline' | 'dollar' | 'doubleDollar';

/** 元ソースのUTF-16位置．endとnameEndの位置は範囲に含めない． */
export interface EnvironmentToken {
  /** この項目の種別を表す識別値． */
  readonly kind: 'begin' | 'end';
  /** begin/end，角括弧・丸括弧，ドル記号など環境区切りの記法． */
  readonly style: EnvironmentTokenStyle;
  /** 対象の名前． */
  readonly name: string;
  /** 元ソースにおける範囲の開始位置．0始まりのUTF-16単位で，この位置を含む． */
  readonly start: number;
  /** 元ソースにおける範囲の終端．0始まりのUTF-16単位で，この位置を含まない． */
  readonly end: number;
  /** 名前部分の開始位置．元ソースのUTF-16単位． */
  readonly nameStart: number;
  /** 名前部分の終端．このUTF-16位置は含まない． */
  readonly nameEnd: number;
}

export interface EnvironmentPair {
  /** 対応する環境の開始宣言． */
  readonly begin: EnvironmentToken;
  /** 対応する環境の終了宣言． */
  readonly end: EnvironmentToken;
}

/**
 * マクロ展開を行わず，直接記述された環境宣言の対応を取る．コメント・エスケープされた区切り・リテラルは字句解析で除外する．不一致の終了宣言が現れても，途中の開始宣言を捨てない．
 * スタックの一番上と対応する場合だけ組にし，不正な入力で対応関係が交差しないようにする．
 */
export default class EnvironmentParser {
  /** 解析対象の元のソース本文． */
  public readonly source: string;
  /** 元ソースに現れた順の解析済みトークン． */
  public readonly tokens: readonly EnvironmentToken[];
  /** 対応が見つかった環境の開始・終了宣言の組． */
  public readonly pairs: readonly EnvironmentPair[];
  /** 対応する終了宣言がない環境の開始宣言． */
  public readonly unclosed: readonly EnvironmentToken[];

  /**
   * EnvironmentParserの初期状態と所有するリソースを準備する．
   * @param source 解析対象の本文，または同じ本文をすでに走査した字句解析器．
   * @param excludedRanges 環境の対応付けから除外するソース範囲．省略時は[]．
   * @param styles 認識を有効にする環境・数式区切りの記法．省略可能．
   * @param sharedArgumentsScanner すでに作成した引数解析器．省略時は新しく作成する．
   * @returns 新しいインスタンス．コンストラクタから明示的な値は返さない．
   */
  public constructor(
    source: string | SourceScanner,
    excludedRanges: readonly SourceRange[] = [],
    styles?: readonly EnvironmentTokenStyle[],
    sharedArgumentsScanner?: ArgumentScanner
  ) {
    const scanner = typeof source === 'string' ? new SourceScanner(source) : source;
    this.source = scanner.source;
    const excluded = mergeRanges(excludedRanges, this.source.length);
    let excludedIndex = 0;
    const overlapsExcluded = (start: number, end: number): boolean => {
      for (let index = excludedIndex; index < excluded.length && excluded[index].start < end; index++) {
        if (excluded[index].end > start) {
          return true;
        }
      }
      return false;
    };
    const argumentsScanner = sharedArgumentsScanner ?? new ArgumentScanner(scanner);
    const tokens: EnvironmentToken[] = [];
    const stack: EnvironmentToken[] = [];
    const pairs: EnvironmentPair[] = [];
    const enabledStyles = styles ? new Set(styles) : undefined;
    let commandIndex = 0;
    const append = (token: EnvironmentToken): void => {
      if (enabledStyles && !enabledStyles.has(token.style)) {
        return;
      }
      tokens.push(token);
      if (token.kind === 'begin') {
        stack.push(token);
        return;
      }
      const begin = stack.at(-1);
      if (begin?.name === token.name && begin.style === token.style) {
        stack.pop();
        pairs.push({ begin, end: token });
      }
    };

    for (let cursor = 0; cursor < scanner.maskedSource.length;) {
      while (excludedIndex < excluded.length && excluded[excludedIndex].end <= cursor) {
        excludedIndex++;
      }
      if (excluded[excludedIndex]?.start <= cursor) {
        cursor = excluded[excludedIndex].end;
        continue;
      }
      while (commandIndex < scanner.commands.length && scanner.commands[commandIndex].start < cursor) {
        commandIndex++;
      }
      const command = scanner.commands[commandIndex];
      if (command?.start === cursor) {
        commandIndex++;
        cursor = command.end;
        if (overlapsExcluded(command.start, command.end)) {
          continue;
        }
        if (command.name === 'begin' || command.name === 'end') {
          const argument = argumentsScanner.readArgument(command.end);
          if (!argument?.complete) {
            continue;
          }
          cursor = argument.end;
          if (overlapsExcluded(command.start, argument.end)) {
            continue;
          }
          const name = scanner.textWithoutComments(argument.contentStart, argument.contentEnd)?.trim() ?? '';
          if (!name || /[\\{}\s]/.test(name)) {
            continue;
          }
          const maskedName = scanner.maskedSource.slice(argument.contentStart, argument.contentEnd);
          append({
            kind: command.name === 'begin' ? 'begin' : 'end', style: 'named', name,
            start: command.start, end: argument.end,
            nameStart: argument.contentStart + maskedName.length - maskedName.trimStart().length,
            nameEnd: argument.contentStart + maskedName.trimEnd().length
          });
        } else if (command.name === '[' || command.name === ']' || command.name === '(' || command.name === ')') {
          const display = command.name === '[' || command.name === ']';
          append({
            kind: command.name === '[' || command.name === '(' ? 'begin' : 'end',
            style: display ? 'display' : 'inline', name: display ? DISPLAY_MATH_ENVIRONMENT : '\\(',
            start: command.start, end: command.end, nameStart: command.start, nameEnd: command.end
          });
        }
        continue;
      }
      if (scanner.maskedSource[cursor] === '$') {
        // インライン数式は最初のドル記号で閉じる．直後に別の数式が始まる$x$$y$のような記述でも，ディスプレイ数式の区切りとはみなさない．
        const double = stack.at(-1)?.style !== 'dollar' && scanner.maskedSource[cursor + 1] === '$'
          && !overlapsExcluded(cursor, cursor + 2);
        const style = double ? 'doubleDollar' : 'dollar';
        const name = double ? '$$' : '$';
        const end = cursor + name.length;
        append({
          kind: stack.at(-1)?.style === style ? 'end' : 'begin', style, name,
          start: cursor, end, nameStart: cursor, nameEnd: end
        });
        cursor = end;
      } else {
        cursor++;
      }
    }
    this.tokens = tokens;
    this.pairs = pairs;
    this.unclosed = stack;
  }

  /**
   * エディタのカーソル操作に合わせ，トークン直後の位置も対象にする．
   * @param offset 対象文字列の先頭を0とするUTF-16位置．
   * @returns カーソルを含む環境トークン．見つからなければundefined．
   */
  public tokenAt(offset: number): EnvironmentToken | undefined {
    if (!this.validOffset(offset)) {
      return undefined;
    }
    // 区切りが隣接する位置では，その位置から始まるトークンを選ぶ．それ以外では既存トークンの直後のカーソル位置も認める．
    return this.tokens.find(token => token.start === offset)
      ?? this.tokens.find(token => token.start <= offset && offset <= token.end);
  }

  /**
   * カーソルが開始・終了区切りのいずれかにある場合だけ，対応する組を返す．
   * @param offset 対象文字列の先頭を0とするUTF-16位置．
   * @returns カーソルが開始・終了宣言上にある環境の対．該当しなければundefined．
   */
  public pairAt(offset: number): EnvironmentPair | undefined {
    const token = this.tokenAt(offset);
    return token ? this.pairs.find(pair => pair.begin === token || pair.end === token) : undefined;
  }

  /**
   * カーソルより前に開始宣言が完了し，ソース全体でも閉じていない最も内側の環境．
   * @param offset 対象文字列の先頭を0とするUTF-16位置．
   * @returns カーソルより前に開始し，全体でも閉じていない最も内側の環境．なければundefined．
   */
  public unclosedAt(offset: number): EnvironmentToken | undefined {
    return this.validOffset(offset) ? this.unclosed.filter(token => token.end <= offset).at(-1) : undefined;
  }

  /**
   * 位置が解析済みソースの有効範囲内かを判定する．
   * @param offset 対象文字列の先頭を0とするUTF-16位置．
   * @returns 0からソース末尾までの整数であればtrue．
   */
  private validOffset(offset: number): boolean {
    return Number.isInteger(offset) && offset >= 0 && offset <= this.source.length;
  }

}

/**
 * 不正な除外範囲は無視し，重なる範囲を一度だけ走査する．
 * @param ranges 開始位置と終端位置で表した半開範囲の一覧．
 * @param length 対象のUTF-16単位の長さ．
 * @returns 重複走査を避けるための，互いに重ならない半開範囲の配列．
 */
function mergeRanges(ranges: readonly SourceRange[], length: number): SourceRange[] {
  const sorted = ranges.filter(range => Number.isInteger(range.start) && Number.isInteger(range.end)
    && range.start >= 0 && range.end <= length && range.start < range.end)
    .map(range => ({ start: range.start, end: range.end })).sort((left, right) => left.start - right.start);
  const merged: {
    /** 元ソースにおける範囲の開始位置．0始まりのUTF-16単位で，この位置を含む． */
    start: number;
    /** 元ソースにおける範囲の終端．0始まりのUTF-16単位で，この位置を含まない． */
    end: number
  }[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push(range);
    }
  }
  return merged;
}
