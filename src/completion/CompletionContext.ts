import { CitationContext } from './citation/Citation';
import { findCitationContext } from './citation/CitationSearch';
import { CommandContext, findCommandContext } from './command/CommandParser';
import { EnvironmentCompletionContext, findEnvironmentCompletionContext } from './environment/EnvironmentParser';
import { findReferenceContext, ReferenceContext } from './reference/LabelParser';
import * as LaTeXParser from '../latex-parser';

export type CompletionContext =
  | ({
    /** この項目がreferenceであることを表す識別値． */
    kind: 'reference'
  } & ReferenceContext)
  | ({
    /** この項目がcitationであることを表す識別値． */
    kind: 'citation'
  } & CitationContext)
  | ({
    /** この項目がenvironmentであることを表す識別値． */
    kind: 'environment'
  } & EnvironmentCompletionContext)
  | ({
    /** この項目がcommandであることを表す識別値． */
    kind: 'command'
  } & CommandContext);

/**
 * 現在行の構文を分類し，文書全体を基準とする置換位置を返す．
 * @param line 補完対象の行の本文．改行文字は含めない．
 * @param character 行頭からの0始まりのUTF-16位置．
 * @param lineOffset 行頭の，文書全体における0始まりのUTF-16位置．省略時は0．
 * @returns 補完の種別，検索文字列，および文書全体を基準にした置換位置．補完対象外ではundefined．
 */
export function findCompletionContext(line: string, character: number, lineOffset = 0): CompletionContext | undefined {
  const prefix = line.slice(0, character);
  const syntax = new LaTeXParser.LaTeXSource(prefix);
  const scanner = syntax.sourceScanner;
  if (scanner.ignoredRanges.some(range => range.end === prefix.length
    && (range.kind === 'comment' || !range.closed))) {
    return undefined;
  }

  // 引数内でコマンドを入力している場合は，外側の引数よりコマンドの補完を優先する．
  const command = findCommandContext(syntax, lineOffset);
  if (command) {
    return { kind: 'command', ...command };
  }
  const reference = findReferenceContext(syntax);
  if (reference) {
    return { kind: 'reference', ...reference, queryStart: lineOffset + reference.queryStart };
  }
  const citation = findCitationContext(syntax);
  if (citation) {
    return { kind: 'citation', ...citation, queryStart: lineOffset + citation.queryStart };
  }
  // カーソルより後ろの文字列は，既存の閉じ波括弧や数式の閉じ区切りを置換に含める場合だけ必要となる．
  const environment = findEnvironmentCompletionContext(character === line.length ? syntax : line, character);
  if (environment) {
    return {
      kind: 'environment',
      ...environment,
      queryStart: lineOffset + environment.queryStart,
      replaceEnd: lineOffset + environment.replaceEnd
    };
  }
  return undefined;
}
