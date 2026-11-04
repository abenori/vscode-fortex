import * as LaTeXParser from '../../latex-parser';

export interface ReferenceContext {
  /** 入力中の検索文字列． */
  query: string;
  /** 検索文字列の先頭のUTF-16位置． */
  queryStart: number;
}

/**
 * カーソル直前の参照コマンドから入力中のラベル名を求める．
 * @param input 解析する文字列または共有するLaTeX構文解析結果．
 * @param offset 対象文字列の先頭を0とするUTF-16位置．省略可能．
 * @returns 入力中のラベル名と開始位置．参照引数内でなければundefined．
 */
export function findReferenceContext(input: string | LaTeXParser.LaTeXSource, offset?: number): ReferenceContext | undefined {
  const source = typeof input === 'string' ? input : input.source;
  offset ??= source.length;
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length) {
    return undefined;
  }

  // 引用補完と同様に後方を調べる範囲を制限し，キー入力のたびに大きな文書全体を走査しないようにする．
  const start = Math.max(0, offset - 20000);
  const prefix = source.slice(start, offset);
  const syntax = input instanceof LaTeXParser.LaTeXSource && start === 0 && offset === source.length
    ? input : new LaTeXParser.LaTeXSource(prefix);
  const scanner = syntax.sourceScanner;
  if (scanner.ignoredRanges.some(range => range.end === prefix.length
    && (range.kind === 'comment' || !range.closed))) {
    return undefined;
  }
  const argumentsScanner = syntax.argumentScanner;
  for (let index = scanner.commands.length - 1; index >= 0; index--) {
    const command = scanner.commands[index];
    if (!LaTeXParser.ReferenceParser.isReferenceCommand(command.name)) {
      continue;
    }
    const star = argumentsScanner.readStar(command.end);
    const argument = argumentsScanner.readArgument(star?.end ?? command.end);
    if (!argument || argument.complete) {
      continue;
    }
    let fragmentStart = argument.contentStart;
    let nestedCommandIndex = index + 1;
    for (let cursor = argument.contentStart; cursor < prefix.length; cursor++) {
      const nestedCommand = scanner.commands[nestedCommandIndex];
      if (nestedCommand?.start === cursor) {
        cursor = nestedCommand.end - 1;
        nestedCommandIndex++;
        continue;
      }
      const character = scanner.maskedSource[cursor];
      // 入れ子の引数は参照キーの一部として扱わない．その内部では振り分け側がコマンド補完を提供できる．
      if (character === '{' || character === '}') {
        return undefined;
      }
      if (character === ',') {
        fragmentStart = cursor + 1;
      }
    }
    const queryStart = scanner.skipTrivia(fragmentStart)!;
    return {
      query: scanner.textWithoutComments(queryStart, prefix.length) ?? '',
      queryStart: start + queryStart
    };
  }
  return undefined;
}
