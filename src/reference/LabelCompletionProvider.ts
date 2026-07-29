import * as vscode from 'vscode';
import { findLabels, findReferenceContext, LabelEntry } from './LabelParser';

/** Completes reference keys from labels in the active LaTeX document. */
export default class LabelCompletionProvider implements vscode.CompletionItemProvider {
  public provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionList | undefined {
    const source = document.getText();
    const context = findReferenceContext(source, document.offsetAt(position));
    if (!context) {
      return undefined;
    }

    const range = new vscode.Range(document.positionAt(context.queryStart), position);
    const labels = findLabels(source).sort((left, right) => left.key.localeCompare(right.key));
    const items = labels.map((label) => this.makeItem(label, range));
    return new vscode.CompletionList(items, false);
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
