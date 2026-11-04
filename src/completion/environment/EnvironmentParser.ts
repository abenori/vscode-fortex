import * as LaTeXParser from '../../latex-parser';

/** 補完と環境編集では，名前付き環境とディスプレイ数式の形式を扱う． */
export type EnvironmentTokenStyle = 'named' | 'display';

/** カーソル位置で環境を補完する際の置換範囲． */
export interface EnvironmentCompletionContext {
  /** namedは名前付き環境，displayは角括弧のディスプレイ数式の補完． */
  style: EnvironmentTokenStyle;
  /** 入力中の検索文字列． */
  query: string;
  /** 検索文字列の先頭のUTF-16位置． */
  queryStart: number;
  /** 補完で置換する範囲の終端．このUTF-16位置は含まない． */
  replaceEnd: number;
}

export const STANDARD_ENVIRONMENTS = [
  'abstract',
  'align',
  'align*',
  'array',
  'cases',
  'center',
  'description',
  'displaymath',
  'document',
  'enumerate',
  'equation',
  'equation*',
  'figure',
  'figure*',
  'flushleft',
  'flushright',
  'gather',
  'gather*',
  'itemize',
  'list',
  'math',
  'minipage',
  'multline',
  'multline*',
  'picture',
  'quote',
  'quotation',
  'split',
  'table',
  'table*',
  'tabular',
  'tabular*',
  'thebibliography',
  'theorem',
  'titlepage',
  'verbatim',
  'verse'
] as const;

/**
 * 入力途中の引数を認識する，補完専用の解析．
 * @param input 解析する文字列または共有するLaTeX構文解析結果．
 * @param offset 対象文字列の先頭を0とするUTF-16位置．
 * @returns 環境の記法，入力中の名前，および置換範囲．環境補完の対象外ならundefined．
 */
export function findEnvironmentCompletionContext(input: string | LaTeXParser.LaTeXSource, offset: number): EnvironmentCompletionContext | undefined {
  const source = typeof input === 'string' ? input : input.source;
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length) {
    return undefined;
  }
  const syntax = typeof input === 'string' ? new LaTeXParser.LaTeXSource(source) : input;
  const scanner = syntax.sourceScanner;
  const argumentsScanner = syntax.argumentScanner;
  for (const command of [...scanner.commands].reverse()) {
    if (command.name !== 'begin' || command.end > offset) {
      continue;
    }
    const argument = argumentsScanner.readArgument(command.end);
    if (!argument || offset < argument.contentStart || offset > argument.contentEnd) {
      continue;
    }
    const query = source.slice(argument.contentStart, offset);
    if (/[{}\r\n]/.test(query) || scanner.maskedSource.slice(argument.contentStart, offset) !== query) {
      continue;
    }
    // 自動挿入された閉じ波括弧は，同じ行かつ現在の入れ子の深さにある場合だけ置換に含める．
    const suffix = source.slice(offset, argument.contentEnd);
    return {
      style: 'named', query, queryStart: argument.contentStart,
      replaceEnd: argument.complete && !/[{}\r\n]/.test(suffix) ? argument.end : offset
    };
  }

  const display = scanner.commands.find(command => command.name === '[' && command.end === offset);
  if (display) {
    return {
      style: 'display', query: LaTeXParser.DISPLAY_MATH_ENVIRONMENT, queryStart: display.start,
      replaceEnd: source.startsWith('\\]', offset) ? offset + 2 : offset
    };
  }
  return undefined;
}

/**
 * ソース中の環境使用・定義から補完に使用する名前を集める．
 * @param source 読み取りと範囲の基準となる共有LaTeXソース．
 * @returns 重複を除いた環境名の配列．
 */
export function collectEnvironmentNames(source: string | LaTeXParser.LaTeXSource): string[] {
  const names = new Set<string>(STANDARD_ENVIRONMENTS);
  const syntax = typeof source === 'string' ? new LaTeXParser.LaTeXSource(source) : source;
  for (const token of syntax.createEnvironmentParser().tokens) {
    if (token.style === 'named') {
      names.add(token.name);
    }
  }
  for (const definition of syntax.definitionParser.definitions) {
    if (definition.kind === 'environment' || definition.kind === 'theorem') {
      names.add(definition.name);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}
