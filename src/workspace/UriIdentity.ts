import * as path from 'path';
import type * as vscode from 'vscode';

/** A lexical identity key; remote providers retain their own case semantics. */
export function uriKey(uri: vscode.Uri): string {
  if (uri.scheme !== 'file') {
    return uri.toString();
  }
  const file = path.normalize(uri.fsPath);
  return process.platform === 'win32' ? file.toLowerCase() : file;
}
