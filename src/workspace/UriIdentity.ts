import * as path from 'path';
import type * as vscode from 'vscode';

/**
 * URIの表記に基づく識別キー．リモートのプロバイダでは独自の大文字小文字の区別を保つ．
 * @param uri 対象ファイルのURI．
 * @returns ローカルファイルの大文字小文字の違いを吸収し，他のプロバイダの区別を保つ識別キー．
 */
export function uriKey(uri: vscode.Uri): string {
  if (uri.scheme !== 'file') {
    return uri.toString();
  }
  const file = path.normalize(uri.fsPath);
  return process.platform === 'win32' ? file.toLowerCase() : file;
}
