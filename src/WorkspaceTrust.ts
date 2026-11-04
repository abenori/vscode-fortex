import * as vscode from 'vscode';

/**
 * 外部プログラムの実行や，ワークスペースで生成した内容の表示を行う機能を保護する．UI上の有効条件だけでは直接のコマンド呼び出しを防げないため，各実装も処理前にこの検証を行う．
 *
 * @param feature 信頼済みワークスペースを必要とする機能の表示名．
 * @returns なし．
 */
export function assertWorkspaceTrusted(feature: string): void {
  if (!vscode.workspace.isTrusted) {
    throw new Error(`${feature} is disabled until this workspace is trusted.`);
  }
}
