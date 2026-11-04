import * as vscode from 'vscode';
import CitationCompletionProvider from './citation/CitationCompletionProvider';
import CommandCompletionProvider from './command/CommandCompletionProvider';
import { findCompletionContext } from './CompletionContext';
import EnvironmentCompletionProvider from './environment/EnvironmentCompletionProvider';
import LabelCompletionProvider from './reference/LabelCompletionProvider';

type DispatchProvider<Arguments extends unknown[]> = {
  /**
   * カーソル位置の入力に一致する補完候補を作る．
   * @param args 各種補完処理が要求する文書，位置，構文情報，およびキャンセルトークン．
   * @returns 表示する補完候補の一覧．要求がキャンセルされた場合などはundefined．
   */
  complete(...args: Arguments): vscode.ProviderResult<vscode.CompletionList>;
  /**
   * 変更された入力に依存するキャッシュを無効にする．
   * 引数はない．
   * @returns なし．
   */
  invalidate?(): void;
};
interface CompletionProviders {
  /** ラベル参照を担当する補完プロバイダ． */
  reference: DispatchProvider<Parameters<LabelCompletionProvider['complete']>> & Partial<Pick<LabelCompletionProvider, 'resolveCompletionItem'>>;
  /** 文献引用を担当する補完プロバイダ． */
  citation: DispatchProvider<Parameters<CitationCompletionProvider['complete']>>;
  /** 環境名を担当する補完プロバイダ． */
  environment: DispatchProvider<Parameters<EnvironmentCompletionProvider['complete']>>;
  /** 対象のコマンド名または実行ファイル名． */
  command: DispatchProvider<Parameters<CommandCompletionProvider['complete']>>;
}

/** 現在行を一度だけ読み取り，構文に一致する補完プロバイダだけを呼ぶ． */
export default class LaTeXCompletionProvider implements vscode.CompletionItemProvider {
  /**
   * LaTeXCompletionProviderの初期状態と所有するリソースを準備する．
   * @param providers 参照・引用・環境・コマンドの補完を担当するプロバイダ．
   * @returns 新しいインスタンス．コンストラクタから明示的な値は返さない．
   */
  public constructor(/** 構文の種類ごとの補完プロバイダ． */ private readonly providers: CompletionProviders) {}

  /**
   * カーソル付近の構文から適切な補完プロバイダへ要求を渡す．
   * @param document 要求の対象となる編集中の文書．
   * @param position 文書内の0始まりの行番号とUTF-16列位置．
   * @param token 要求のキャンセルを確認するトークン．
   * @returns 構文に対応する補完候補．対象外ならundefined．
   */
  public provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.CompletionList> {
    if (token.isCancellationRequested) {
      return undefined;
    }
    const line = document.lineAt(position.line);
    const lineOffset = document.offsetAt(line.range.start);
    const context = findCompletionContext(line.text, position.character, lineOffset);
    // 文字列が編集されていなくても，別のコマンドや引数へ移動した場合は新しい補完範囲として扱う．
    for (const kind of ['reference', 'citation', 'environment', 'command'] as const) {
      if (kind !== context?.kind) { this.providers[kind].invalidate?.(); }
    }
    switch (context?.kind) {
      case 'reference':
        return this.providers.reference.complete(document, position, context, token);
      case 'citation':
        return this.providers.citation.complete(document, position, context, token);
      case 'environment':
        return this.providers.environment.complete(document, position, context, token);
      case 'command':
        return this.providers.command.complete(document, position, context, token);
      default:
        return undefined;
    }
  }

  /**
   * 選択された補完項目の詳細情報を必要になった時点で補う．
   * @param item 更新または変換する表示項目．
   * @param token 要求のキャンセルを確認するトークン．
   * @returns 説明を追加した補完項目．
   */
  public resolveCompletionItem(item: vscode.CompletionItem, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CompletionItem> {
    return this.providers.reference.resolveCompletionItem?.(item, token) ?? item;
  }
}
