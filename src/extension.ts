import * as vscode from 'vscode';
import LaTeXCompile from './compile/LaTeXCompile';
import LaTeXProject from './compile/LaTeXProject';
import Log from './log';
import ErrorManager from './compile/ErrorManager';
import Process from './compile/Process';
import Config from './Config';
import PDFPreview, { PDFViewer } from './preview/PDFPreview';
import CitationService from './citation/CitationService';
import CitationCompletionProvider from './citation/CitationCompletionProvider';
import { showCitationQuickPick } from './citation/CitationQuickPick';

const taskType = "fortex";

class BuildManeger{
  public constructor(private readonly preview: PDFPreview) {}
  // 通知の表示/非表示を制御するためのPromiseのresolve関数を保持します。
  private resolveNotification: (() => void) | undefined;

  private clearProgress(){
    if(this.resolveNotification){
      this.resolveNotification();
      this.resolveNotification = undefined;
    }
  }
  public async build(doc: vscode.TextDocument){
    let editor = vscode.window.activeTextEditor;
    if(!editor || editor.document !== doc){
      vscode.window.setStatusBarMessage("The document to compile is not the active editor.", 5000);
      return;
    }
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
            try {
              await this.preview.onBuildComplete(proj);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              void vscode.window.showErrorMessage(`The PDF was built, but the preview could not be updated: ${message}`);
            }
            new Promise<void>((resolve) => {resolve();});
          }
        });
      }catch(e){
        this.clearProgress();
      }
    }
  }
  public uninit(){
    this.clearProgress();
  }
}

let buildmanager: BuildManeger | undefined;
let preview: PDFPreview | undefined;

export function activate(context: vscode.ExtensionContext) {
	//Log.debug_log("Activate vscode-fortex extension");

  preview = new PDFPreview(context);
  buildmanager = new BuildManeger(preview);

	context.subscriptions.push(vscode.commands.registerCommand('vscode-fortex.build', async () => {
    let editor = vscode.window.activeTextEditor;
    if(editor){
      if(editor.document.languageId === "latex"){
        void buildmanager?.build(editor.document);
      }
    }
  }));
  const registerPreview = (command: string, viewer?: PDFViewer, sync = false) => {
    context.subscriptions.push(vscode.commands.registerCommand(command, async () => {
      try {
        await preview?.viewCurrent(viewer, sync);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Unable to open PDF preview: ${message}`);
      }
    }));
  };
  registerPreview('vscode-fortex.viewPdf');
  registerPreview('vscode-fortex.viewPdfInVSCode', 'internal');
  registerPreview('vscode-fortex.viewPdfInSumatraPDF', 'sumatra');
  registerPreview('vscode-fortex.syncTeXFromCursor', undefined, true);

  const citations = new CitationService();
  context.subscriptions.push(
    citations,
    vscode.languages.registerCompletionItemProvider(
      { language: 'latex' },
      new CitationCompletionProvider(citations),
      '{',
      ','
    ),
    vscode.commands.registerCommand('vscode-fortex.insertCitation', async () => {
      await showCitationQuickPick(citations);
    })
  );

  const disp = vscode.workspace.onDidSaveTextDocument((doc) => {
    if(doc.languageId === 'latex'){
      if(Config.compileTrigger().indexOf("onSave") >= 0){
        void buildmanager?.build(doc);
      }
    }
  });
  context.subscriptions.push(disp);

  ErrorManager.init(context);
  context.subscriptions.push(preview);
}

export function deactivate() {
  buildmanager?.uninit();
  Process.killAll();
}
