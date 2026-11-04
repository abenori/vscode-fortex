import * as path from "path";
import * as vscode from "vscode";
import Config from "../../Config";
import LaTeXProject from "../../project/LaTeXProject";
import SumatraPDF from "./SumatraPDF";
import InternalPDFViewer from "./InternalPDFViewer";
import { assertWorkspaceTrusted } from "../../WorkspaceTrust";
import * as Workspace from '../../workspace';

export type PDFViewer = "internal" | "sumatra";

/** プレビューと順検索の要求を，設定されたPDFビューアへ渡す． */
export default class PDFPreview implements vscode.Disposable {
  /** VS Code内のPDFビューア． */
  private readonly internal: InternalPDFViewer;

  /**
   * PDFPreviewの初期状態と所有するリソースを準備する．
   * @param context リソースの場所と拡張機能の有効期間を持つVS Codeコンテキスト．
   * @returns 新しいインスタンス．コンストラクタから明示的な値は返さない．
   */
  public constructor(context: vscode.ExtensionContext) {
    this.internal = new InternalPDFViewer(context);
  }

  /**
   * 現在のLaTeX文書に対応するPDFを指定されたビューアで開く．
   * @param viewer internalは内部ビューア，sumatraはSumatraPDF．省略時はConfig.pdfViewer()．
   * @param sync ソース位置との順検索も行う場合はtrue．省略時はfalse．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
  public async viewCurrent(viewer: PDFViewer = Config.pdfViewer(), sync = false): Promise<void> {
    assertWorkspaceTrusted(sync ? "SyncTeX preview" : "PDF preview");
    // ビューアを開くとアクティブエディタやOSのフォーカスが変わる場合があるため，その前にソース位置を記録する．
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "latex") {
      throw new Error("Open a LaTeX document before opening the PDF preview.");
    }
    const sourceDocument = editor.document;
    const sourceSelection = editor.selection;
    const sourceViewColumn = editor.viewColumn;
    const keepEditorFocus = sync && Config.syncTeXForwardSearchFocus() === "editor";
    const main = await LaTeXProject.resolveMainFile(sourceDocument.uri, { readSource: Workspace.readFileText });
    await this.open(main, viewer,
      sync ? sourceDocument.uri : undefined,
      sync ? sourceSelection.active.line + 1 : undefined,
      sync ? sourceSelection.active.character + 1 : undefined,
      keepEditorFocus);
    if (keepEditorFocus && viewer === "sumatra") {
      await this.restoreEditorFocus(sourceViewColumn);
    }
  }

  /**
   * 指定されたPDFを更新し，ビューアからのメッセージをLaTeXCompileへ通知する．
   * @param pdfs 今回のビルドで生成したPDFのURIの一覧．
   * @param token 要求のキャンセルを確認するトークン．省略可能．
   * @param onProgress 処理段階のメッセージを受け取る通知先．省略可能．
   * @param onNotice 警告などのメッセージを受け取る通知先．省略可能．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
  public async onBuildComplete(pdfs: readonly vscode.Uri[], token?: vscode.CancellationToken,
    onProgress?: (message: string) => void, onNotice?: (message?: string) => void): Promise<void> {
    assertWorkspaceTrusted('PDF preview');
    const seen = new Set<string>();
    for (const pdf of pdfs) {
      if (seen.has(Workspace.uriKey(pdf))) { continue; }
      seen.add(Workspace.uriKey(pdf));
      if (token?.isCancellationRequested) { throw new vscode.CancellationError(); }
      onProgress?.('Updating PDF preview…');
      // この更新の有効期間と通知内容の解釈はLaTeXCompileが管理する．
      const report = (message?: string) => {
        if (!token?.isCancellationRequested) { onNotice?.(message); }
      };
      try {
        if (Config.openPdfAfterBuild()) {
          await this.openPDF(pdf, Config.pdfViewer(), undefined, undefined, undefined, false, report);
        } else { await this.internal.refresh(pdf, report); }
      } catch (error) {
        if (token?.isCancellationRequested || error instanceof vscode.CancellationError) { throw error; }
        report(error instanceof Error ? error.message : String(error));
      }
    }
  }

  /**
   * ソースを起点とする明示的な表示操作に対し，標準のPDF出力先を解決する．
   * @param main ビルドの起点となるメインTeXファイルのURI．
   * @param viewer internalは内部ビューア，sumatraはSumatraPDF．
   * @param source 対象ソースのURI．
   * @param line 1始まりのソース行番号．省略可能．
   * @param column ソース内の列番号．省略可能．
   * @param preserveFocus 現在のエディタにフォーカスを残す場合はtrue．省略時はfalse．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
  private async open(
    main: vscode.Uri,
    viewer: PDFViewer,
    source?: vscode.Uri,
    line?: number,
    column?: number,
    preserveFocus = false
  ): Promise<void> {
    return this.openPDF(this.pdfUri(main), viewer, source, line, column, preserveFocus);
  }

  /**
   * 生成方法を推測せず，明示された出力URIを開く．
   * @param pdf 表示または更新するPDFのURI．
   * @param viewer internalは内部ビューア，sumatraはSumatraPDF．
   * @param source 対象ソースのURI．
   * @param line 1始まりのソース行番号．省略可能．
   * @param column ソース内の列番号．省略可能．
   * @param preserveFocus 現在のエディタにフォーカスを残す場合はtrue．省略時はfalse．
   * @param report 表示上の問題を所有者へ通知するコールバック．省略可能．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
  private async openPDF(pdf: vscode.Uri, viewer: PDFViewer, source?: vscode.Uri,
    line?: number, column?: number, preserveFocus = false, report?: (message?: string) => void): Promise<void> {
    if (viewer === "sumatra") {
      await SumatraPDF.open(pdf.fsPath, source?.fsPath, line);
    } else {
      await this.internal.open(pdf, preserveFocus, report);
      if (source && line !== undefined && column !== undefined) {
        await this.internal.forwardSearch(pdf, source, line, column);
      }
    }
  }

  /**
   * PDFを開く前に使用していたエディタ列へフォーカスを戻す．
   * @param viewColumn フォーカスを戻すエディタの表示列．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
  private async restoreEditorFocus(viewColumn: vscode.ViewColumn | undefined): Promise<void> {
    // エディタグループへフォーカスを戻す操作だけを使う．文書を再表示すると，順検索中の選択範囲や表示位置が変わってしまう．
    const focus = async () => {
      const groupCommands: Partial<Record<vscode.ViewColumn, string>> = {
        [vscode.ViewColumn.One]: "workbench.action.focusFirstEditorGroup",
        [vscode.ViewColumn.Two]: "workbench.action.focusSecondEditorGroup",
        [vscode.ViewColumn.Three]: "workbench.action.focusThirdEditorGroup",
        [vscode.ViewColumn.Four]: "workbench.action.focusFourthEditorGroup",
        [vscode.ViewColumn.Five]: "workbench.action.focusFifthEditorGroup",
        [vscode.ViewColumn.Six]: "workbench.action.focusSixthEditorGroup",
        [vscode.ViewColumn.Seven]: "workbench.action.focusSeventhEditorGroup",
        [vscode.ViewColumn.Eight]: "workbench.action.focusEighthEditorGroup",
        [vscode.ViewColumn.Nine]: "workbench.action.focusLastEditorGroup"
      };
      const groupCommand = viewColumn === undefined ? undefined : groupCommands[viewColumn];
      if (groupCommand) {
        await vscode.commands.executeCommand(groupCommand);
      }
      await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    };

    await focus();
    // SumatraPDFはプロセス起動より少し遅れてアクティブになる場合がある．文書を開き直したり再表示したりせず，もう一度エディタグループへ戻す．
    await new Promise<void>((resolve) => setTimeout(resolve, 350));
    await focus();
  }

  /**
   * メインのTeXファイルに対応する標準のPDF出力先を求める．
   * @param mainFile メインTeXファイルのURI．
   * @returns 同じディレクトリで拡張子を.pdfに変更したURI．
   */
  private pdfUri(mainFile: vscode.Uri): vscode.Uri {
    const main = mainFile.fsPath;
    return vscode.Uri.file(path.join(path.dirname(main), path.basename(main, path.extname(main)) + ".pdf"));
  }

  /**
   * 所有する監視・購読・表示などのリソースを解放する．
   * 引数はない．
   * @returns なし．
   */
  public dispose(): void {
    this.internal.dispose();
  }
}
