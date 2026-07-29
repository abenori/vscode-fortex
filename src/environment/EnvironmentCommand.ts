import * as vscode from 'vscode';
import { environmentContentIndentation, environmentSnippet } from './EnvironmentCompletionProvider';
import {
  collectEnvironmentNames,
  DISPLAY_MATH_ENVIRONMENT,
  findEnvironmentPairAtOffset,
  findEnvironmentTokenAtOffset
} from './EnvironmentParser';

interface EnvironmentQuickPickItem extends vscode.QuickPickItem {
  name: string;
}

/** Context-sensitive `Ctrl+T B`: rename, insert, or wrap an environment. */
export async function insertOrRenameEnvironment(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'latex') {
    void vscode.window.showWarningMessage('Open a LaTeX editor before inserting an environment.');
    return;
  }

  const source = editor.document.getText();
  const offset = editor.document.offsetAt(editor.selection.active);
  // A non-empty selection always means "wrap". Rename applies only to an empty
  // cursor positioned on an existing environment command.
  const token = editor.selection.isEmpty ? findEnvironmentTokenAtOffset(source, offset) : undefined;
  if (token) {
    if (!findEnvironmentPairAtOffset(source, offset)) {
      void vscode.window.showWarningMessage(`A matching ${token.kind === 'begin' ? '\\end' : '\\begin'} was not found.`);
      return;
    }
    await vscode.commands.executeCommand('editor.action.rename');
    return;
  }

  const items: EnvironmentQuickPickItem[] = [
    {
      label: '\\[ … \\]',
      description: 'Display math',
      name: DISPLAY_MATH_ENVIRONMENT
    },
    ...collectEnvironmentNames(source).map((name) => ({ label: name, name }))
  ];
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a LaTeX environment to insert',
    matchOnDescription: true
  });
  if (!picked) {
    return;
  }

  const selection = editor.selection;
  const position = selection.active;
  const eol = editor.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const opening = picked.name === DISPLAY_MATH_ENVIRONMENT ? '\\[' : `\\begin{${picked.name}}`;
  const closing = picked.name === DISPLAY_MATH_ENVIRONMENT ? '\\]' : `\\end{${picked.name}}`;

  if (selection.isEmpty) {
    await editor.insertSnippet(environmentSnippet(editor.document, position, picked.name, true), selection);
    return;
  }

  // TM_SELECTED_TEXT preserves multiline selections through one snippet edit.
  const snippet = new vscode.SnippetString();
  snippet.appendText(`${opening}${eol}${environmentContentIndentation(editor.document.uri)}`);
  snippet.appendVariable('TM_SELECTED_TEXT', '');
  snippet.appendText(`${eol}${closing}`);
  await editor.insertSnippet(snippet, selection);
}
