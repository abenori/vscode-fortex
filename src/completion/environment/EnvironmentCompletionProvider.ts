import * as vscode from 'vscode';
import Config from '../../Config';
import * as LaTeXParser from '../../latex-parser';
import CompletionSession from '../CompletionSession';
import { completionSources } from '../CompletionSources';
import { collectRawEnvironments } from '../RawCompletionCollector';
import {
  STANDARD_ENVIRONMENTS,
  EnvironmentCompletionContext
} from './EnvironmentParser';

/** 環境の開始宣言または数式の開き区切りの補完から，対応する開始・終了宣言を挿入する． */
export default class EnvironmentCompletionProvider implements vscode.Disposable {
  /** 補完候補の読み込みと監視を共有するセッション． */
  private readonly session = new CompletionSession<string[]>();

  /**
   * カーソル位置の入力に一致する補完候補を作る．
   * @param document 要求の対象となる編集中の文書．
   * @param position 文書内の0始まりの行番号とUTF-16列位置．
   * @param context 環境または数式の記法，入力中の名前，および置換範囲のUTF-16位置．
   * @param token 要求のキャンセルを確認するトークン．
   * @returns 表示する補完候補の一覧．要求がキャンセルされた場合などはundefined．Promiseで返す．
   */
  public async complete(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: EnvironmentCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.CompletionList | undefined> {
    if (token.isCancellationRequested) {
      return undefined;
    }

    if (context.style === 'display') {
      this.invalidate();
      return new vscode.CompletionList([this.makeDisplayItem(document, position, context)], false);
    }

    const names = await this.session.get(document, {
      start: context.queryStart, end: document.offsetAt(position), scope: Config.completionScope('environment', document.uri)
    }, token, async requestToken => {
      const sources = await completionSources(document, 'environment', requestToken, (uris, directories) => {
        this.session.watch(uris, requestToken); this.session.watchDirectories(directories ?? [], requestToken);
      });
      const unique = new Set<string>(STANDARD_ENVIRONMENTS);
      for (const { source } of sources) {
        for (const name of collectRawEnvironments(source)) { unique.add(name); }
      }
      return [...unique].sort((left, right) => left.localeCompare(right));
    });
    if (!names || token.isCancellationRequested) { return undefined; }
    const items = names.map((name) => this.makeNamedItem(document, position, context, name));
    return new vscode.CompletionList(items, true);
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

  /**
   * 名前付きLaTeX環境を挿入する補完項目を作る．
   * @param document 要求の対象となる編集中の文書．
   * @param position 文書内の0始まりの行番号とUTF-16列位置．
   * @param context 環境または数式の記法，入力中の名前，および置換範囲のUTF-16位置．
   * @param name 対象を識別する名前．
   * @returns 対応する開始・終了宣言と入力位置を持つ補完項目．
   */
  private makeNamedItem(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: EnvironmentCompletionContext,
    name: string
  ): vscode.CompletionItem {
    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Snippet);
    item.filterText = name;
    item.range = this.range(document, context);
    item.insertText = environmentSnippet(document, position, name, false);
    return item;
  }

  /**
   * ディスプレイ数式の区切りを挿入する補完項目を作る．
   * @param document 要求の対象となる編集中の文書．
   * @param position 文書内の0始まりの行番号とUTF-16列位置．
   * @param context 環境または数式の記法，入力中の名前，および置換範囲のUTF-16位置．
   * @returns ディスプレイ数式の開始・終了区切りを持つ補完項目．
   */
  private makeDisplayItem(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: EnvironmentCompletionContext
  ): vscode.CompletionItem {
    const item = new vscode.CompletionItem('\\[ … \\]', vscode.CompletionItemKind.Snippet);
    item.filterText = LaTeXParser.DISPLAY_MATH_ENVIRONMENT;
    item.range = this.range(document, context);
    item.insertText = environmentSnippet(document, position, LaTeXParser.DISPLAY_MATH_ENVIRONMENT, true);
    return item;
  }

  /**
   * 環境名の補完で置き換える文書内の範囲を求める．
   * @param document 要求の対象となる編集中の文書．
   * @param context 環境または数式の記法，入力中の名前，および置換範囲のUTF-16位置．
   * @returns 入力済みの環境名と必要な終端を含むVS Codeの範囲．
   */
  private range(document: vscode.TextDocument, context: EnvironmentCompletionContext): vscode.Range {
    return new vscode.Range(document.positionAt(context.queryStart), document.positionAt(context.replaceEnd));
  }
}

/**
 * 現在行の字下げに合わせた環境の挿入スニペットを作る．
 * @param document 要求の対象となる編集中の文書．
 * @param position 文書内の0始まりの行番号とUTF-16列位置．
 * @param name 対象を識別する名前．
 * @param includeOpening 環境の開始宣言もスニペットへ含める場合はtrue．
 * @returns 開始宣言，本文の入力位置，および終了宣言を含むスニペット．
 */
export function environmentSnippet(
  document: vscode.TextDocument,
  position: vscode.Position,
  name: string,
  includeOpening: boolean
): vscode.SnippetString {
  // beginの補完では，開始コマンドと開き波括弧が置換範囲の外にあるため，includeOpeningをfalseにする．
  const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const line = document.lineAt(position.line).text;
  const indentation = line.match(/^\s*/)?.[0] ?? '';
  const indentUnit = environmentContentIndentation(document.uri);
  const opening = name === LaTeXParser.DISPLAY_MATH_ENVIRONMENT ? '\\[' : `\\begin{${name}}`;
  const closing = name === LaTeXParser.DISPLAY_MATH_ENVIRONMENT ? '\\]' : `\\end{${name}}`;
  const snippet = new vscode.SnippetString();

  if (includeOpening) {
    snippet.appendText(opening);
  } else {
    snippet.appendText(`${name}}`);
  }
  snippet.appendText(`${eol}${indentation}${indentUnit}`);
  snippet.appendTabstop();
  snippet.appendText(`${eol}${indentation}${closing}`);
  return snippet;
}

/**
 * エディタ設定から字下げ1段分の文字列を求める．
 * @param uri 対象ファイルのURI．
 * @returns タブ1文字，または設定された幅のスペース．
 */
export function indentationUnit(uri: vscode.Uri): string {
  // 独自の字下げ設定を持たず，エディタの設定を再利用する．
  const configuration = vscode.workspace.getConfiguration('editor', uri);
  if (!configuration.get<boolean>('insertSpaces', true)) {
    return '\t';
  }
  const configuredSize = configuration.get<number | string>('tabSize', 4);
  const size = typeof configuredSize === 'number' ? configuredSize : Number.parseInt(configuredSize, 10);
  return ' '.repeat(Number.isFinite(size) && size > 0 ? size : 4);
}

/**
 * 環境本文に追加する字下げ文字列を求める．
 * @param uri 対象ファイルのURI．
 * @returns 本文を字下げする設定なら1段分の字下げ，無効なら空文字列．
 */
export function environmentContentIndentation(uri: vscode.Uri): string {
  // 字下げを1段追加するかはfortexが決め，1段分の文字列はVS Codeの設定に従う．
  return Config.environmentIndentContent() ? indentationUnit(uri) : '';
}
