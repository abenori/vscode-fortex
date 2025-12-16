import * as vscode from 'vscode';
import LaTeXCompile from './compile/LaTeXCompile';
import LaTeXProject from './compile/LaTeXProject';
import Log from './log';

const taskType = "fortex";

class BuildManeger{
  // 通知の表示/非表示を制御するためのPromiseのresolve関数を保持します。
  private resolveNotification: (() => void) | undefined;

  private clearProgress(){
    if(this.resolveNotification){
      this.resolveNotification();
      this.resolveNotification = undefined;
    }
  }
  public async build(){
    let proj = new LaTeXProject(vscode.window.activeTextEditor?.document.fileName || "", true);
    if(!proj.valid){
      Log.error("Cannot find the main file.");
      return;
    }
    if(LaTeXCompile.working){
      const statusBarItem = vscode.window.setStatusBarMessage("$(sync~spin) Compilation is in progress. Please wait until it finishes.", 5000);
    } else {
      this.clearProgress();
      let compile = new LaTeXCompile(proj);
      vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        //title: "Compiling LaTeX document...",
        cancellable: false
      }, async (progress, token) => {
        progress.report({ message: "Compiling LaTeX document..." });
        let result = await compile.build();
        if(!result){
          progress.report({ increment: 100, message: "❌ Compilation failed due to errors. Please check the output for details." });
          await new Promise<void>((resolve) => {
            this.resolveNotification = resolve;
            token.onCancellationRequested(() => resolve());
          });
        }else{
          new Promise<void>((resolve) => {resolve();});
        }
      });
    }
  }
}

let buildmanager = new BuildManeger();

export function activate(context: vscode.ExtensionContext) {
	//console.log('Congratulations, your extension "vscode-fortex" is now active!');
  Log.debug_log("Activate vscode-fortex extension");

	context.subscriptions.push(vscode.commands.registerCommand('vscode-fortex.build', async () => {
    // The code you place here will be executed every time your command is executed
    buildmanager.build();
  }));
  const disp = vscode.workspace.onDidSaveTextDocument((doc) => {
    if(doc.languageId === 'latex'){
      buildmanager.build();
    }
  });
  context.subscriptions.push(disp);
}



// This method is called when your extension is deactivated
export function deactivate() {}
