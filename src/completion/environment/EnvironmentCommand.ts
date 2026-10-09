import * as vscode from 'vscode';
import { environmentContentIndentation, environmentSnippet } from './EnvironmentCompletionProvider';
import EnvironmentRenameProvider, { normalizeNewName } from './EnvironmentRenameProvider';
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
  const selection = editor.selection;
  const version = editor.document.version;
  const offset = editor.document.offsetAt(selection.active);
  // A non-empty selection always means "wrap". Rename applies only to an empty
  // cursor positioned on an existing environment command.
  const token = selection.isEmpty ? findEnvironmentTokenAtOffset(source, offset) : undefined;
  if (token && !findEnvironmentPairAtOffset(source, offset)) {
    void vscode.window.showWarningMessage(`A matching ${token.kind === 'begin' ? '\\end' : '\\begin'} was not found.`);
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
  const picked = token
    ? await pickReplacementEnvironment(items, token.name)
    : await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a LaTeX environment to insert',
      matchOnDescription: true
    });
  if (!picked) {
    return;
  }
  if (editor.document.isClosed || editor.document.version !== version) {
    void vscode.window.showWarningMessage('The document changed while selecting an environment. Please try again.');
    return;
  }
  if (token) {
    const edit = new EnvironmentRenameProvider().provideRenameEdits(editor.document, selection.active, picked.name);
    await vscode.workspace.applyEdit(edit);
    return;
  }

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

/** Keep suggestions visible while retaining F2's ability to enter a new name. */
function pickReplacementEnvironment(
  items: EnvironmentQuickPickItem[],
  currentName: string
): Promise<EnvironmentQuickPickItem | undefined> {
  const quickPick = vscode.window.createQuickPick<EnvironmentQuickPickItem>();
  quickPick.title = 'Rename LaTeX Environment';
  quickPick.placeholder = `Select or enter an environment (currently ${currentName}). Use [ for display math.`;
  quickPick.matchOnDescription = true;
  quickPick.items = items;
  quickPick.activeItems = items.filter((item) => item.name === currentName);

  return new Promise((resolve) => {
    let picked: EnvironmentQuickPickItem | undefined;
    const disposables = [
      quickPick.onDidChangeValue((value) => {
        let name: string;
        try {
          name = normalizeNewName(value);
        } catch {
          quickPick.items = items;
          return;
        }
        if (name === DISPLAY_MATH_ENVIRONMENT) {
          // The old closing-delimiter alias also needs to match the display item.
          quickPick.items = items.filter((item) => item.name === name).map((item) => ({ ...item, alwaysShow: true }));
        } else {
          quickPick.items = items.some((item) => item.name === name)
            ? items
            : [...items, { label: `Use "${name}"`, description: 'New environment name', name, alwaysShow: true }];
          // Prefer completing an existing name over accepting its typed prefix
          // as a new name. The custom item remains available for explicit choice.
          const suggestion = items.find((item) => item.name === name)
            ?? items.find((item) => item.name.toLowerCase().startsWith(name.toLowerCase()));
          if (suggestion) {
            quickPick.activeItems = [suggestion];
          }
        }
      }),
      quickPick.onDidAccept(() => {
        picked = quickPick.selectedItems[0] ?? quickPick.activeItems[0];
        if (picked) {
          quickPick.hide();
        }
      }),
      quickPick.onDidHide(() => {
        resolve(picked);
        for (const disposable of disposables) {
          disposable.dispose();
        }
        quickPick.dispose();
      })
    ];
    quickPick.show();
  });
}
