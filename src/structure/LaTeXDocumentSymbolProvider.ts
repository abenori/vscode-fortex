import * as vscode from 'vscode';
import StructureService from './StructureService';
import { StructureNode } from './StructureTypes';

interface ConvertedSymbols {
  version: number;
  nodes: StructureNode[];
  symbols: vscode.DocumentSymbol[];
}

/** Saved changes can alter symbols without a document-version change. */
export function registerDocumentSymbols(service: StructureService): vscode.Disposable {
  const provider = new LaTeXDocumentSymbolProvider(service);
  const register = () => vscode.languages.registerDocumentSymbolProvider(
    { language: 'latex' }, provider, { label: 'Fortex' }
  );
  let registration = register();
  const refresh = () => { registration.dispose(); registration = register(); };
  const subscriptions = service.onDidChangeDocumentSymbols(refresh);
  return vscode.Disposable.from(subscriptions, new vscode.Disposable(() => registration.dispose()), provider);
}

/** Keeps the standard Outline local to the current editor; the project tree is separate. */
export default class LaTeXDocumentSymbolProvider implements vscode.DocumentSymbolProvider, vscode.Disposable {
  private readonly service: StructureService;
  private readonly ownsService: boolean;
  private converted = new WeakMap<vscode.TextDocument, ConvertedSymbols>();

  constructor(service?: StructureService) {
    this.service = service ?? new StructureService(false);
    this.ownsService = service === undefined;
  }

  dispose(): void {
    this.converted = new WeakMap();
    if (this.ownsService) { this.service.dispose(); }
  }

  async provideDocumentSymbols(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<vscode.DocumentSymbol[]> {
    if (token?.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    const version = document.version;
    const nodes = await this.service.getDocumentHeadings(document);
    if (token?.isCancellationRequested || document.isClosed || version !== document.version) { throw new vscode.CancellationError(); }
    const cached = this.converted.get(document);
    if (cached?.version === version && cached.nodes === nodes) {
      return cached.symbols;
    }

    const toSymbols = (items: StructureNode[]): vscode.DocumentSymbol[] => items.flatMap(node => {
      const children = toSymbols(node.children);
      if (node.kind !== 'section') {
        return children;
      }
      const selectionStart = document.positionAt(node.declarationRange.start);
      const selectionEnd = document.positionAt(node.declarationRange.end);
      const extent = node.extentEnd.uri.toString() === document.uri.toString() ? node.extentEnd.end : node.declarationRange.end;
      const symbol = new vscode.DocumentSymbol(
        node.title || `\\${node.constructName}`,
        `\\${node.constructName}`,
        vscode.SymbolKind.Namespace,
        new vscode.Range(selectionStart, document.positionAt(Math.max(node.declarationRange.end, extent))),
        new vscode.Range(selectionStart, selectionEnd)
      );
      symbol.children = children;
      return [symbol];
    });
    const symbols = toSymbols(nodes);
    this.converted.set(document, { version, nodes, symbols });
    return symbols;
  }
}
