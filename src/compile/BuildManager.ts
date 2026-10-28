import * as vscode from 'vscode';
import LaTeXCompile from './LaTeXCompile';
import LaTeXProject from '../project/LaTeXProject';
import type PDFPreview from './preview/PDFPreview';
import * as Workspace from '../workspace';

/** Serializes builds and keeps the long-running progress notification dismissible. */
export default class BuildManager{
  public constructor(private readonly preview: PDFPreview) {}
  // 通知の表示/非表示を制御するためのPromiseのresolve関数を保持します。
  private resolveNotification: (() => void) | undefined;

  private clearProgress(){
    // Resolving the stored promise closes a previous failed-build notification
    // before the next build starts or the extension shuts down.
    if(this.resolveNotification){
      this.resolveNotification();
      this.resolveNotification = undefined;
    }
  }
  public async build(doc: vscode.TextDocument){
    // Keep this runtime check at the shared build entry point. Command enablement
    // improves the UI, but save-triggered builds and programmatic command calls
    // must also be unable to start TeX in an untrusted workspace.
    if (!vscode.workspace.isTrusted) {
      vscode.window.setStatusBarMessage(
        '$(shield) LaTeX build is disabled until this workspace is trusted.',
        5000
      );
      return;
    }
    let editor = vscode.window.activeTextEditor;
    if(!editor || editor.document !== doc){
      vscode.window.setStatusBarMessage("The document to compile is not the active editor.", 5000);
      return;
    }
    if(LaTeXCompile.working){
      vscode.window.setStatusBarMessage("$(sync~spin) Compilation is in progress. Please wait until it finishes.", 5000);
    } else {
      try{
        this.clearProgress();
        // Use the saved sources that TeX reads, even if editing continues while
        // project discovery is pending.
        let proj = await LaTeXProject.create(doc.uri, { readSource: Workspace.readFileText });
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
      }catch{
        this.clearProgress();
      }
    }
  }
  public uninit(){
    this.clearProgress();
  }
}
