import * as vscode from 'vscode';

const LOG_PANEL = vscode.window.createOutputChannel('fortex-vscode');


export default class LaTeXProject {
  public static log(message: string, ...args: any[]) {
    if (args.length > 0) {
      message = message.replace(/%s/g, () => args.shift());
    }
    LOG_PANEL.appendLine(message);
  }

  public static error(message: string, ...args: any[]) {
    if (args.length > 0) {
      message = message.replace(/%s/g, () => args.shift());
    }
    LOG_PANEL.appendLine(`Error: ${message}`);
  }

  public static process_message(message: string, ...args: any[]) {
    if (args.length > 0) {
      message = message.replace(/%s/g, () => args.shift());
    }
    LOG_PANEL.append(message);
  }

  public static clear_process_message(){
    LOG_PANEL.clear();
  }

  public static scroll_to_last_process_message(){
    LOG_PANEL.show(true);
  }

  public static debug_log(message: string, ...args: any[]) {
    if (args.length > 0) {
      message = message.replace(/%s/g, () => args.shift());
    }
    console.log(`Debug: ${message}`);
  }
}
