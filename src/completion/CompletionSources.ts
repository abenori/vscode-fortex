import * as vscode from 'vscode';
import Config from '../Config';
import LaTeXProject from '../project/LaTeXProject';
import * as Workspace from '../workspace';

export type CompletionKind = 'label' | 'command' | 'environment';
export interface CompletionSource {
  /** 対象ファイルのURI． */
  uri: vscode.Uri;
  /** 解析対象の元のソース本文． */
  source: string
}

/**
 * 要求ごとに現在のバッファを読み取り，プロジェクトやソースの状態を要求間で保持しない．
 * @param document 要求の対象となる編集中の文書．
 * @param kind 処理対象の種別．
 * @param token 要求のキャンセルを確認するトークン．
 * @param watch 読み取った依存ファイルの監視を登録するコールバック．省略時は() => undefined．
 * @returns 設定された補完範囲に含まれるソースのURIと読み取った本文．Promiseで返す．
 */
export async function completionSources(
  document: vscode.TextDocument,
  kind: CompletionKind,
  token: vscode.CancellationToken,
  watch: (uris: readonly vscode.Uri[], directories?: readonly vscode.Uri[]) => void = () => undefined
): Promise<CompletionSource[]> {
  if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
  if (Config.completionScope(kind, document.uri) === 'document') {
    return [{ uri: document.uri, source: document.getText() }];
  }
  // 要求ごとにソースの本文を固定する．検索文字列だけの変更では，入力のたびにプロジェクトを再探索したりバッファ全体をコピーしたりしない．
  const sourcesByUri = new Map<string, Promise<string>>();
  const currentSource = document.getText();
  sourcesByUri.set(Workspace.uriKey(document.uri), Promise.resolve(currentSource));
  const readSource = (uri: vscode.Uri): Promise<string> => {
    if (token.isCancellationRequested) { return Promise.reject(new vscode.CancellationError()); }
    const key = Workspace.uriKey(uri);
    let source = sourcesByUri.get(key);
    if (!source) { source = Workspace.readDocumentText(uri); sourcesByUri.set(key, source); }
    return source;
  };
  let project: LaTeXProject;
  try {
    project = await LaTeXProject.create(document.uri, {
      readSource,
      onDependency: uri => watch([uri]),
      onDirectory: directory => watch([], [directory])
    });
  } catch (error) {
    if (token.isCancellationRequested || error instanceof vscode.CancellationError) { throw new vscode.CancellationError(); }
    // 未保存のバッファや不完全なプロジェクトでも，現在文書内の候補は利用できる．
    return [{ uri: document.uri, source: currentSource }];
  }
  if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
  const files = new Map<string, vscode.Uri>();
  files.set(Workspace.uriKey(project.mainfile), project.mainfile);
  for (const file of project.filelist) {
    if (file.exists) { files.set(Workspace.uriKey(file.uri), file.uri); }
  }
  // 指定されたメインファイルから参照されていなくても，現在のバッファの候補は利用する．
  files.set(Workspace.uriKey(document.uri), document.uri);
  watch([project.mainfile, ...project.filelist.map(file => file.uri), document.uri]);
  const sources: CompletionSource[] = [];
  for (const uri of files.values()) {
    if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
    try {
      const source = await readSource(uri);
      if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
      sources.push({ uri, source });
    } catch (error) {
      if (error instanceof vscode.CancellationError) { throw error; }
      // 読み込み先が欠落していても，読めるソースからの候補収集は続ける．
      if ((error as {
        /** FileNotFoundなど，失敗の種類を識別するエラーコード． */
        code?: string
      }).code !== 'FileNotFound') { throw error; }
    }
  }
  return sources;
}
