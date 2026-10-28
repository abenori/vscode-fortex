import * as vscode from 'vscode';
import { COMMAND_CATALOG, CommandCatalogEntry } from './CommandCatalog';
import { CommandContext } from './CommandParser';
import Config from '../../Config';
import CompletionSession from '../CompletionSession';
import { completionSources } from '../CompletionSources';
import { collectRawCommands, RawCommand } from '../RawCompletionCollector';

/** Combines the fixed catalog with definitions collected for one input context. */
export default class CommandCompletionProvider implements vscode.Disposable {
  private readonly session = new CompletionSession<RawCommand[]>();

  public async complete(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: CommandContext,
    token: vscode.CancellationToken
  ): Promise<vscode.CompletionList | undefined> {
    if (token.isCancellationRequested) { return undefined; }
    const commands = await this.session.get(document, {
      start: context.start + 1, end: document.offsetAt(position), scope: Config.completionScope('command', document.uri)
    }, token, async requestToken => {
      const sources = await completionSources(document, 'command', requestToken, (uris, directories) => {
        this.session.watch(uris, requestToken); this.session.watchDirectories(directories ?? [], requestToken);
      });
      const unique = new Map<string, RawCommand>();
      for (const { source } of sources) {
        for (const command of collectRawCommands(source)) { unique.set(command.name, command); }
      }
      return [...unique.values()];
    });
    if (!commands || token.isCancellationRequested) { return undefined; }
    const range = new vscode.Range(document.positionAt(context.start), position);
    const items = new Map<string, vscode.CompletionItem>();
    for (const command of COMMAND_CATALOG) {
      if (fuzzyMatch(command.name, context.query)) { items.set(command.name, catalogItem(command, range)); }
    }
    for (const command of commands) {
      if (fuzzyMatch(command.name, context.query)) { items.set(command.name, customCommandItem(command, range)); }
    }
    return new vscode.CompletionList([...items.values()], true);
  }

  public invalidate(): void { this.session.invalidate(); }
  public dispose(): void { this.session.dispose(); }
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

function customCommandItem(command: RawCommand, range: vscode.Range): vscode.CompletionItem {
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
function customCommandSnippet(command: RawCommand): vscode.SnippetString {
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
