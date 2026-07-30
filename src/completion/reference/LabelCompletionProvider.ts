import * as vscode from 'vscode';
import { findLabels, findReferenceContext, LabelEntry, ReferenceContext } from './LabelParser';

interface LabelCacheEntry {
  source: string;
  labels: LabelEntry[];
}

const maximumCompletionItems = 200;
const reindexDelayMilliseconds = 300;

/**
 * Completes reference keys from a cached index of the active LaTeX document.
 * Indexing is moved away from the completion request so large documents can show
 * their first suggestions without rescanning every label on each keystroke.
 */
export default class LabelCompletionProvider implements vscode.CompletionItemProvider, vscode.Disposable {
  private readonly cache = new Map<string, LabelCacheEntry>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly disposables: vscode.Disposable[];

  public constructor() {
    // The extension activates when a LaTeX document is already open. Pre-index all
    // such documents so the first explicit completion request is cache-backed.
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

  public provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): vscode.CompletionList | undefined {
    const context = referenceContextAt(document, position);
    if (!context || token.isCancellationRequested) {
      return undefined;
    }

    const labels = this.labelsFor(document);
    const matching = labels.filter((label) => fuzzyMatch(label.key, context.query));
    const range = new vscode.Range(document.positionAt(context.queryStart), position);
    const items = matching.slice(0, maximumCompletionItems).map((label) => this.makeItem(label, range));

    // When capped, ask VS Code to invoke the provider again as the query narrows.
    return new vscode.CompletionList(items, matching.length > maximumCompletionItems);
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

  private labelsFor(document: vscode.TextDocument): LabelEntry[] {
    const cached = this.cache.get(document.uri.toString());
    if (cached) {
      return cached.labels;
    }
    return this.index(document).labels;
  }

  private index(document: vscode.TextDocument): LabelCacheEntry {
    const source = document.getText();
    const labels = findLabels(source).sort((left, right) => left.key.localeCompare(right.key));
    const entry = { source, labels };
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
    const relevant = event.contentChanges.some((change) => this.affectsLabelIndex(event.document, cached, oldSource, change));
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

  private affectsLabelIndex(
    document: vscode.TextDocument,
    cached: LabelCacheEntry,
    oldSource: string,
    change: vscode.TextDocumentContentChangeEvent
  ): boolean {
    const removed = oldSource.slice(change.rangeOffset, change.rangeOffset + change.rangeLength);
    if (/\r|\n|\\label\b/.test(change.text) || /\r|\n|\\label\b/.test(removed)) {
      return true;
    }

    // Rebuild when nearby prose changes because it appears in the suggestion's
    // short description and documentation popup.
    const changedStartLine = change.range.start.line;
    const changedEndLine = change.range.end.line;
    if (cached.labels.some((label) => changedStartLine <= label.line + 2 && changedEndLine >= label.line - 2)) {
      return true;
    }

    const currentLine = Math.min(changedStartLine, Math.max(0, document.lineCount - 1));
    return /\\label\b/.test(document.lineAt(currentLine).text);
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

  private makeItem(label: LabelEntry, range: vscode.Range): vscode.CompletionItem {
    const item = new vscode.CompletionItem({
      label: label.key,
      description: label.summary
    }, vscode.CompletionItemKind.Reference);
    item.insertText = label.key;
    item.filterText = label.key;
    item.range = range;

    const documentation = new vscode.MarkdownString();
    documentation.appendCodeblock(label.context, 'latex');
    item.documentation = documentation;
    return item;
  }
}

/** Reads only the bounded prefix needed by the reference-context parser. */
function referenceContextAt(document: vscode.TextDocument, position: vscode.Position): ReferenceContext | undefined {
  const offset = document.offsetAt(position);
  const requestedStart = Math.max(0, offset - 20000);
  const startPosition = document.positionAt(requestedStart);
  const startOffset = document.offsetAt(startPosition);
  const prefix = document.getText(new vscode.Range(startPosition, position));
  const context = findReferenceContext(prefix, prefix.length);
  return context ? { query: context.query, queryStart: startOffset + context.queryStart } : undefined;
}

/** VS Code-like subsequence matching without constructing every CompletionItem. */
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

/** Applies VS Code's original-document offsets from highest to lowest. */
function applyContentChanges(source: string, changes: readonly vscode.TextDocumentContentChangeEvent[]): string {
  const descending = [...changes].sort((left, right) => right.rangeOffset - left.rangeOffset);
  for (const change of descending) {
    source = source.slice(0, change.rangeOffset) + change.text + source.slice(change.rangeOffset + change.rangeLength);
  }
  return source;
}
