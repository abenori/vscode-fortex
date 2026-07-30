import * as vscode from 'vscode';
import { DISPLAY_MATH_ENVIRONMENT, findUnclosedEnvironmentAtOffset } from './EnvironmentParser';

/** Closes the innermost genuinely unclosed environment before the cursor. */
export async function closeEnvironment(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'latex') {
    void vscode.window.showWarningMessage('Open a LaTeX editor before closing an environment.');
    return;
  }

  const document = editor.document;
  const cursor = editor.selection.active;
  const environment = findUnclosedEnvironmentAtOffset(document.getText(), document.offsetAt(cursor));
  if (!environment) {
    vscode.window.setStatusBarMessage('Fortex: No unclosed environment was found before the cursor.', 3000);
    return;
  }

  const openingLine = document.lineAt(document.positionAt(environment.start).line).text;
  const indentation = openingLine.match(/^\s*/)?.[0] ?? '';
  const closing = environment.name === DISPLAY_MATH_ENVIRONMENT ? '\\]' : `\\end{${environment.name}}`;
  const currentLine = document.lineAt(cursor.line);
  let finalPosition: vscode.Position;

  if (currentLine.text.trim() === '') {
    // Reuse an existing blank line rather than adding another one. Its whitespace
    // is replaced with the indentation of the opening command.
    await editor.edit((edit) => edit.replace(currentLine.range, indentation + closing));
    finalPosition = new vscode.Position(cursor.line, indentation.length + closing.length);
  } else {
    // When invoked on a content line, put the closing command on the following
    // line so the existing text is never split or overwritten.
    const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    await editor.edit((edit) => edit.insert(currentLine.range.end, `${eol}${indentation}${closing}`));
    finalPosition = new vscode.Position(cursor.line + 1, indentation.length + closing.length);
  }

  editor.selection = new vscode.Selection(finalPosition, finalPosition);
  editor.revealRange(new vscode.Range(finalPosition, finalPosition));
}
