import * as vscode from 'vscode';
import * as UriIdentity from './UriIdentity';

/** Finds the current editor buffer without opening or changing a document. */
export function findOpenDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  const key = UriIdentity.uriKey(uri);
  return vscode.workspace.textDocuments.find(document => !document.isClosed && UriIdentity.uriKey(document.uri) === key);
}

/** Reads unsaved editor contents first, otherwise UTF-8 text from the provider. */
export async function readDocumentText(uri: vscode.Uri): Promise<string> {
  const document = findOpenDocument(uri);
  return document?.getText() ?? Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
}
