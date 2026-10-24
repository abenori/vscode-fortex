import * as vscode from 'vscode';
import { localDocumentStructure } from './StructureService';
import { StructureNode } from './StructureTypes';

/** Keeps the standard Outline local to the current editor; the project tree is separate. */
export default class LaTeXDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  async provideDocumentSymbols(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<vscode.DocumentSymbol[]> {
    if (token?.isCancellationRequested) {
      return [];
    }
    const nodes = await localDocumentStructure(document);
    if (token?.isCancellationRequested) {
      return [];
    }

    const toSymbols = (items: StructureNode[]): vscode.DocumentSymbol[] => items.flatMap(node => {
      const children = toSymbols(node.children);
      if (node.kind !== 'section') {
        return children;
      }
      const selectionStart = document.positionAt(node.location.start);
      const selectionEnd = document.positionAt(node.location.end);
      const extent = node.end.uri.toString() === document.uri.toString() ? node.end.end : node.location.end;
      const symbol = new vscode.DocumentSymbol(
        node.title || `\\${node.command}`,
        `\\${node.command}`,
        vscode.SymbolKind.Namespace,
        new vscode.Range(selectionStart, document.positionAt(Math.max(node.location.end, extent))),
        new vscode.Range(selectionStart, selectionEnd)
      );
      symbol.children = children;
      return [symbol];
    });
    return toSymbols(nodes);
  }
}
