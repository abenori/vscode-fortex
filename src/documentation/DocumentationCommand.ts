import * as path from 'path';
import * as vscode from 'vscode';
import { assertWorkspaceTrusted } from '../WorkspaceTrust';
import { findDocumentationQuery } from './DocumentationContext';
import TexdocService, { TexdocEntry } from './TexdocService';

interface DocumentationItem extends vscode.QuickPickItem {
  /** 表示項目に対応する元の解析データ． */
  entry: TexdocEntry;
}

/**
 * インストール済みのTeX文書を検索し，利用者が明示的に選んだ結果を開く．
 * @param service 関連情報の取得や更新を担当するサービス．
 * @returns 処理の完了を表すPromise．値は返さない．
 */
export async function openDocumentation(service: Pick<TexdocService, 'list' | 'open'>): Promise<void> {
  assertWorkspaceTrusted('TeX documentation');
  const query = await vscode.window.showInputBox({
    title: 'Open Documentation',
    prompt: 'Enter a package, class, or documentation name',
    placeHolder: 'For example: amsmath',
    value: initialQuery(vscode.window.activeTextEditor),
    validateInput: value => !value.trim()
      ? 'Enter a documentation name.'
      : /[\r\n\0]/.test(value) ? 'Enter a single documentation name on one line.' : undefined
  });
  if (query === undefined) {
    return;
  }

  const name = query.trim();
  const entries = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Finding documentation for ${name}`,
    cancellable: true
  }, async (_progress, token) => {
    const results = await service.list(name, token);
    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    return results;
  });
  if (entries.length === 0) {
    void vscode.window.showInformationMessage(`No local documentation found for "${name}".`);
    return;
  }

  // 結果が1件でも，texdocが返した関連度の順序を保つ．
  const selected = await vscode.window.showQuickPick<DocumentationItem>(entries.map(entry => ({
    label: entry.description || path.basename(entry.filePath),
    description: [entry.language, entry.description ? path.basename(entry.filePath) : undefined].filter(Boolean).join(' · '),
    detail: entry.filePath,
    entry
  })), {
    title: `Documentation: ${name}`,
    placeHolder: 'Select a document to open',
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (selected) {
    await service.open(selected.entry.filePath);
  }
}

/**
 * 選択範囲またはカーソル位置からドキュメント検索の初期文字列を求める．
 * @param editor 編集または移動の対象となるエディタ．
 * @returns 検索対象のパッケージ・クラス名．取得できなければ空文字列．
 */
function initialQuery(editor: vscode.TextEditor | undefined): string {
  if (!editor) {
    return '';
  }
  if (!editor.selection.isEmpty) {
    const selected = editor.document.getText(editor.selection).trim();
    return /[\r\n\0]/.test(selected) ? '' : selected;
  }
  if (editor.document.languageId !== 'latex') {
    return '';
  }
  return findDocumentationQuery(editor.document.getText(), editor.document.offsetAt(editor.selection.active)) ?? '';
}
