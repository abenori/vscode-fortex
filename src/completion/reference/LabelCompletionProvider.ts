import * as vscode from 'vscode';
import { ReferenceContext } from './LabelParser';
import Config from '../../Config';
import * as Workspace from '../../workspace';
import CompletionSession from '../CompletionSession';
import { completionSources } from '../CompletionSources';
import { collectRawLabels } from '../RawCompletionCollector';

interface LabelCandidate { key: string; uri: vscode.Uri }
class LabelCompletionItem extends vscode.CompletionItem {
  constructor(readonly candidate: LabelCandidate) { super(candidate.key, vscode.CompletionItemKind.Reference); }
}

const maximumCompletionItems = 200;

/** Reads keys on a new input context, retaining them only for that query. */
export default class LabelCompletionProvider implements vscode.Disposable {
  private readonly session = new CompletionSession<LabelCandidate[]>();

  public async complete(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: ReferenceContext,
    token: vscode.CancellationToken
  ): Promise<vscode.CompletionList | undefined> {
    if (token.isCancellationRequested) { return undefined; }
    const labels = await this.session.get(document, {
      start: context.queryStart, end: document.offsetAt(position), scope: Config.completionScope('label', document.uri)
    }, token, async requestToken => {
      const sources = await completionSources(document, 'label', requestToken, (uris, directories) => {
        this.session.watch(uris, requestToken); this.session.watchDirectories(directories ?? [], requestToken);
      });
      const unique = new Map<string, LabelCandidate>();
      for (const { uri, source } of sources) {
        for (const { key } of collectRawLabels(source)) {
          if (!unique.has(key)) { unique.set(key, { key, uri }); }
        }
      }
      return [...unique.values()].sort((left, right) => left.key.localeCompare(right.key));
    });
    if (!labels || token.isCancellationRequested) { return undefined; }
    const matching = labels.filter(label => fuzzyMatch(label.key, context.query));
    const range = new vscode.Range(document.positionAt(context.queryStart), position);
    const items = matching.slice(0, maximumCompletionItems).map(label => {
      const item = new LabelCompletionItem(label);
      item.insertText = label.key;
      item.filterText = label.key;
      item.range = range;
      return item;
    });
    return new vscode.CompletionList(items, true);
  }

  /** Source descriptions are constructed only for the selected suggestion. */
  public async resolveCompletionItem(item: vscode.CompletionItem, token: vscode.CancellationToken): Promise<vscode.CompletionItem> {
    if (!(item instanceof LabelCompletionItem) || token.isCancellationRequested) { return item; }
    let source: string;
    try { source = await Workspace.readDocumentText(item.candidate.uri); }
    catch { return item; }
    if (token.isCancellationRequested) { return item; }
    const occurrence = collectRawLabels(source).find(label => label.key === item.candidate.key);
    if (!occurrence) { return item; }
    const line = source.slice(0, occurrence.offset).split(/\r\n|\r|\n/).length - 1;
    const lines = source.split(/\r\n|\r|\n/);
    const context = lines.slice(Math.max(0, line - 2), Math.min(lines.length, line + 3))
      .map(value => value.length > 300 ? `${value.slice(0, 297)}...` : value).join('\n');
    const documentation = new vscode.MarkdownString();
    documentation.appendCodeblock(context, 'latex');
    item.documentation = documentation;
    item.detail = `${item.candidate.uri.fsPath || item.candidate.uri.toString()}:${line + 1}`;
    return item;
  }

  public invalidate(): void { this.session.invalidate(); }
  public dispose(): void { this.session.dispose(); }
}

function fuzzyMatch(value: string, query: string): boolean {
  let index = 0;
  const normalized = query.toLocaleLowerCase();
  if (!normalized) { return true; }
  for (const character of value.toLocaleLowerCase()) {
    if (character === normalized[index] && ++index === normalized.length) { return true; }
  }
  return false;
}
