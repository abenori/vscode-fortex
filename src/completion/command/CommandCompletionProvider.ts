import * as vscode from 'vscode';
import { COMMAND_CATALOG, CommandCatalogEntry } from './CommandCatalog';
import { CommandContext, CustomCommandDefinition, findCustomCommands } from './CommandParser';

interface CommandCacheEntry {
  source: string;
  commands: CustomCommandDefinition[];
}

const reindexDelayMilliseconds = 300;
const declarationPattern = /\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclareDocumentCommand)\b/;

/** Provides cached standard and document-local LaTeX command completions. */
export default class CommandCompletionProvider implements vscode.Disposable {
  private readonly cache = new Map<string, CommandCacheEntry>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly disposables: vscode.Disposable[];

  public constructor() {
    for (const document of vscode.workspace.textDocuments) {
      if (document.languageId === 'latex') {
        this.index(document);
      }
    }
    this.disposables = [
      vscode.workspace.onDidOpenTextDocument((document) => {
        if (document.languageId === 'latex') {
          this.index(document);
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => this.onDocumentChanged(event)),
      vscode.workspace.onDidCloseTextDocument((document) => this.remove(document))
    ];
  }

  public complete(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: CommandContext,
    token: vscode.CancellationToken
  ): vscode.CompletionList | undefined {
    if (token.isCancellationRequested) {
      return undefined;
    }

    const range = new vscode.Range(document.positionAt(context.start), position);
    const items = new Map<string, vscode.CompletionItem>();
    for (const command of COMMAND_CATALOG) {
      if (fuzzyMatch(command.name, context.query)) {
        items.set(command.name, catalogItem(command, range));
      }
    }
    for (const command of this.commandsFor(document)) {
      if (fuzzyMatch(command.name, context.query)) {
        // A local renewcommand intentionally overrides the built-in snippet.
        items.set(command.name, customCommandItem(command, range));
      }
    }
    return new vscode.CompletionList([...items.values()], false);
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.cache.clear();
  }

  private commandsFor(document: vscode.TextDocument): CustomCommandDefinition[] {
    return this.cache.get(document.uri.toString())?.commands ?? this.index(document).commands;
  }

  private index(document: vscode.TextDocument): CommandCacheEntry {
    const source = document.getText();
    const entry = { source, commands: findCustomCommands(source) };
    this.cache.set(document.uri.toString(), entry);
    return entry;
  }

  private onDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
    if (event.document.languageId !== 'latex' || event.contentChanges.length === 0) {
      return;
    }
    const key = event.document.uri.toString();
    const cached = this.cache.get(key);
    if (!cached) {
      this.index(event.document);
      return;
    }

    const oldSource = cached.source;
    const relevant = event.contentChanges.some((change) => {
      const removed = oldSource.slice(change.rangeOffset, change.rangeOffset + change.rangeLength);
      if (/\r|\n/.test(change.text) || /\r|\n/.test(removed) || declarationPattern.test(change.text) || declarationPattern.test(removed)) {
        return true;
      }
      if (cached.commands.some((command) => change.range.start.line <= command.line && change.range.end.line >= command.line)) {
        return true;
      }
      const lineNumber = Math.min(change.range.start.line, Math.max(0, event.document.lineCount - 1));
      return declarationPattern.test(event.document.lineAt(lineNumber).text);
    });
    cached.source = applyContentChanges(oldSource, event.contentChanges);
    if (!relevant) {
      return;
    }

    const previous = this.timers.get(key);
    if (previous) {
      clearTimeout(previous);
    }
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      if (vscode.workspace.textDocuments.includes(event.document)) {
        this.index(event.document);
      }
    }, reindexDelayMilliseconds));
  }

  private remove(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
    this.cache.delete(key);
  }
}

function catalogItem(command: CommandCatalogEntry, range: vscode.Range): vscode.CompletionItem {
  const item = new vscode.CompletionItem(`\\${command.name}`, vscode.CompletionItemKind.Function);
  item.range = range;
  item.filterText = `\\${command.name}`;
  item.insertText = new vscode.SnippetString(command.snippet);
  item.detail = command.detail;
  item.sortText = `1:${command.name}`;
  if (command.retriggerSuggestions) {
    item.command = { command: 'editor.action.triggerSuggest', title: 'Trigger LaTeX argument completion' };
  }
  return item;
}

function customCommandItem(command: CustomCommandDefinition, range: vscode.Range): vscode.CompletionItem {
  const item = new vscode.CompletionItem(`\\${command.name}`, vscode.CompletionItemKind.Function);
  item.range = range;
  item.filterText = `\\${command.name}`;
  item.insertText = customCommandSnippet(command);
  item.detail = command.argumentCount === 0
    ? 'User-defined command'
    : `User-defined command · ${command.argumentCount} argument${command.argumentCount === 1 ? '' : 's'}`;
  item.sortText = `0:${command.name}`;
  return item;
}

/** Builds argument tab stops for classic newcommand declarations. */
function customCommandSnippet(command: CustomCommandDefinition): vscode.SnippetString {
  const snippet = new vscode.SnippetString();
  snippet.appendText(`\\${command.name}`);
  let tabstop = 1;
  let requiredArguments = command.argumentCount;
  if (command.optionalFirstArgument) {
    snippet.appendText('[');
    snippet.appendPlaceholder('option', tabstop++);
    snippet.appendText(']');
    requiredArguments--;
  }
  for (let argument = 0; argument < requiredArguments; argument++) {
    snippet.appendText('{');
    snippet.appendPlaceholder(`arg${argument + 1}`, tabstop++);
    snippet.appendText('}');
  }
  snippet.appendTabstop(0);
  return snippet;
}

function fuzzyMatch(value: string, query: string): boolean {
  if (!query) {
    return true;
  }
  const candidate = value.toLocaleLowerCase();
  const normalizedQuery = query.toLocaleLowerCase();
  let queryIndex = 0;
  for (const char of candidate) {
    if (char === normalizedQuery[queryIndex]) {
      queryIndex++;
      if (queryIndex === normalizedQuery.length) {
        return true;
      }
    }
  }
  return false;
}

function applyContentChanges(source: string, changes: readonly vscode.TextDocumentContentChangeEvent[]): string {
  const descending = [...changes].sort((left, right) => right.rangeOffset - left.rangeOffset);
  for (const change of descending) {
    source = source.slice(0, change.rangeOffset) + change.text + source.slice(change.rangeOffset + change.rangeLength);
  }
  return source;
}
