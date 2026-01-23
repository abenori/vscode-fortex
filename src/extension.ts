import * as vscode from 'vscode';
import LaTeXCompile from './compile/LaTeXCompile';
import LaTeXProject from './compile/LaTeXProject';
import Log from './log';
import ErrorManager from './compile/ErrorManager';

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
  public async build(doc: vscode.TextDocument){
    if(LaTeXCompile.working){
      const statusBarItem = vscode.window.setStatusBarMessage("$(sync~spin) Compilation is in progress. Please wait until it finishes.", 5000);
    } else {
      try{
        this.clearProgress();
        let proj = new LaTeXProject(
          await LaTeXProject.generate_project(doc.uri, true)
        );
        let compile = new LaTeXCompile(proj);
        await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          //title: "Compiling LaTeX document...",
          cancellable: false
        }, async (progress, token) => {
          progress.report({ message: "Compiling LaTeX document..." });
          let result = await compile.build();
          if(!result){
            
            progress.report({ increment: 100, message: "❌ Compilation failed due to errors. Please check the output for details." });
            await new Promise<void>((resolve) => {
              if(this.resolveNotification){
                this.resolveNotification();
              }
              this.resolveNotification = resolve;
              token.onCancellationRequested(() => resolve());
            });
          }else{
            new Promise<void>((resolve) => {resolve();});
          }
        });
      }catch(e){
        this.clearProgress();
      }
    }
  }
}

let buildmanager = new BuildManeger();

export function activate(context: vscode.ExtensionContext) {
	//Log.debug_log("Activate vscode-fortex extension");

	context.subscriptions.push(vscode.commands.registerCommand('vscode-fortex.build', async () => {
    let editor = vscode.window.activeTextEditor;
    if(editor){
      if(editor.document.languageId === "latex"){
        buildmanager.build(editor.document);
      }
    }
  }));
  const disp = vscode.workspace.onDidSaveTextDocument((doc) => {
    if(doc.languageId === 'latex'){
      buildmanager.build(doc);
    }
  });
  context.subscriptions.push(disp);

  ErrorManager.init(context);
}

export function deactivate() {}
