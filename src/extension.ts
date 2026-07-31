import * as vscode from 'vscode';
import LaTeXCompile from './compile/LaTeXCompile';
import LaTeXProject from './compile/LaTeXProject';
import Log from './log';
import ErrorManager from './compile/ErrorManager';
import Process from './compile/Process';
import Config from './Config';
import PDFPreview, { PDFViewer } from './compile/preview/PDFPreview';
import CitationService from './completion/citation/CitationService';
import CitationCompletionProvider from './completion/citation/CitationCompletionProvider';
import { showCitationQuickPick } from './completion/citation/CitationQuickPick';
import LabelCompletionProvider from './completion/reference/LabelCompletionProvider';
import EnvironmentCompletionProvider from './completion/environment/EnvironmentCompletionProvider';
import EnvironmentRenameProvider from './completion/environment/EnvironmentRenameProvider';
import { insertOrRenameEnvironment } from './completion/environment/EnvironmentCommand';
import { closeEnvironment } from './completion/environment/EnvironmentCloseCommand';
import CommandCompletionProvider from './completion/command/CommandCompletionProvider';
import { goToCorresponding } from './navigation/CorrespondingCommand';

const taskType = "fortex";

/** Serializes builds and keeps the long-running progress notification dismissible. */
class BuildManeger{
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
        // Project discovery must happen for every build because `%#main` and the
        // include graph may have changed since the previous save.
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
  // All preview commands share error handling; optional arguments select a viewer
  // for one call or turn the request into forward SyncTeX search.
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

  // Providers and commands are registered together so every disposable follows
  // the extension context lifetime.
  const citations = new CitationService();
  const labels = new LabelCompletionProvider();
  const commands = new CommandCompletionProvider();
  context.subscriptions.push(
    citations,
    labels,
    commands,
    vscode.languages.registerCompletionItemProvider(
      { language: 'latex' },
      new CitationCompletionProvider(citations),
      '{',
      ','
    ),
    vscode.languages.registerCompletionItemProvider(
      { language: 'latex' },
      labels,
      '{',
      ','
    ),
    vscode.languages.registerCompletionItemProvider(
      { language: 'latex' },
      new EnvironmentCompletionProvider(),
      '{',
      '['
    ),
    vscode.languages.registerRenameProvider(
      { language: 'latex' },
      new EnvironmentRenameProvider()
    ),
    vscode.languages.registerCompletionItemProvider(
      { language: 'latex' },
      commands,
      '\\'
    ),
    vscode.commands.registerCommand('vscode-fortex.insertCitation', async () => {
      await showCitationQuickPick(citations);
    }),
    vscode.commands.registerCommand('vscode-fortex.insertOrRenameEnvironment', async () => {
      await insertOrRenameEnvironment();
    }),
    vscode.commands.registerCommand('vscode-fortex.closeEnvironment', async () => {
      await closeEnvironment();
    }),
    vscode.commands.registerCommand('vscode-fortex.goToCorresponding', async () => {
      await goToCorresponding();
    })
  );

  // Save-triggered builds remain opt-in through compileTrigger.
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
  // VS Code disposes registered resources automatically; these two objects also
  // own pending promises and external processes that need explicit cleanup.
  buildmanager?.uninit();
  Process.killAll();
}
