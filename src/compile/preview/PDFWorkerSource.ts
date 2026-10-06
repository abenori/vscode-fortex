import * as vscode from "vscode";

/** Reads the packaged worker once, for direct delivery to each PDF webview. */
export default class PDFWorkerSource {
  private pending: Promise<ArrayBuffer> | undefined;

  public constructor(private readonly extensionUri: vscode.Uri) {}

  public read(): Promise<ArrayBuffer> {
    if (!this.pending) {
      const uri = vscode.Uri.joinPath(this.extensionUri, "out", "vendor", "pdfjs", "pdf.worker.min.mjs");
      this.pending = Promise.resolve(vscode.workspace.fs.readFile(uri)).then(bytes => {
        // Return an exact-sized ArrayBuffer: VS Code transfers it efficiently,
        // without serializing the file as a large array of individual numbers.
        return new Uint8Array(bytes).buffer;
      }).catch(error => {
        this.pending = undefined;
        throw error;
      });
    }
    return this.pending;
  }
}
