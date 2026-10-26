import * as vscode from 'vscode';
import BuildManager from './compile/BuildManager';
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
import LaTeXCompletionProvider from './completion/LaTeXCompletionProvider';
import { goToCorresponding } from './navigation/CorrespondingCommand';
import GreekCompletionController from './completion/greek/GreekCompletionController';
import TexdocService from './documentation/TexdocService';
import { openDocumentation } from './documentation/DocumentationCommand';
import StructureService from './structure/StructureService';
import StructureView from './structure/StructureView';
import LaTeXDocumentSymbolProvider from './structure/LaTeXDocumentSymbolProvider';
import LaTeXProject from './project/LaTeXProject';

let buildManager: BuildManager | undefined;
let preview: PDFPreview | undefined;

export function activate(context: vscode.ExtensionContext) {
	//Log.debug_log("Activate vscode-fortex extension");

  context.subscriptions.push(new vscode.Disposable(() => LaTeXProject.dispose()));

  preview = new PDFPreview(context);
  buildManager = new BuildManager(preview);

	context.subscriptions.push(vscode.commands.registerCommand('vscode-fortex.build', async () => {
    let editor = vscode.window.activeTextEditor;
    if(editor){
      if(editor.document.languageId === "latex"){
        void buildManager?.build(editor.document);
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

  const documentation = new TexdocService();
  context.subscriptions.push(
    documentation,
    vscode.commands.registerCommand('vscode-fortex.openDocumentation', async () => {
      try {
        await openDocumentation(documentation);
      } catch (error) {
        if (error instanceof vscode.CancellationError) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        Log.error(`Unable to open TeX documentation: ${message}`);
        void vscode.window.showErrorMessage(`Unable to open TeX documentation: ${message}`);
      }
    })
  );

  // Providers and commands are registered together so every disposable follows
  // the extension context lifetime.
  const citations = new CitationService();
  const labels = new LabelCompletionProvider();
  const commands = new CommandCompletionProvider();
  const greek = new GreekCompletionController();
  const structure = new StructureService();
  context.subscriptions.push(
    citations,
    labels,
    commands,
    greek,
    structure,
    new StructureView(context, structure),
    vscode.languages.registerDocumentSymbolProvider(
      { language: 'latex' }, new LaTeXDocumentSymbolProvider(), { label: 'Fortex' }
    ),
    vscode.commands.registerCommand('vscode-fortex.greekCompletion.start', () => greek.start()),
    vscode.commands.registerCommand('vscode-fortex.greekCompletion.input', (args) => greek.input(args)),
    vscode.commands.registerCommand('vscode-fortex.greekCompletion.commit', (args) => greek.commit(args)),
    vscode.commands.registerCommand('vscode-fortex.greekCompletion.cancel', () => greek.cancel()),
    vscode.commands.registerCommand('vscode-fortex.greekCompletion.backspace', () => greek.backspace()),
    vscode.commands.registerCommand('vscode-fortex.greekCompletion.showCandidates', () => greek.showCandidates()),
    vscode.languages.registerCompletionItemProvider(
      { language: 'latex' },
      new LaTeXCompletionProvider({
        reference: labels,
        citation: new CitationCompletionProvider(citations),
        environment: new EnvironmentCompletionProvider(),
        command: commands
      }),
      '{',
      ',',
      '[',
      '\\'
    ),
    vscode.languages.registerRenameProvider(
      { language: 'latex' },
      new EnvironmentRenameProvider()
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
        void buildManager?.build(doc);
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
  buildManager?.uninit();
  Process.killAll();
}
