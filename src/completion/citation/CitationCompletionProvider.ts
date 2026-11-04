import * as vscode from 'vscode';
import { CitationContext } from './Citation';
import CitationService from './CitationService';
import { searchCitations } from './CitationSearch';
import CompletionSession from '../CompletionSession';
import { CitationEntry } from './Citation';

/** カーソルが引用コマンドの引数内にある場合にBibTeXの引用キーを補完する． */
export default class CitationCompletionProvider implements vscode.Disposable {
  /** 補完候補の読み込みと監視を共有するセッション． */
  private readonly session = new CompletionSession<CitationEntry[]>();
  /**
   * CitationCompletionProviderの初期状態と所有するリソースを準備する．
   * @param service 関連情報の取得や更新を担当するサービス．
   * @returns 新しいインスタンス．コンストラクタから明示的な値は返さない．
   */
  public constructor(/** 情報の取得と変更通知を担当するサービス． */ private readonly service: CitationService) {}

  /**
   * 変更された入力に依存するキャッシュを無効にする．
   * 引数はない．
   * @returns なし．
   */
  public invalidate(): void {
    this.session.invalidate();
  }

  /**
   * 所有する監視・購読・表示などのリソースを解放する．
   * 引数はない．
   * @returns なし．
   */
  public dispose(): void {
    this.session.dispose();
  }

  /**
   * カーソル位置の入力に一致する補完候補を作る．
   * @param document 要求の対象となる編集中の文書．
   * @param position 文書内の0始まりの行番号とUTF-16列位置．
   * @param context 入力中の引用キーと，その先頭のUTF-16位置．
   * @param token 要求のキャンセルを確認するトークン．
   * @returns 表示する補完候補の一覧．要求がキャンセルされた場合などはundefined．Promiseで返す．
   */
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
    // 画面に表示する候補数を制限する前に，すべての文献の順位を決める．
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

    // isIncompleteを指定し，検索文字列が変わるたびにVS Codeから補完を再要求させる．
    return new vscode.CompletionList(items, true);
  }
}

/**
 * 補完項目の説明へ埋め込む文字列のMarkdown記号をエスケープする．
 * @param value 変換または検証する値．
 * @returns Markdownの装飾として解釈されない文字列．
 */
function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+\-.!]/g, '\\$&');
}
