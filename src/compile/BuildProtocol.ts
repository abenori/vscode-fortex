import type * as vscode from 'vscode';

/** ビルドの種類に依存せず，実行側が内容を決める通知． */
export interface BuildNotice {
  /** 利用者へ表示するメッセージ． */
  readonly message: string;
  /** infoは情報，warningは警告，errorは失敗を表す． */
  readonly severity: 'info' | 'warning' | 'error';
}

/** 診断の省略時はProblemsを保持する．entriesが空配列なら指定キーの診断を消去する． */
export interface BuildResult extends BuildNotice {
  /** succeededは成功，failedは失敗，cancelledは中止を表す． */
  readonly outcome: 'succeeded' | 'failed' | 'cancelled';
  /** 今回の要求で置き換える診断グループのキーと，ファイル別の診断一覧．省略時は既存の診断を保持する． */
  readonly diagnostics?: {
    /** このビルドで置き換える診断グループを識別するURI． */
    readonly key: vscode.Uri;
    /** 診断対象ファイルのURIと，そのファイルの診断一覧の組．空配列ならこのグループの診断を消去する． */
    readonly entries: readonly [vscode.Uri, readonly vscode.Diagnostic[]][];
  };
}

/** 要求ごとの進捗通知と協調的なキャンセルの窓口． */
export interface BuildContext {
  /** 処理のキャンセル状態を確認するトークン． */
  readonly token: vscode.CancellationToken;
  /**
   * 現在のビルド段階と表示対象を通知する．
   * @param message 表示または記録するメッセージ．
   * @param target 処理または表示の対象．省略可能．
   * @returns なし．
   */
  reportProgress(message: string, target?: vscode.Uri): void;
  /**
   * ビルドに付随する通知を更新する．通知の省略時は表示を解除する．
   * @param notice 利用者へ表示するメッセージと，情報・警告・エラーの重要度．省略時は既存の通知を解除する．
   * @returns なし．
   */
  reportNotice(notice?: BuildNotice): void;
}

/** 保存済みソースに対する再実行可能な要求．実行のたびに入力を探索し直す． */
export interface BuildRequest {
  /** 要求の起点となるソースファイルのURI． */
  readonly source: vscode.Uri;
  /** 要求または項目の表示名． */
  readonly label: string;
  /**
   * 要求が保持するビルド処理を実行する．
   * @param context キャンセルトークンと，ビルドの進捗・通知を受け取る関数．
   * @returns 要求の成否と，必要に応じた診断スナップショット．Promiseで返す．
   */
  execute(context: BuildContext): Promise<BuildResult>;
}
