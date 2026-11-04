import * as vscode from 'vscode';
import * as UriIdentity from './UriIdentity';

/**
 * 文書を開いたり変更したりせず，現在開いているエディタのバッファを探す．
 * @param uri 対象ファイルのURI．
 * @returns 同じURIで開かれている文書．見つからなければundefined．
 */
export function findOpenDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  const key = UriIdentity.uriKey(uri);
  return vscode.workspace.textDocuments.find(document => !document.isClosed && UriIdentity.uriKey(document.uri) === key);
}

/**
 * 未保存のエディタ本文を優先し，なければファイルプロバイダからUTF-8本文を読む．
 * @param uri 対象ファイルのURI．
 * @returns 未保存の編集内容を優先したソース全文．未開封なら保存済みのUTF-8本文．Promiseで返す．
 */
export async function readDocumentText(uri: vscode.Uri): Promise<string> {
  const document = findOpenDocument(uri);
  return document?.getText() ?? await readFileText(uri);
}

/**
 * エディタのバッファを参照せず，ファイルプロバイダから保存済みのUTF-8本文を読む．
 * @param uri 対象ファイルのURI．
 * @returns ファイルプロバイダから読み取った保存済みのUTF-8本文．Promiseで返す．
 */
export async function readFileText(uri: vscode.Uri): Promise<string> {
  return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
}
