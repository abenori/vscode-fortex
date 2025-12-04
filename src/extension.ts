import * as vscode from 'vscode';
import LaTeXCompile from './compile/LaTeXCompile';
import LaTeXProject from './compile/LaTeXProject';
import Log from './log';

const taskType = "fortex";

async function build(){
  let proj = new LaTeXProject(vscode.window.activeTextEditor?.document.fileName || "", true);
  let compile = new LaTeXCompile(proj);
  if(LaTeXCompile.working){
    const statusBarItem = vscode.window.setStatusBarMessage("$(sync~spin) Compilation is in progress. Please wait until it finishes.", 5000);
  } else {
    let result = await compile.build();
    if(!result){
      const statusBarItem = vscode.window.setStatusBarMessage("$(warning) Compilation failed due to errors. Please check the output for details.", 5000);
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
	//console.log('Congratulations, your extension "vscode-fortex" is now active!');
  Log.debug_log("Activate vscode-fortex extension");

	context.subscriptions.push(vscode.commands.registerCommand('vscode-fortex.build', async () => {
    // The code you place here will be executed every time your command is executed
    build();
  }));
  const disp = vscode.workspace.onDidSaveTextDocument((doc) => {
    Log.debug_log("onDidSaveTextDocument: ");
    Log.debug_log(doc.languageId)
    if(doc.languageId === 'latex'){
      build();
    }
  });
  context.subscriptions.push(disp);
}



// This method is called when your extension is deactivated
export function deactivate() {}
