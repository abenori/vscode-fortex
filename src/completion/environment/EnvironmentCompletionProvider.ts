import * as vscode from 'vscode';
import Config from '../../Config';
import * as LaTeXParser from '../../latex-parser';
import CompletionSession from '../CompletionSession';
import { completionSources } from '../CompletionSources';
import { collectRawEnvironments } from '../RawCompletionCollector';
import {
  STANDARD_ENVIRONMENTS,
  EnvironmentCompletionContext
} from './EnvironmentParser';

/** Inserts a complete environment pair from a `\begin{...}` or `\[` completion. */
export default class EnvironmentCompletionProvider implements vscode.Disposable {
  private readonly session = new CompletionSession<string[]>();

  public async complete(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: EnvironmentCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.CompletionList | undefined> {
    if (token.isCancellationRequested) {
      return undefined;
    }

    if (context.style === 'display') {
      this.invalidate();
      return new vscode.CompletionList([this.makeDisplayItem(document, position, context)], false);
    }

    const names = await this.session.get(document, {
      start: context.queryStart, end: document.offsetAt(position), scope: Config.completionScope('environment', document.uri)
    }, token, async requestToken => {
      const sources = await completionSources(document, 'environment', requestToken, (uris, directories) => {
        this.session.watch(uris, requestToken); this.session.watchDirectories(directories ?? [], requestToken);
      });
      const unique = new Set<string>(STANDARD_ENVIRONMENTS);
      for (const { source } of sources) {
        for (const name of collectRawEnvironments(source)) { unique.add(name); }
      }
      return [...unique].sort((left, right) => left.localeCompare(right));
    });
    if (!names || token.isCancellationRequested) { return undefined; }
    const items = names.map((name) => this.makeNamedItem(document, position, context, name));
    return new vscode.CompletionList(items, true);
  }

  public invalidate(): void { this.session.invalidate(); }
  public dispose(): void { this.session.dispose(); }

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
    item.filterText = LaTeXParser.DISPLAY_MATH_ENVIRONMENT;
    item.range = this.range(document, context);
    item.insertText = environmentSnippet(document, position, LaTeXParser.DISPLAY_MATH_ENVIRONMENT, true);
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
  const opening = name === LaTeXParser.DISPLAY_MATH_ENVIRONMENT ? '\\[' : `\\begin{${name}}`;
  const closing = name === LaTeXParser.DISPLAY_MATH_ENVIRONMENT ? '\\]' : `\\end{${name}}`;
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
