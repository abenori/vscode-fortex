import * as LaTeXParser from '../../latex-parser';

export interface CommandContext {
  /** 入力中の検索文字列． */
  query: string;
  /** コマンド名の直前のバックスラッシュの，文書全体でのUTF-16位置． */
  start: number;
}

/**
 * カーソル直前の入力途中のコマンド名を探す．
 * @param input 解析する文字列または共有するLaTeX構文解析結果．
 * @param lineOffset 行頭の，文書全体における0始まりのUTF-16位置．省略時は0．
 * @returns 入力中のコマンド名と文書内の開始位置．対象がなければundefined．
 */
export function findCommandContext(input: string | LaTeXParser.LaTeXSource, lineOffset = 0): CommandContext | undefined {
  // 現在行だけを走査する．入力途中の名前を調べるために文書全体を解析しない．
  const syntax = typeof input === 'string' ? new LaTeXParser.LaTeXSource(input) : input;
  const linePrefix = syntax.source;
  const scanner = syntax.sourceScanner;
  const command = scanner.commands.at(-1);
  if (!command || scanner.maskedSource[command.start] !== '\\') {
    return undefined;
  }
  const query = linePrefix.slice(command.start + 1);
  return /^[A-Za-z@]*\*?$/.test(query)
    ? { query, start: lineOffset + command.start }
    : undefined;
}
