import * as vscode from 'vscode';
import StructureService from './StructureService';
import { StructureNode } from './StructureTypes';

/** Re-registration invalidates VS Code's native symbol cache even on a save
 * without a content-version change; DocumentSymbolProvider has no change event. */
export function registerDocumentSymbols(service: StructureService): vscode.Disposable {
  const provider = new LaTeXDocumentSymbolProvider(service);
  const register = () => vscode.languages.registerDocumentSymbolProvider(
    { language: 'latex' }, provider, { label: 'Fortex' }
  );
  let registration = register();
  const refresh = () => { registration.dispose(); registration = register(); };
  const subscriptions = vscode.Disposable.from(service.onDidChange(refresh), service.onDidChangeSources(refresh));
  return vscode.Disposable.from(subscriptions, new vscode.Disposable(() => registration.dispose()), provider);
}

/** Keeps the standard Outline local to the current editor; the project tree is separate. */
export default class LaTeXDocumentSymbolProvider implements vscode.DocumentSymbolProvider, vscode.Disposable {
  private readonly service: StructureService;
  private readonly ownsService: boolean;

  constructor(service?: StructureService) {
    this.service = service ?? new StructureService(false);
    this.ownsService = service === undefined;
  }

  dispose(): void {
    if (this.ownsService) { this.service.dispose(); }
  }

  async provideDocumentSymbols(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<vscode.DocumentSymbol[]> {
    if (token?.isCancellationRequested) {
      return [];
    }
    const nodes = await this.service.local(document);
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
