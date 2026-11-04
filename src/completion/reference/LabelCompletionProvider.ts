import * as vscode from 'vscode';
import { ReferenceContext } from './LabelParser';
import Config from '../../Config';
import * as Workspace from '../../workspace';
import CompletionSession from '../CompletionSession';
import { completionSources } from '../CompletionSources';
import { collectRawLabels } from '../RawCompletionCollector';

interface LabelCandidate {
  /** 参照または検索に使用する識別キー． */
  key: string;
  /** 対象ファイルのURI． */
  uri: vscode.Uri
}
class LabelCompletionItem extends vscode.CompletionItem {
  /**
   * LabelCompletionItemの初期状態と所有するリソースを準備する．
   * @param candidate 現在評価している補完候補と関連情報．
   * @returns 新しいインスタンス．コンストラクタから明示的な値は返さない．
   */
  constructor(/** この補完項目に対応するラベル名と元ファイル． */ readonly candidate: LabelCandidate) { super(candidate.key, vscode.CompletionItemKind.Reference); }
}

const maximumCompletionItems = 200;

/** 新しい入力範囲でラベルを読み取り，その検索文字列を編集中の間だけ保持する． */
export default class LabelCompletionProvider implements vscode.Disposable {
  /** 補完候補の読み込みと監視を共有するセッション． */
  private readonly session = new CompletionSession<LabelCandidate[]>();

  /**
   * カーソル位置の入力に一致する補完候補を作る．
   * @param document 要求の対象となる編集中の文書．
   * @param position 文書内の0始まりの行番号とUTF-16列位置．
   * @param context 入力中のラベル名と，その先頭のUTF-16位置．
   * @param token 要求のキャンセルを確認するトークン．
   * @returns 表示する補完候補の一覧．要求がキャンセルされた場合などはundefined．Promiseで返す．
   */
  public async complete(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: ReferenceContext,
    token: vscode.CancellationToken
  ): Promise<vscode.CompletionList | undefined> {
    if (token.isCancellationRequested) { return undefined; }
    const labels = await this.session.get(document, {
      start: context.queryStart, end: document.offsetAt(position), scope: Config.completionScope('label', document.uri)
    }, token, async requestToken => {
      const sources = await completionSources(document, 'label', requestToken, (uris, directories) => {
        this.session.watch(uris, requestToken); this.session.watchDirectories(directories ?? [], requestToken);
      });
      const unique = new Map<string, LabelCandidate>();
      for (const { uri, source } of sources) {
        for (const { key } of collectRawLabels(source)) {
          if (!unique.has(key)) { unique.set(key, { key, uri }); }
        }
      }
      return [...unique.values()].sort((left, right) => left.key.localeCompare(right.key));
    });
    if (!labels || token.isCancellationRequested) { return undefined; }
    const matching = labels.filter(label => fuzzyMatch(label.key, context.query));
    const range = new vscode.Range(document.positionAt(context.queryStart), position);
    const items = matching.slice(0, maximumCompletionItems).map(label => {
      const item = new LabelCompletionItem(label);
      item.insertText = label.key;
      item.filterText = label.key;
      item.range = range;
      return item;
    });
    return new vscode.CompletionList(items, true);
  }

  /**
   * ソースの説明は，選択された補完候補についてだけ作成する．
   * @param item 更新または変換する表示項目．
   * @param token 要求のキャンセルを確認するトークン．
   * @returns 説明を追加した補完項目．Promiseで返す．
   */
  public async resolveCompletionItem(item: vscode.CompletionItem, token: vscode.CancellationToken): Promise<vscode.CompletionItem> {
    if (!(item instanceof LabelCompletionItem) || token.isCancellationRequested) { return item; }
    let source: string;
    try { source = await Workspace.readDocumentText(item.candidate.uri); }
    catch { return item; }
    if (token.isCancellationRequested) { return item; }
    const occurrence = collectRawLabels(source).find(label => label.key === item.candidate.key);
    if (!occurrence) { return item; }
    const line = source.slice(0, occurrence.offset).split(/\r\n|\r|\n/).length - 1;
    const lines = source.split(/\r\n|\r|\n/);
    const context = lines.slice(Math.max(0, line - 2), Math.min(lines.length, line + 3))
      .map(value => value.length > 300 ? `${value.slice(0, 297)}...` : value).join('\n');
    const documentation = new vscode.MarkdownString();
    documentation.appendCodeblock(context, 'latex');
    item.documentation = documentation;
    item.detail = `${item.candidate.uri.fsPath || item.candidate.uri.toString()}:${line + 1}`;
    return item;
  }

  /**
   * 変更された入力に依存するキャッシュを無効にする．
   * 引数はない．
   * @returns なし．
   */
  public invalidate(): void { this.session.invalidate(); }
  /**
   * 所有する監視・購読・表示などのリソースを解放する．
   * 引数はない．
   * @returns なし．
   */
  public dispose(): void { this.session.dispose(); }
}

/**
 * 検索文字が対象文字列に順番どおり現れるかを判定する．
 * @param value 変換または検証する値．
 * @param query 現在入力されている検索文字列．
 * @returns 検索文字がすべて順序を保って一致する場合はtrue．
 */
function fuzzyMatch(value: string, query: string): boolean {
  let index = 0;
  const normalized = query.toLocaleLowerCase();
  if (!normalized) { return true; }
  for (const character of value.toLocaleLowerCase()) {
    if (character === normalized[index] && ++index === normalized.length) { return true; }
  }
  return false;
}
