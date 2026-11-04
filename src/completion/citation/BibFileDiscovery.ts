import * as path from 'path';
import * as vscode from 'vscode';
import * as LaTeXParser from '../../latex-parser';

/**
 * 従来のBibTeXまたはbiblatexの宣言から，直接記述された文献ファイル名を抽出する．
 * @param texSource 文献宣言を検索するLaTeXソース全文．
 * @returns LaTeXソース中で宣言された文献ファイル名の配列．
 */
export function discoverBibReferences(texSource: string): string[] {
  const syntax = new LaTeXParser.LaTeXSource(texSource);
  const scanner = syntax.sourceScanner;
  const document = syntax.documentParser;
  const references: string[] = [];
  const seen = new Set<string>();

  const add = (reference: string, appendExtension: boolean) => {
    let normalized = reference.trim();
    // マクロ展開を要するファイル名は静的に解決できないため，誤ったパスをkpsewhichへ渡さず保留する．
    if (!normalized || /[\\#${}]/.test(normalized)) {
      return;
    }
    if (appendExtension && !normalized.toLocaleLowerCase().endsWith('.bib')) {
      normalized += '.bib';
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      references.push(normalized);
    }
  };

  for (const declaration of document.declarations) {
    if (declaration.kind !== 'bibliography' || !declaration.complete || !declaration.argument) {
      continue;
    }
    const argument = declaration.argument;
    const names = declaration.command === 'bibliography'
      ? LaTeXParser.splitclist(scanner, argument.contentStart, argument.contentEnd)
      : [{ start: argument.contentStart, end: argument.contentEnd }];
    for (const name of names) {
      add(scanner.textWithoutComments(name.start, name.end) ?? '', true);
    }
  }

  return references;
}

/**
 * TeXファイルの場所を基準に文献ファイル名をURIへ変換する．
 * @param texUri 文献パスの基準となるTeXファイルのURI．
 * @param reference 宣言に書かれた参照名．
 * @returns 絶対パスまたはTeXファイルからの相対パスを解決した文献URI．
 */
export function resolveBibUri(texUri: vscode.Uri, reference: string): vscode.Uri {
  // 参照がOS固有の絶対パスでなければURIのパス操作を使い，リモートや仮想文書のスキームを保つ．
  const normalized = reference.replace(/\\/g, '/');
  if (texUri.scheme === 'file' && path.isAbsolute(reference)) {
    return vscode.Uri.file(reference);
  }
  if (normalized.startsWith('/')) {
    return texUri.with({ path: normalized });
  }
  return vscode.Uri.joinPath(texUri, '..', normalized);
}
