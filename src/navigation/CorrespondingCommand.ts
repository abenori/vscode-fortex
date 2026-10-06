import * as vscode from 'vscode';
import {
  EnvironmentToken,
  findEnvironmentPairAtOffset
} from '../completion/environment/EnvironmentParser';
import {
  ReferenceNavigationToken,
  findReferenceNavigationTokenAtOffset,
  findReferenceNavigationTokens
} from './ReferenceNavigationParser';

interface NavigationQuickPickItem extends vscode.QuickPickItem {
  token: ReferenceNavigationToken;
}

/** Moves from an environment, label, or reference command to its counterpart. */
export async function goToCorresponding(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'latex') {
    vscode.window.setStatusBarMessage('Open a LaTeX editor before using Go to Corresponding.', 5000);
    return;
  }

  const document = editor.document;
  const source = document.getText();
  const offset = document.offsetAt(editor.selection.active);
  const environmentPair = findEnvironmentPairAtOffset(source, offset);
  if (environmentPair) {
    const target = isWithin(environmentPair.begin, offset) ? environmentPair.end : environmentPair.begin;
    moveCursor(editor, target.style === 'named' ? target.nameStart : target.start);
    return;
  }

  const current = findReferenceNavigationTokenAtOffset(source, offset);
  if (!current) {
    vscode.window.setStatusBarMessage(
      'Place the cursor on \\begin, \\end, \\label, or a reference command.',
      5000
    );
    return;
  }

  const targetKind = current.kind === 'label' ? 'reference' : 'label';
  const targets = findReferenceNavigationTokens(source).filter(
    (token) => token.kind === targetKind && token.key === current.key
  );
  if (targets.length === 0) {
    const targetName = targetKind === 'label' ? '\\label' : 'reference';
    vscode.window.setStatusBarMessage(`No matching ${targetName} was found for "${current.key}".`, 5000);
    return;
  }

  let target = targets[0];
  if (targets.length > 1) {
    const selected = await vscode.window.showQuickPick(
      targets.map((token) => createQuickPickItem(document, token)),
      {
        placeHolder: `Select the corresponding ${targetKind} for "${current.key}"`,
        matchOnDescription: true,
        matchOnDetail: true
      }
    );
    if (!selected) {
      return;
    }
    target = selected.token;
  }
  moveCursor(editor, target.keyStart);
}

function createQuickPickItem(
  document: vscode.TextDocument,
  token: ReferenceNavigationToken
): NavigationQuickPickItem {
  const position = document.positionAt(token.keyStart);
  const command = document.getText(new vscode.Range(
    document.positionAt(token.commandStart),
    document.positionAt(token.commandEnd)
  ));
  return {
    label: command,
    description: `Line ${position.line + 1}`,
    detail: document.lineAt(position.line).text.trim(),
    token
  };
}

function moveCursor(editor: vscode.TextEditor, offset: number): void {
  const position = editor.document.positionAt(offset);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function isWithin(token: EnvironmentToken, offset: number): boolean {
  return token.start <= offset && offset <= token.end;
}
