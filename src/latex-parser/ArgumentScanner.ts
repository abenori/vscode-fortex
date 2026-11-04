import SourceScanner from './SourceScanner';
import type { SourceRange } from './SourceScanner';

export type ArgumentOpening = '{' | '[';

/** すべての位置は元のソースを基準とする．endとcontentEndの位置は範囲に含めない． */
export interface ScannedArgument extends SourceRange {
  /** 引数の開き区切り．{は必須引数，[は省略可能引数． */
  readonly opening: ArgumentOpening;
  /** 区切り記号を除く本文の開始位置．元ソースのUTF-16単位． */
  readonly contentStart: number;
  /** 区切り記号を除く本文の終端．このUTF-16位置は含まない． */
  readonly contentEnd: number;
  /** 必要な引数と閉じ区切りがそろっている場合はtrue． */
  readonly complete: boolean;
}

/** 星印がない場合は，空白とコメントの直後の位置に空の範囲を持つ． */
export interface ScannedStar extends SourceRange {
  /** 宣言に星印が付いている場合はtrue． */
  readonly starred: boolean;
}

/**
 * 不変のソースを一度走査して引数の区切りを索引化する．省略可能引数内の閉じ角括弧は波括弧で保護される．
 * 角括弧の入れ子は同じ波括弧の深さで対応付け，未対応の角括弧があっても波括弧の引数は閉じられる．コマンドとリテラル内部の文字は区切りとして扱わない．
 */
export default class ArgumentScanner {
  /** 同じソースに対する共有字句解析器． */
  private readonly scanner: SourceScanner;
  /** 有効な開き区切りのUTF-16位置の集合． */
  private readonly openings = new Set<number>();
  /** 開き区切りの位置から対応する閉じ区切りの位置への表． */
  private readonly closings = new Map<number, number>();

  /**
   * ArgumentScannerの初期状態と所有するリソースを準備する．
   * @param source 解析対象の本文，または同じ本文をすでに走査した字句解析器．
   * @returns 新しいインスタンス．コンストラクタから明示的な値は返さない．
   */
  public constructor(source: string | SourceScanner) {
    this.scanner = typeof source === 'string' ? new SourceScanner(source) : source;
    const braces: number[] = [];
    const brackets: number[][] = [[]];
    const { maskedSource, commands } = this.scanner;
    let commandIndex = 0;
    for (let offset = 0; offset < maskedSource.length; offset++) {
      while (commandIndex < commands.length && commands[commandIndex].start < offset) {
        commandIndex++;
      }
      const command = commands[commandIndex];
      if (command?.start === offset) {
        offset = command.end - 1;
        commandIndex++;
        continue;
      }
      const character = maskedSource[offset];
      if (character === '{') {
        this.openings.add(offset);
        braces.push(offset);
        brackets.push([]);
      } else if (character === '}' && braces.length > 0) {
        this.closings.set(braces.pop()!, offset);
        brackets.pop();
      } else if (character === '[') {
        this.openings.add(offset);
        brackets[brackets.length - 1].push(offset);
      } else if (character === ']') {
        const opening = brackets[brackets.length - 1].pop();
        if (opening !== undefined) {
          this.closings.set(opening, offset);
        }
      }
    }
  }

  /**
   * 空白とコメントの後にある波括弧の引数，または角括弧の省略可能引数を読む．開き区切りの欠落や不正な位置ではundefinedを返す．
   * 閉じていない引数はEOFまでの範囲とcomplete:falseを持つ．他の引数は独立して読めるため，編集中の不完全な入力から復帰できる．
   *
   * @param offset 対象文字列の先頭を0とするUTF-16位置．
   * @param opening 読み取る引数の開き区切り．{は必須引数，[は省略可能引数．省略時は'{'．
   * @returns 区切りを含む範囲，本文の範囲，および閉じているかの情報．開き区切りがなければundefined．
   */
  public readArgument(offset: number, opening: ArgumentOpening = '{'): ScannedArgument | undefined {
    const start = this.scanner.skipTrivia(offset);
    if (start === undefined) {
      return undefined;
    }
    if (this.scanner.source[start] !== opening || !this.openings.has(start)) {
      return undefined;
    }
    const closing = this.closings.get(start);
    return {
      opening,
      start,
      end: closing === undefined ? this.scanner.source.length : closing + 1,
      contentStart: start + 1,
      contentEnd: closing ?? this.scanner.source.length,
      complete: closing !== undefined
    };
  }

  /**
   * 空白とコメントの後の星印を読み，その後の空白は読み進めない．
   * @param offset 対象文字列の先頭を0とするUTF-16位置．
   * @returns 星の有無と範囲．星がなければ空の範囲，不正な位置ならundefined．
   */
  public readStar(offset: number): ScannedStar | undefined {
    const start = this.scanner.skipTrivia(offset);
    if (start === undefined) {
      return undefined;
    }
    const starred = this.scanner.maskedSource[start] === '*' && !this.insideCommand(start);
    return { starred, start, end: starred ? start + 1 : start };
  }

  /**
   * 指定位置がコマンドトークンの内部かを調べる．
   * @param offset 対象文字列の先頭を0とするUTF-16位置．
   * @returns 位置がコマンドの半開区間内にある場合はtrue．
   */
  private insideCommand(offset: number): boolean {
    const { commands } = this.scanner;
    let low = 0;
    let high = commands.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (commands[middle].end <= offset) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const command = commands[low];
    return command !== undefined && command.start <= offset;
  }
}
