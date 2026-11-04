import * as vscode from 'vscode';
import StructureService from './StructureService';
import { StructureNode } from './StructureTypes';

interface ConvertedSymbols {
  /** ソースを読み取った時点または投影を計算した時点の文書版番号． */
  version: number;
  /** 階層を構成する構造ノードの配列． */
  nodes: StructureNode[];
  /** VS Codeのアウトライン表示に変換済みのシンボル配列． */
  symbols: vscode.DocumentSymbol[];
}

/**
 * 文書の版番号が変わらなくても，保存された関連ソースの変更でシンボルが変わる場合がある．
 * @param service 関連情報の取得や更新を担当するサービス．
 * @returns シンボルプロバイダと変更通知の登録をまとめて解除できるDisposable．
 */
export function registerDocumentSymbols(service: StructureService): vscode.Disposable {
  const provider = new LaTeXDocumentSymbolProvider(service);
  const register = () => vscode.languages.registerDocumentSymbolProvider(
    { language: 'latex' }, provider, { label: 'fortex' }
  );
  let registration = register();
  const refresh = () => { registration.dispose(); registration = register(); };
  const subscriptions = service.onDidChangeDocumentSymbols(refresh);
  return vscode.Disposable.from(subscriptions, new vscode.Disposable(() => registration.dispose()), provider);
}

/** 標準のアウトラインは現在のエディタ内の構造を表示する．プロジェクト全体のツリーは別に扱う． */
export default class LaTeXDocumentSymbolProvider implements vscode.DocumentSymbolProvider, vscode.Disposable {
  /** 情報の取得と変更通知を担当するサービス． */
  private readonly service: StructureService;
  /** このプロバイダがサービスを作成し，破棄も担当する場合はtrue． */
  private readonly ownsService: boolean;
  /** 文書ごとの版・構造ノード・変換済みシンボルを保持する弱参照キャッシュ． */
  private converted = new WeakMap<vscode.TextDocument, ConvertedSymbols>();

  /**
   * LaTeXDocumentSymbolProviderの初期状態と所有するリソースを準備する．
   * @param service 関連情報の取得や更新を担当するサービス．省略可能．
   * @returns 新しいインスタンス．コンストラクタから明示的な値は返さない．
   */
  constructor(service?: StructureService) {
    this.service = service ?? new StructureService(false);
    this.ownsService = service === undefined;
  }

  /**
   * 所有する監視・購読・表示などのリソースを解放する．
   * 引数はない．
   * @returns なし．
   */
  dispose(): void {
    this.converted = new WeakMap();
    if (this.ownsService) { this.service.dispose(); }
  }

  /**
   * 編集中の見出し構造をVS Codeのドキュメントシンボルへ変換する．
   * @param document 要求の対象となる編集中の文書．
   * @param token 要求のキャンセルを確認するトークン．省略可能．
   * @returns 見出しの階層を保つシンボル配列．キャンセル時は空配列．Promiseで返す．
   */
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
