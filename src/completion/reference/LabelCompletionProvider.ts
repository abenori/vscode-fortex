import * as vscode from 'vscode';
import { findLabels, LabelEntry, ReferenceContext } from './LabelParser';
import * as LaTeXParser from '../../latex-parser';

interface LabelArgumentRange {
  start: number;
  end: number;
}

interface LabelCacheEntry {
  source: string;
  labels: LabelEntry[];
  labelArguments: LabelArgumentRange[];
}

const maximumCompletionItems = 200;
const reindexDelayMilliseconds = 300;

/**
 * Completes reference keys from a cached index of the active LaTeX document.
 * Indexing is moved away from the completion request so large documents can show
 * their first suggestions without rescanning every label on each keystroke.
 */
export default class LabelCompletionProvider implements vscode.Disposable {
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

  public complete(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: ReferenceContext,
    token: vscode.CancellationToken
  ): vscode.CompletionList | undefined {
    if (token.isCancellationRequested) {
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
    const scanner = new LaTeXParser.SourceScanner(source);
    const argumentsScanner = new LaTeXParser.ArgumentScanner(scanner);
    const labels = findLabels(new LaTeXParser.ReferenceParser(scanner))
      .sort((left, right) => left.key.localeCompare(right.key));
    // Keep empty and unfinished label arguments too: typing into their middle
    // can create a label far from the line containing the command itself.
    const labelArguments: LabelArgumentRange[] = [];
    for (const command of scanner.commands) {
      if (command.name === 'label') {
        const argument = argumentsScanner.readArgument(command.end);
        if (argument) {
          labelArguments.push({ start: argument.start, end: argument.end });
        }
      }
    }
    const entry = { source, labels, labelArguments };
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
    updateArgumentRanges(cached.labelArguments, event.contentChanges);
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
    if (/[\r\n\\%{}\[\]]/.test(change.text) || /[\r\n\\%{}\[\]]/.test(removed)) {
      return true;
    }
    const changeEnd = change.rangeOffset + change.rangeLength;
    if (cached.labelArguments.some(range => range.start <= changeEnd && change.rangeOffset <= range.end)) {
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
    const oldLineStart = Math.max(
      oldSource.lastIndexOf('\n', change.rangeOffset - 1),
      oldSource.lastIndexOf('\r', change.rangeOffset - 1)
    ) + 1;
    const oldLineEnd = oldSource.slice(change.rangeOffset).search(/[\r\n]/);
    const oldLine = oldSource.slice(oldLineStart,
      oldLineEnd === -1 ? oldSource.length : change.rangeOffset + oldLineEnd);
    // Renaming a control word, literal delimiter or environment name may expose
    // labels many lines away. Examine only the changed line, rather than parsing
    // the whole document for each ordinary prose edit.
    return /[\\%{}]/.test(oldLine) || /[\\%{}]/.test(document.lineAt(currentLine).text);
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

/** Keeps indexed ranges aligned while a debounced rebuild is pending. */
function updateArgumentRanges(ranges: LabelArgumentRange[], changes: readonly vscode.TextDocumentContentChangeEvent[]): void {
  for (const change of [...changes].sort((left, right) => right.rangeOffset - left.rangeOffset)) {
    const start = change.rangeOffset;
    const end = start + change.rangeLength;
    const delta = change.text.length - change.rangeLength;
    for (const range of ranges) {
      if (range.start > end) {
        range.start += delta;
      } else if (range.start >= start) {
        range.start = start;
      }
      if (range.end >= end) {
        range.end += delta;
      } else if (range.end > start) {
        range.end = start + change.text.length;
      }
    }
  }
}
