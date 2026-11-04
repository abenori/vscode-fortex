import * as vscode from 'vscode';
import BuildManager from './compile/BuildManager';
import LaTeXCompile from './compile/LaTeXCompile';
import Log from './log';
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
import { registerDocumentSymbols } from './structure/LaTeXDocumentSymbolProvider';
import LaTeXProject from './project/LaTeXProject';
import KpsewhichResolver from './project/KpsewhichResolver';

let buildManager: BuildManager | undefined;
let preview: PDFPreview | undefined;

/**
 * ビルドの有効期間，コマンド，編集支援サービスを拡張機能のコンテキストへ関連付ける．
 * @param context 要求の状態と通知先をまとめた実行コンテキスト．
 * @returns なし．
 */
export function activate(context: vscode.ExtensionContext) {
	//デバッグ用: vscode-fortex拡張機能の有効化を確認する．

  context.subscriptions.push(new vscode.Disposable(() => LaTeXProject.dispose()));
  KpsewhichResolver.initialize();
  context.subscriptions.push(new vscode.Disposable(() => KpsewhichResolver.dispose()));

  preview = new PDFPreview(context);
  buildManager = new BuildManager();
  const requestLaTeXBuild = (document: vscode.TextDocument, origin: 'manual' | 'save' = 'manual') => {
    if (document.languageId !== 'latex' || vscode.window.activeTextEditor?.document !== document) { return; }
    return buildManager?.requestBuild(LaTeXCompile.createBuildRequest(document.uri, preview), origin);
  };
  context.subscriptions.push(buildManager,
    vscode.commands.registerCommand('vscode-fortex.buildActions', () => buildManager?.showActions()),
    vscode.commands.registerCommand('vscode-fortex.stopBuild', () => buildManager?.stop()),
    vscode.commands.registerCommand('vscode-fortex.showBuildLog', () => Log.show()),
    vscode.commands.registerCommand('vscode-fortex.showBuildProblems', () => buildManager?.showProblems())
  );

	context.subscriptions.push(vscode.commands.registerCommand('vscode-fortex.build', async () => {
    let editor = vscode.window.activeTextEditor;
    if(editor){
      if(editor.document.languageId === "latex"){
        return requestLaTeXBuild(editor.document);
      }
    }
  }));
  // すべてのプレビュー操作でエラー処理を共有する．省略可能な引数で今回のビューアを選ぶか，SyncTeXの順検索を指定する．
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

  // プロバイダとコマンドをまとめて登録し，すべての登録を拡張機能の有効期間に合わせて解除する．
  const citations = new CitationService();
  const citationCompletion = new CitationCompletionProvider(citations);
  const labels = new LabelCompletionProvider();
  const commands = new CommandCompletionProvider();
  const environments = new EnvironmentCompletionProvider();
  const greek = new GreekCompletionController();
  const structure = new StructureService();
  context.subscriptions.push(
    citations,
    citationCompletion,
    labels,
    commands,
    environments,
    greek,
    structure,
    new StructureView(context, structure),
    registerDocumentSymbols(structure),
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
        citation: citationCompletion,
        environment: environments,
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

  // 保存時の要求も同じ管理サービスを使い，次のビルドを予約できる．
  const disp = vscode.workspace.onDidSaveTextDocument((doc) => {
    if(doc.languageId === 'latex'){
      if(Config.compileTrigger().indexOf("onSave") >= 0){
        void requestLaTeXBuild(doc, 'save');
      }
    }
  });
  context.subscriptions.push(disp);

  context.subscriptions.push(preview);
}

/**
 * VS Codeがキャンセルと子プロセスの終了を待てるようにする．
 * 引数はない．
 * @returns 処理の完了を表すPromise．値は返さない．
 */
export async function deactivate(): Promise<void> {
  await buildManager?.shutdown();
}
