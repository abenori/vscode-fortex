import * as vscode from 'vscode';
import { CitationContext } from './Citation';
import CitationService from './CitationService';

/** Supplies BibTeX keys while the cursor is inside a cite-like command. */
export default class CitationCompletionProvider {
  public constructor(private readonly service: CitationService) {}

  public async complete(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: CitationContext,
    token: vscode.CancellationToken
  ): Promise<vscode.CompletionList | undefined> {
    if (token.isCancellationRequested) {
      return undefined;
    }

    const entries = await this.service.entriesFor(document);
    if (token.isCancellationRequested) {
      return undefined;
    }
    // Cap the UI list; the service still searches every entry before ranking.
    const matches = this.service.search(entries, context.query).slice(0, 200);
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
