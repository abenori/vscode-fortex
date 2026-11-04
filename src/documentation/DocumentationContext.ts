import * as LaTeXParser from '../latex-parser';

/**
 * 共有の宣言解析から，カーソル位置の直接記述されたパッケージ名またはクラス名を選ぶ．
 * @param source 解析または読み取りの対象となるソース本文．
 * @param offset 対象文字列の先頭を0とするUTF-16位置．
 * @returns カーソル位置のパッケージ名またはクラス名．対象外ならundefined．
 */
export function findDocumentationQuery(source: string, offset: number): string | undefined {
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length) {
    return undefined;
  }
  const syntax = new LaTeXParser.LaTeXSource(source);
  const scanner = syntax.sourceScanner;
  if (scanner.ignoredRanges.some(range => range.start <= offset
    && (offset < range.end || (range.kind === 'comment' && offset === range.end)))) {
    return undefined;
  }
  const document = syntax.documentParser;
  for (const declaration of document.declarations) {
    const argument = declaration.argument;
    if ((declaration.kind !== 'package' && declaration.kind !== 'documentClass')
      || !argument?.complete || (declaration.options && !declaration.options.complete)
      || offset < declaration.start || offset > argument.contentEnd) {
      continue;
    }
    // ソース位置を変えずに最上位のカンマを探す．マスクされたリテラルやマクロを有効なファイル名と誤認しないよう，元の本文を検証する．
    const names = LaTeXParser.splitclist(scanner, argument.contentStart, argument.contentEnd);
    const literalName = (start: number, end: number): string | undefined => {
      const name = scanner.textWithoutComments(start, end)?.trim() ?? '';
      return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name) ? name : undefined;
    };
    if (offset <= argument.start) {
      return names.length === 1 ? literalName(argument.contentStart, argument.contentEnd) : undefined;
    }
    for (const name of names) {
      // カンマの直前は前の名前，直後は次の名前を対象とする．
      if (name.start <= offset && offset <= name.end) {
        return literalName(name.start, name.end);
      }
    }
  }
  return undefined;
}
