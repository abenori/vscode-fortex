import * as vscode from 'vscode';
import Config from '../Config';
import {
  collectEnvironmentNames,
  DISPLAY_MATH_ENVIRONMENT,
  EnvironmentCompletionContext,
  findEnvironmentCompletionContext
} from './EnvironmentParser';

/** Inserts a complete environment pair from a `\begin{...}` or `\[` completion. */
export default class EnvironmentCompletionProvider implements vscode.CompletionItemProvider {
  public provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionList | undefined {
    const source = document.getText();
    const context = findEnvironmentCompletionContext(source, document.offsetAt(position));
    if (!context) {
      return undefined;
    }

    if (context.style === 'display') {
      return new vscode.CompletionList([this.makeDisplayItem(document, position, context)], false);
    }

    const items = collectEnvironmentNames(source).map((name) => this.makeNamedItem(document, position, context, name));
    return new vscode.CompletionList(items, false);
  }

  private makeNamedItem(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: EnvironmentCompletionContext,
    name: string
  ): vscode.CompletionItem {
    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Snippet);
    item.filterText = name;
    item.range = this.range(document, context);
    item.insertText = environmentSnippet(document, position, name, false);
    return item;
  }

  private makeDisplayItem(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: EnvironmentCompletionContext
  ): vscode.CompletionItem {
    const item = new vscode.CompletionItem('\\[ … \\]', vscode.CompletionItemKind.Snippet);
    item.filterText = DISPLAY_MATH_ENVIRONMENT;
    item.range = this.range(document, context);
    item.insertText = environmentSnippet(document, position, DISPLAY_MATH_ENVIRONMENT, true);
    return item;
  }

  private range(document: vscode.TextDocument, context: EnvironmentCompletionContext): vscode.Range {
    return new vscode.Range(document.positionAt(context.queryStart), document.positionAt(context.replaceEnd));
  }
}

export function environmentSnippet(
  document: vscode.TextDocument,
  position: vscode.Position,
  name: string,
  includeOpening: boolean
): vscode.SnippetString {
  // `includeOpening` is false for begin completion because `\begin{` is already
  // outside the range replaced by the selected completion item.
  const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const line = document.lineAt(position.line).text;
  const indentation = line.match(/^\s*/)?.[0] ?? '';
  const indentUnit = environmentContentIndentation(document.uri);
  const opening = name === DISPLAY_MATH_ENVIRONMENT ? '\\[' : `\\begin{${name}}`;
  const closing = name === DISPLAY_MATH_ENVIRONMENT ? '\\]' : `\\end{${name}}`;
  const snippet = new vscode.SnippetString();

  if (includeOpening) {
    snippet.appendText(opening);
  } else {
    snippet.appendText(`${name}}`);
  }
  snippet.appendText(`${eol}${indentation}${indentUnit}`);
  snippet.appendTabstop();
  snippet.appendText(`${eol}${indentation}${closing}`);
  return snippet;
}

export function indentationUnit(uri: vscode.Uri): string {
  // Reuse editor settings instead of maintaining another indentation preference.
  const configuration = vscode.workspace.getConfiguration('editor', uri);
  if (!configuration.get<boolean>('insertSpaces', true)) {
    return '\t';
  }
  const configuredSize = configuration.get<number | string>('tabSize', 4);
  const size = typeof configuredSize === 'number' ? configuredSize : Number.parseInt(configuredSize, 10);
  return ' '.repeat(Number.isFinite(size) && size > 0 ? size : 4);
}

export function environmentContentIndentation(uri: vscode.Uri): string {
  // Fortex controls whether a level is added; VS Code controls that level's form.
  return Config.environmentIndentContent() ? indentationUnit(uri) : '';
}
