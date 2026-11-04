import * as vscode from "vscode";

/** 同梱のWorkerを一度だけ読み取り，各PDFのWebviewへ直接渡す． */
export default class PDFWorkerSource {
  /** 初回のWorker本文読み取りを並行する要求で共有するPromise． */
  private pending: Promise<ArrayBuffer> | undefined;

  /**
   * PDFWorkerSourceの初期状態と所有するリソースを準備する．
   * @param extensionUri 拡張機能のインストール先を表すURI．
   * @returns 新しいインスタンス．コンストラクタから明示的な値は返さない．
   */
  public constructor(/** 拡張機能をインストールしたディレクトリのURI． */ private readonly extensionUri: vscode.Uri) {}

  /**
   * 同梱PDF.jsのWorkerを一度だけ読み取り，並行する要求で共有する．
   * 引数はない．
   * @returns Workerスクリプトのバイト列を持つArrayBuffer．読み取り失敗時は次の要求で再試行する．Promiseで返す．
   */
  public read(): Promise<ArrayBuffer> {
    if (!this.pending) {
      const uri = vscode.Uri.joinPath(this.extensionUri, "out", "vendor", "pdfjs", "pdf.worker.min.mjs");
      this.pending = Promise.resolve(vscode.workspace.fs.readFile(uri)).then(bytes => {
        // 実際のデータ長と同じ長さのArrayBufferを返す．各バイトを数値の配列へ変換せず，VS Codeで効率よく転送できる．
        return new Uint8Array(bytes).buffer;
      }).catch(error => {
        this.pending = undefined;
        throw error;
      });
    }
    return this.pending;
  }
}
