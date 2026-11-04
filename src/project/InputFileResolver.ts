import * as path from 'path';
import * as vscode from 'vscode';
import LaTeXSource from '../latex-parser/LaTeXSource';
import { readInputFilename } from '../latex-parser/InputFilename';
import type { InputToken, MacroLookup } from '../latex-parser/InputFilename';

export { readInputFilename } from '../latex-parser/InputFilename';
export type { FilenameResult, InputToken } from '../latex-parser/InputFilename';

interface InputResultBase {
  /** 完全に読み取った部分の直後を表すUTF-16位置． */
  readonly consumedEnd: number;
  /** 探索順に記録した候補URIと，その存在確認結果． */
  readonly checkedCandidates: readonly {
    /** 対象ファイルのURI． */
    readonly uri: vscode.Uri;
    /** 存在確認時点で対象がファイルとして存在した場合はtrue． */
    readonly exists: boolean
  }[];
}

export type InputResolution = InputResultBase & (
  | {
    /** この項目がresolvedであることを表す識別値． */
    readonly status: 'resolved';
    /** マクロ展開と引用符の処理を終えた入力ファイル名． */
    readonly filename: string;
    /** 対象ファイルのURI． */
    readonly uri: vscode.Uri
  }
  | {
    /** この項目がmissingであることを表す識別値． */
    readonly status: 'missing';
    /** マクロ展開と引用符の処理を終えた入力ファイル名． */
    readonly filename: string
  }
  | {
    /** この項目がunresolvedであることを表す識別値． */
    readonly status: 'unresolved';
    /** 入力を解決できなかった理由を識別する文字列． */
    readonly reason: string
  }
);

const knownExtensions = new Set(['.tex', '.sty', '.cls', '.fd', '.aux', '.bbl', '.def', '.clo', '.ldf']);

/**
 * 直接記述された1件のinput・includeを，コンパイルディレクトリを基準に解決する．
 * @param source 読み取りと範囲の基準となる共有LaTeXソース．
 * @param command 実行または解析するコマンド．
 * @param compilationDirectory 相対入力パスを解決するコンパイル先ディレクトリのURI．
 * @param macros 現在位置で有効なマクロ定義を名前から引く関数．省略可能．
 * @returns 展開済みファイル名の解決・存在状態と，確認した候補の一覧．解決に成功した場合はURIも含む．Promiseで返す．
 */
export async function resolveInputFile(
  source: LaTeXSource,
  command: InputToken,
  compilationDirectory: vscode.Uri,
  macros?: MacroLookup
): Promise<InputResolution> {
  const read = readInputFilename(source, command, macros);
  const checkedCandidates: {
    /** 対象ファイルのURI． */
    uri: vscode.Uri;
    /** 存在確認時点で対象がファイルとして存在した場合はtrue． */
    exists: boolean
  }[] = [];
  if (read.status === 'unresolved') { return { ...read, checkedCandidates }; }
  const { filename, consumedEnd } = read;
  const names = command.name === 'include'
    ? [filename.replace(/\.tex$/, '') + '.tex']
    : knownExtensions.has(path.posix.extname(filename).toLowerCase())
      ? [filename]
      : [filename + '.tex', filename];
  for (const name of names) {
    const uri = compilationDirectory.scheme === 'file'
      ? vscode.Uri.file(path.resolve(compilationDirectory.fsPath, name))
      : vscode.Uri.joinPath(compilationDirectory, name);
    let exists = false;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      exists = (stat.type & vscode.FileType.File) !== 0;
    } catch (error) {
      if ((error as {
        /** FileNotFoundなど，失敗の種類を識別するエラーコード． */
        code?: string
      }).code !== 'FileNotFound') { throw error; }
    }
    checkedCandidates.push({ uri, exists });
    if (exists) { return { status: 'resolved', filename, uri, consumedEnd, checkedCandidates }; }
  }
  return { status: 'missing', filename, consumedEnd, checkedCandidates };
}
