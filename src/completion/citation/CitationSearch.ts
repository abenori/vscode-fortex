import { CitationContext, CitationEntry } from './Citation';
import * as LaTeXParser from '../../latex-parser';

/**
 * 著者と題名で共通の検索文字列を使い，文献に順位を付ける．
 * @param entries 順序を保つ一覧．各要素は引用キー，種別，著者，題名，出版年，および元の文献ファイルのURI．
 * @param query 現在入力されている検索文字列．
 * @returns 著者・題名の検索語に一致する文献を，一致度のよい順に並べた配列．
 */
export function searchCitations(entries: readonly CitationEntry[], query: string): CitationEntry[] {
  const normalizedQuery = normalizeForSearch(query);
  const tokens = normalizedQuery.split(' ').filter(Boolean);

  return entries
    .map((entry) => ({ entry, score: scoreEntry(entry, normalizedQuery, tokens) }))
    .filter((candidate) => candidate.score < Number.POSITIVE_INFINITY)
    .sort((left, right) => left.score - right.score || compareEntries(left.entry, right.entry))
    .map((candidate) => candidate.entry);
}

/**
 * 著者・題名の検索語に対する一致度を数値化する．
 * @param entry 引用キー，種別，著者，題名，出版年，および元の文献ファイルのURI．
 * @param query 現在入力されている検索文字列．
 * @param tokens 一致判定または解析に使用するトークンの一覧．
 * @returns 小さいほど優先する一致度．一致しない文献には正の無限大を返す．
 */
function scoreEntry(entry: CitationEntry, query: string, tokens: readonly string[]): number {
  if (tokens.length === 0) {
    return 0;
  }

  const author = normalizeForSearch(entry.author);
  const title = normalizeForSearch(entry.title);
  const combined = `${author} ${title}`.trim();
  if (author === query || title === query) {
    return 0;
  }
  if (author.startsWith(query) || title.startsWith(query)) {
    return 5;
  }

  // 評価値は小さいほど優先する．単語の完全一致，前方一致，著者・題名の途中での一致の順に高く評価する．
  let score = 10;
  const words = combined.split(' ');
  for (const token of tokens) {
    if (!combined.includes(token)) {
      return Number.POSITIVE_INFINITY;
    }
    if (words.some((word) => word === token)) {
      score += 0;
    } else if (words.some((word) => word.startsWith(token))) {
      score += 1;
    } else {
      score += 3;
    }
  }
  return score;
}

/**
 * 著者，題名，引用キーの順に文献の表示順を比較する．
 * @param left 引用キー，種別，著者，題名，出版年，および元の文献ファイルのURI．
 * @param right 引用キー，種別，著者，題名，出版年，および元の文献ファイルのURI．
 * @returns 左を先にする場合は負，同順なら0，右を先にする場合は正の数．
 */
function compareEntries(left: CitationEntry, right: CitationEntry): number {
  return left.author.localeCompare(right.author) || left.title.localeCompare(right.title) || left.key.localeCompare(right.key);
}

/**
 * 検索対象の表記揺れと空白を正規化する．
 * @param value 変換または検証する値．
 * @returns 大文字小文字やLaTeX表記の差を吸収した検索用文字列．
 */
export function normalizeForSearch(value: string): string {
  // NFKD正規化と結合文字の除去により，非ラテン文字を保持しつつ，アクセント付きの名前をアクセントの有無にかかわらず検索できるようにする．
  return latexToPlainText(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * 文献のLaTeX装飾やアクセント表記を表示・検索用の文字列へ変換する．
 * @param value 変換または検証する値．
 * @returns 装飾用コマンドと括弧を整理した平文．
 */
export function latexToPlainText(value: string): string {
  // 表示と検索用の正規化だけを行い，TeX全体は解析しない．一般のコマンドを除去する前にアクセントを復号する必要があるため，処理順序を保つ．
  return value
    .replace(/\\(?:LaTeX|TeX)\b/g, (command) => command.slice(1))
    .replace(/\\["'`^~=.]\s*\{?([A-Za-z])\}?/g, '$1')
    .replace(/\\[uvHckbdtr](?:\s*\{([A-Za-z])\}|\s+([A-Za-z]))/g, (_match, braced, spaced) => braced ?? spaced)
    .replace(/\\([%&_#$])/g, '$1')
    .replace(/\\[A-Za-z@]+\*?\s*/g, '')
    .replace(/[{}]/g, '')
    .replace(/~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 引用コマンドで現在入力しているキーの部分を探す．
 * @param input 解析する文字列または共有するLaTeX構文解析結果．
 * @param offset 対象文字列の先頭を0とするUTF-16位置．省略可能．
 * @returns 入力中の引用キーとその開始位置．引用引数内でなければundefined．
 */
export function findCitationContext(input: string | LaTeXParser.LaTeXSource, offset?: number): CitationContext | undefined {
  const text = typeof input === 'string' ? input : input.source;
  offset ??= text.length;
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) {
    return undefined;
  }
  // 通常の呼び出し元は現在行だけを渡す．長いソースが渡された場合も，後方を調べる範囲を制限する．
  const baseOffset = Math.max(0, offset - 20000);
  const prefix = text.slice(baseOffset, offset);
  const syntax = input instanceof LaTeXParser.LaTeXSource && baseOffset === 0 && offset === text.length
    ? input : new LaTeXParser.LaTeXSource(prefix);
  const scanner = syntax.sourceScanner;
  if (scanner.ignoredRanges.some(range => range.end === prefix.length
    && (range.kind === 'comment' || !range.closed))) {
    return undefined;
  }
  const argumentsScanner = syntax.argumentScanner;
  const citeCommand = /^(?:cite|citep|citet|citealp|citealt|citeauthor|citeyear|citeyearpar|autocite|parencite|textcite|footcite|footcitetext|smartcite|supercite|fullcite|volcite|pvolcite|fvolcite|notecite|nocite)$/i;
  for (let index = scanner.commands.length - 1; index >= 0; index--) {
    const command = scanner.commands[index];
    if (!citeCommand.test(command.name)) { continue; }
    let cursor = argumentsScanner.readStar(command.end)?.end ?? command.end;
    let optional = argumentsScanner.readArgument(cursor, '[');
    while (optional?.complete) {
      cursor = optional.end;
      optional = argumentsScanner.readArgument(cursor, '[');
    }
    if (optional) { continue; }
    const argument = argumentsScanner.readArgument(cursor);
    if (!argument || argument.complete) { continue; }
    let fragmentStart = argument.contentStart;
    let commandIndex = index + 1;
    for (let position = argument.contentStart; position < prefix.length; position++) {
      while (commandIndex < scanner.commands.length && scanner.commands[commandIndex].start < position) {
        commandIndex++;
      }
      const nested = scanner.commands[commandIndex];
      if (nested?.start === position) {
        position = nested.end - 1;
        commandIndex++;
        continue;
      }
      const character = scanner.maskedSource[position];
      if (character === '{' || character === '}') { return undefined; }
      if (character === ',') { fragmentStart = position + 1; }
    }
    const queryStart = scanner.skipTrivia(fragmentStart)!;
    return {
      query: scanner.textWithoutComments(queryStart, prefix.length) ?? '',
      queryStart: baseOffset + queryStart
    };
  }
  return undefined;
}
