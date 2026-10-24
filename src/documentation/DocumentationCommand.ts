import * as path from 'path';
import * as vscode from 'vscode';
import { assertWorkspaceTrusted } from '../WorkspaceTrust';
import { findDocumentationQuery } from './DocumentationContext';
import TexdocService, { TexdocEntry } from './TexdocService';

interface DocumentationItem extends vscode.QuickPickItem {
  entry: TexdocEntry;
}

/** Searches installed TeX documentation and opens only the explicitly chosen result. */
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

  // Preserve texdoc's relevance order, including when there is only one result.
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
