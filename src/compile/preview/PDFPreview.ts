import * as path from "path";
import * as vscode from "vscode";
import Config from "../../Config";
import LaTeXProject from "../../project/LaTeXProject";
import SumatraPDF from "./SumatraPDF";
import InternalPDFViewer from "./InternalPDFViewer";
import { assertWorkspaceTrusted } from "../../WorkspaceTrust";
import * as Workspace from '../../workspace';

export type PDFViewer = "internal" | "sumatra";

/** Routes preview and forward-search requests to the configured PDF viewer. */
export default class PDFPreview implements vscode.Disposable {
  private readonly internal: InternalPDFViewer;

  public constructor(context: vscode.ExtensionContext) {
    this.internal = new InternalPDFViewer(context);
  }

  public async viewCurrent(viewer: PDFViewer = Config.pdfViewer(), sync = false): Promise<void> {
    assertWorkspaceTrusted(sync ? "SyncTeX preview" : "PDF preview");
    // Capture the source position before opening a viewer, which can change VS
    // Code's active editor or move operating-system focus.
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

  /** Updates explicit PDFs and reports viewer messages back to LaTeXCompile. */
  public async onBuildComplete(pdfs: readonly vscode.Uri[], token?: vscode.CancellationToken,
    onProgress?: (message: string) => void, onNotice?: (message?: string) => void): Promise<void> {
    assertWorkspaceTrusted('PDF preview');
    const seen = new Set<string>();
    for (const pdf of pdfs) {
      if (seen.has(Workspace.uriKey(pdf))) { continue; }
      seen.add(Workspace.uriKey(pdf));
      if (token?.isCancellationRequested) { throw new vscode.CancellationError(); }
      onProgress?.('Updating PDF preview…');
      // LaTeXCompile owns the lifetime and interpretation of this update.
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

  /** Resolves the conventional PDF path for an explicit source-based viewer command. */
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

  /** Opens an explicit output URI, without inferring how it was produced. */
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

  private async restoreEditorFocus(viewColumn: vscode.ViewColumn | undefined): Promise<void> {
    // Use group-focus commands only. Re-showing the document would alter its
    // selection or viewport during forward search.
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
    // SumatraPDF can activate slightly after its process has started. Restore
    // the editor group once more without reopening or revealing the document.
    await new Promise<void>((resolve) => setTimeout(resolve, 350));
    await focus();
  }

  private pdfUri(mainFile: vscode.Uri): vscode.Uri {
    const main = mainFile.fsPath;
    return vscode.Uri.file(path.join(path.dirname(main), path.basename(main, path.extname(main)) + ".pdf"));
  }

  public dispose(): void {
    this.internal.dispose();
  }
}
