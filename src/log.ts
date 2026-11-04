import * as vscode from 'vscode';

const LOG_PANEL = vscode.window.createOutputChannel('fortex-vscode');

/** fortexの共有出力チャンネルへコンパイルの進捗と診断を記録する． */
export default class Log {
  /** デバッグログを出力する場合はtrue． */
  static readonly DEBUG = true;
  /**
   * 拡張機能の情報メッセージをログへ記録する．
   * @param message 表示または記録するメッセージ．
   * @param args メッセージ中の%sを先頭から順に置き換える値．
   * @returns なし．
   */
  public static log(message: string, ...args: any[]) {
    if (args.length > 0) {
      message = message.replace(/%s/g, () => args.shift());
    }
    LOG_PANEL.appendLine(message);
  }

  /**
   * 拡張機能のエラーメッセージをログへ記録する．
   * @param message 表示または記録するメッセージ．
   * @param args メッセージ中の%sを先頭から順に置き換える値．
   * @returns なし．
   */
  public static error(message: string, ...args: any[]) {
    if (args.length > 0) {
      message = message.replace(/%s/g, () => args.shift());
    }
    LOG_PANEL.appendLine(`Error: ${message}`);
  }

  /**
   * 外部コマンドの実行出力を専用の出力チャンネルへ追加する．
   * @param message 表示または記録するメッセージ．
   * @param args メッセージ中の%sを先頭から順に置き換える値．
   * @returns なし．
   */
  public static process_message(message: string, ...args: any[]) {
    // コンパイラの出力には改行が含まれるため，appendLineではなくappendで追加する．
    if (args.length > 0) {
      message = message.replace(/%s/g, () => args.shift());
    }
    LOG_PANEL.append(message);
  }

  /**
   * 外部コマンドの実行出力を消去する．
   * 引数はない．
   * @returns なし．
   */
  public static clear_process_message(){
    LOG_PANEL.clear();
  }

  /**
   * 利用者が確認を求めた場合だけ，記録済みの出力を表示する．
   * 引数はない．
   * @returns なし．
   */
  public static show(){ LOG_PANEL.show(true); }

  /**
   * デバッグ出力が有効な場合にメッセージを記録する．
   * @param message 表示または記録するメッセージ．
   * @param args デバッグメッセージの書式指定へ渡す値．
   * @returns なし．
   */
  public static debug_log(message: string, ...args: any[]) {
    if (args.length > 0) {
      message = message.replace(/%s/g, () => args.shift());
    }
    console.log(`Debug: ${message}`);
  }
}
