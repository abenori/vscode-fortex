import * as path from "path";
import * as vscode from "vscode";
import Config from "../../Config";
import LaTeXProject from "../LaTeXProject";
import SumatraPDF from "./SumatraPDF";
import InternalPDFViewer from "./InternalPDFViewer";

export type PDFViewer = "internal" | "sumatra";

/** Routes preview and forward-search requests to the configured PDF viewer. */
export default class PDFPreview implements vscode.Disposable {
  private readonly internal: InternalPDFViewer;

  public constructor(context: vscode.ExtensionContext) {
    this.internal = new InternalPDFViewer(context);
  }

  public async viewCurrent(viewer: PDFViewer = Config.pdfViewer(), sync = false): Promise<void> {
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
    const project = new LaTeXProject(await LaTeXProject.generate_project(sourceDocument.uri, true));
    await this.open(project, viewer,
      sync ? sourceDocument.uri : undefined,
      sync ? sourceSelection.active.line + 1 : undefined,
      sync ? sourceSelection.active.character + 1 : undefined,
      keepEditorFocus);
    if (keepEditorFocus && viewer === "sumatra") {
      await this.restoreEditorFocus(sourceViewColumn);
    }
  }

  public async onBuildComplete(project: LaTeXProject): Promise<void> {
    // Refresh an existing internal panel even when automatic opening is disabled,
    // so an already visible preview never remains on an older build.
    if (Config.openPdfAfterBuild()) {
      await this.open(project, Config.pdfViewer());
    } else {
      await this.internal.refresh(this.pdfUri(project));
    }
  }

  private async open(
    project: LaTeXProject,
    viewer: PDFViewer,
    source?: vscode.Uri,
    line?: number,
    column?: number,
    preserveFocus = false
  ): Promise<void> {
    const pdf = this.pdfUri(project);
    if (viewer === "sumatra") {
      await SumatraPDF.open(pdf.fsPath, source?.fsPath, line);
    } else {
      await this.internal.open(pdf, preserveFocus);
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

  private pdfUri(project: LaTeXProject): vscode.Uri {
    const main = project.mainfile.fsPath;
    return vscode.Uri.file(path.join(path.dirname(main), path.basename(main, path.extname(main)) + ".pdf"));
  }

  public dispose(): void {
    this.internal.dispose();
  }
}
