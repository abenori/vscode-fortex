import * as vscode from 'vscode';
import { COMMAND_CATALOG, CommandCatalogEntry } from './CommandCatalog';
import { CommandContext } from './CommandParser';
import Config from '../../Config';
import CompletionSession from '../CompletionSession';
import { completionSources } from '../CompletionSources';
import { collectRawCommands, RawCommand } from '../RawCompletionCollector';

/** 固定のカタログと，現在の入力範囲で収集した定義をまとめる． */
export default class CommandCompletionProvider implements vscode.Disposable {
  /** 補完候補の読み込みと監視を共有するセッション． */
  private readonly session = new CompletionSession<RawCommand[]>();

  /**
   * カーソル位置の入力に一致する補完候補を作る．
   * @param document 要求の対象となる編集中の文書．
   * @param position 文書内の0始まりの行番号とUTF-16列位置．
   * @param context 入力中のコマンド名と，文書全体を基準にしたバックスラッシュのUTF-16位置．
   * @param token 要求のキャンセルを確認するトークン．
   * @returns 表示する補完候補の一覧．要求がキャンセルされた場合などはundefined．Promiseで返す．
   */
  public async complete(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: CommandContext,
    token: vscode.CancellationToken
  ): Promise<vscode.CompletionList | undefined> {
    if (token.isCancellationRequested) { return undefined; }
    const commands = await this.session.get(document, {
      start: context.start + 1, end: document.offsetAt(position), scope: Config.completionScope('command', document.uri)
    }, token, async requestToken => {
      const sources = await completionSources(document, 'command', requestToken, (uris, directories) => {
        this.session.watch(uris, requestToken); this.session.watchDirectories(directories ?? [], requestToken);
      });
      const unique = new Map<string, RawCommand>();
      for (const { source } of sources) {
        for (const command of collectRawCommands(source)) { unique.set(command.name, command); }
      }
      return [...unique.values()];
    });
    if (!commands || token.isCancellationRequested) { return undefined; }
    const range = new vscode.Range(document.positionAt(context.start), position);
    const items = new Map<string, vscode.CompletionItem>();
    for (const command of COMMAND_CATALOG) {
      if (fuzzyMatch(command.name, context.query)) { items.set(command.name, catalogItem(command, range)); }
    }
    for (const command of commands) {
      if (fuzzyMatch(command.name, context.query)) { items.set(command.name, customCommandItem(command, range)); }
    }
    return new vscode.CompletionList([...items.values()], true);
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
 * 標準コマンドのカタログ項目を補完項目へ変換する．
 * @param command 標準コマンドの名前，スニペット，および候補の説明．
 * @param range 文書内で開始位置を含み終端を含まない範囲．
 * @returns 置換範囲とスニペットを設定した標準コマンドの補完項目．
 */
function catalogItem(command: CommandCatalogEntry, range: vscode.Range): vscode.CompletionItem {
  const item = new vscode.CompletionItem(`\\${command.name}`, vscode.CompletionItemKind.Function);
  item.range = range;
  item.filterText = `\\${command.name}`;
  item.insertText = new vscode.SnippetString(command.snippet);
  item.detail = command.detail;
  item.sortText = `1:${command.name}`;
  if (command.retriggerSuggestions) {
    item.command = { command: 'editor.action.triggerSuggest', title: 'Trigger LaTeX argument completion' };
  }
  return item;
}

/**
 * ソースで定義されたコマンドを補完項目へ変換する．
 * @param command ソースで定義されたコマンド名，引数の個数，および先頭引数が省略可能かの情報．
 * @param range 文書内で開始位置を含み終端を含まない範囲．
 * @returns 引数の入力位置を含むユーザー定義コマンドの補完項目．
 */
function customCommandItem(command: RawCommand, range: vscode.Range): vscode.CompletionItem {
  const item = new vscode.CompletionItem(`\\${command.name}`, vscode.CompletionItemKind.Function);
  item.range = range;
  item.filterText = `\\${command.name}`;
  item.insertText = customCommandSnippet(command);
  item.detail = command.argumentCount === 0
    ? 'User-defined command'
    : `User-defined command · ${command.argumentCount} argument${command.argumentCount === 1 ? '' : 's'}`;
  item.sortText = `0:${command.name}`;
  return item;
}

/**
 * 従来のnewcommand定義に対し，引数を順に入力するタブ移動位置を作る．
 * @param command ソースで定義されたコマンド名，引数の個数，および先頭引数が省略可能かの情報．
 * @returns コマンド名と，既知の必須・省略可能引数の入力位置を含むスニペット．
 */
function customCommandSnippet(command: RawCommand): vscode.SnippetString {
  const snippet = new vscode.SnippetString();
  snippet.appendText(`\\${command.name}`);
  let tabstop = 1;
  let requiredArguments = command.argumentCount;
  if (command.optionalFirstArgument) {
    snippet.appendText('[');
    snippet.appendPlaceholder('option', tabstop++);
    snippet.appendText(']');
    requiredArguments--;
  }
  for (let argument = 0; argument < requiredArguments; argument++) {
    snippet.appendText('{');
    snippet.appendPlaceholder(`arg${argument + 1}`, tabstop++);
    snippet.appendText('}');
  }
  snippet.appendTabstop(0);
  return snippet;
}

/**
 * 検索文字が対象文字列に順番どおり現れるかを判定する．
 * @param value 変換または検証する値．
 * @param query 現在入力されている検索文字列．
 * @returns 検索文字がすべて順序を保って一致する場合はtrue．
 */
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
