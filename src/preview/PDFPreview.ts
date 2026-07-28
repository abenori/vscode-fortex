import * as path from "path";
import * as vscode from "vscode";
import Config from "../Config";
import LaTeXProject from "../compile/LaTeXProject";
import SumatraPDF from "../compile/SumatraPDF";
import InternalPDFViewer from "./InternalPDFViewer";

export type PDFViewer = "internal" | "sumatra";

export default class PDFPreview implements vscode.Disposable {
  private readonly internal: InternalPDFViewer;

  public constructor(context: vscode.ExtensionContext) {
    this.internal = new InternalPDFViewer(context);
  }

  public async viewCurrent(viewer: PDFViewer = Config.pdfViewer(), sync = false): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "latex") {
      throw new Error("Open a LaTeX document before opening the PDF preview.");
    }
    const project = new LaTeXProject(await LaTeXProject.generate_project(editor.document.uri, true));
    await this.open(project, viewer,
      sync ? editor.document.uri : undefined,
      sync ? editor.selection.active.line + 1 : undefined,
      sync ? editor.selection.active.character + 1 : undefined);
  }

  public async onBuildComplete(project: LaTeXProject): Promise<void> {
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
    column?: number
  ): Promise<void> {
    const pdf = this.pdfUri(project);
    if (viewer === "sumatra") {
      await SumatraPDF.open(pdf.fsPath, source?.fsPath, line);
    } else {
      await this.internal.open(pdf);
      if (source && line !== undefined && column !== undefined) {
        await this.internal.forwardSearch(pdf, source, line, column);
      }
    }
  }

  private pdfUri(project: LaTeXProject): vscode.Uri {
    const main = project.mainfile.fsPath;
    return vscode.Uri.file(path.join(path.dirname(main), path.basename(main, path.extname(main)) + ".pdf"));
  }

  public dispose(): void {
    this.internal.dispose();
  }
}
