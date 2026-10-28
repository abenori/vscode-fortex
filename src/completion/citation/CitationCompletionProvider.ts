import * as vscode from 'vscode';
import { CitationContext } from './Citation';
import CitationService from './CitationService';
import { searchCitations } from './CitationSearch';
import CompletionSession from '../CompletionSession';
import { CitationEntry } from './Citation';

/** Supplies BibTeX keys while the cursor is inside a cite-like command. */
export default class CitationCompletionProvider implements vscode.Disposable {
  private readonly session = new CompletionSession<CitationEntry[]>();
  public constructor(private readonly service: CitationService) {}

  public invalidate(): void {
    this.session.invalidate();
  }

  public dispose(): void {
    this.session.dispose();
  }

  public async complete(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: CitationContext,
    token: vscode.CancellationToken
  ): Promise<vscode.CompletionList | undefined> {
    if (token.isCancellationRequested) {
      return undefined;
    }

    const entries = await this.session.get(document, {
      start: context.queryStart, end: document.offsetAt(position), scope: 'project'
    }, token, requestToken => this.service.entriesFor(document, requestToken,
      uris => this.session.watch(uris, requestToken),
      uris => this.session.watchDirectories(uris, requestToken)));
    if (!entries || token.isCancellationRequested) {
      return undefined;
    }
    // Rank all entries before capping the UI list.
    const matches = searchCitations(entries, context.query).slice(0, 200);
    const range = new vscode.Range(document.positionAt(context.queryStart), position);
    const items = matches.map((entry, index) => {
      const item = new vscode.CompletionItem({
        label: entry.key,
        description: [entry.author, entry.year].filter(Boolean).join(' · ')
      }, vscode.CompletionItemKind.Reference);
      item.insertText = entry.key;
      item.range = range;
      item.filterText = context.query || `${entry.author} ${entry.title}`;
      item.sortText = `${index.toString().padStart(4, '0')}:${entry.key}`;
      item.detail = entry.title || '(No title)';
      item.documentation = new vscode.MarkdownString([
        entry.title ? `**${escapeMarkdown(entry.title)}**` : '',
        entry.author ? escapeMarkdown(entry.author) : '',
        `BibTeX key: \`${escapeMarkdown(entry.key)}\``
      ].filter(Boolean).join('\n\n'));
      return item;
    });

    // isIncomplete makes VS Code ask the provider again as the query changes.
    return new vscode.CompletionList(items, true);
  }
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+\-.!]/g, '\\$&');
}
