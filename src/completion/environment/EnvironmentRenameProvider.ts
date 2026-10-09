import * as vscode from 'vscode';
import {
  DISPLAY_MATH_ENVIRONMENT,
  EnvironmentPair,
  EnvironmentToken,
  findEnvironmentPairAtOffset,
  findEnvironmentTokenAtOffset
} from './EnvironmentParser';

/** Implements F2 rename for structurally matched LaTeX environments. */
export default class EnvironmentRenameProvider implements vscode.RenameProvider {
  public prepareRename(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Range | { range: vscode.Range; placeholder: string } | null {
    const source = document.getText();
    const offset = document.offsetAt(position);
    const token = findEnvironmentTokenAtOffset(source, offset);
    if (!token) {
      return null;
    }
    if (!findEnvironmentPairAtOffset(source, offset)) {
      throw new Error(`A matching ${token.kind === 'begin' ? '\\end' : '\\begin'} was not found.`);
    }
    return {
      range: tokenRange(document, token, token.style === 'display'),
      placeholder: token.style === 'display' ? '[' : token.name
    };
  }

  public provideRenameEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string
  ): vscode.WorkspaceEdit {
    const source = document.getText();
    const pair = findEnvironmentPairAtOffset(source, document.offsetAt(position));
    if (!pair) {
      throw new Error('A matching LaTeX environment pair was not found.');
    }

    const targetName = normalizeNewName(newName);
    const edit = new vscode.WorkspaceEdit();
    replaceToken(edit, document, pair.begin, pair, targetName);
    replaceToken(edit, document, pair.end, pair, targetName);
    return edit;
  }
}

export function normalizeNewName(value: string): string {
  // A bare opening bracket or either display delimiter converts to `\[...\]`.
  const name = value.trim();
  if (name === '[' || name === '\\[' || name === '\\]') {
    return DISPLAY_MATH_ENVIRONMENT;
  }
  if (!name || /[\s{}\\]/.test(name)) {
    throw new Error('Enter an environment name without whitespace, braces, or backslashes. Use [ for display math.');
  }
  return name;
}

function replaceToken(
  edit: vscode.WorkspaceEdit,
  document: vscode.TextDocument,
  token: EnvironmentToken,
  pair: EnvironmentPair,
  targetName: string
): void {
  // Converting between named and display forms replaces the whole command. A
  // named-to-named rename edits only the name inside the braces.
  if (targetName === DISPLAY_MATH_ENVIRONMENT) {
    edit.replace(document.uri, tokenRange(document, token, true), token === pair.begin ? '\\[' : '\\]');
  } else if (token.style === 'display') {
    const replacement = token === pair.begin ? `\\begin{${targetName}}` : `\\end{${targetName}}`;
    edit.replace(document.uri, tokenRange(document, token, true), replacement);
  } else {
    edit.replace(document.uri, tokenRange(document, token, false), targetName);
  }
}

function tokenRange(document: vscode.TextDocument, token: EnvironmentToken, full: boolean): vscode.Range {
  const start = full ? token.start : token.nameStart;
  const end = full ? token.end : token.nameEnd;
  return new vscode.Range(document.positionAt(start), document.positionAt(end));
}
