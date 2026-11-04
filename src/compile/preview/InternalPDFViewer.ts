import * as path from "path";
import * as vscode from "vscode";
import SyncTeX, { SyncTeXForwardResult } from "./SyncTeX";
import { assertWorkspaceTrusted } from "../../WorkspaceTrust";
import PDFWorkerSource from "./PDFWorkerSource";
import * as Workspace from '../../workspace';

type ViewerEntry = {
  /** PDFを表示するWebviewパネル． */
  panel: vscode.WebviewPanel;
  /** 表示しているPDFのURI． */
  pdf: vscode.Uri;
  /** Webviewから初期化完了の通知を受信した場合はtrue． */
  ready: boolean;
  /** Webviewの準備が整った後に表示する順検索位置． */
  pendingForward?: SyncTeXForwardResult;
  /** PDFの読み込みごとに進め，古いブラウザ応答を無視する要求番号． */
  loadId: number;
  /** ビューアの問題を現在のビルド所有者へ通知する関数． */
  report?: (message?: string) => void;
};

/** PDFごとに再利用できるWebviewでPDF.jsを動かし，SyncTeXのメッセージを仲介する． */
export default class InternalPDFViewer implements vscode.Disposable {
  /** PDFの識別キーから開いている内部ビューアへの表． */
  private readonly viewers = new Map<string, ViewerEntry>();
  /** 同梱PDF.jsのWorker本文を読み取るサービス． */
  private readonly workerSource: PDFWorkerSource;

  /**
   * InternalPDFViewerの初期状態と所有するリソースを準備する．
   * @param context リソースの場所と拡張機能の有効期間を持つVS Codeコンテキスト．
   * @returns 新しいインスタンス．コンストラクタから明示的な値は返さない．
   */
  public constructor(/** リソースの場所と拡張機能の有効期間を持つVS Codeコンテキスト． */ private readonly context: vscode.ExtensionContext) {
    this.workerSource = new PDFWorkerSource(context.extensionUri);
  }

  /**
   * ビューアを開き，自動更新の失敗を要求元のビルドに関連付ける．
   * @param pdf 表示または更新するPDFのURI．
   * @param preserveFocus 現在のエディタにフォーカスを残す場合はtrue．省略時はfalse．
   * @param report 表示上の問題を所有者へ通知するコールバック．省略可能．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
  public async open(pdf: vscode.Uri, preserveFocus = false, report?: (message?: string) => void): Promise<void> {
    assertWorkspaceTrusted("Internal PDF preview");
    await vscode.workspace.fs.stat(pdf);
    const key = Workspace.uriKey(pdf);
    const existing = this.viewers.get(key);
    if (existing) {
      existing.report = report;
      existing.panel.reveal(vscode.ViewColumn.Beside, preserveFocus);
      if (existing.ready) {
        await this.reload(existing);
      }
      return;
    }

    const pdfjsRoot = vscode.Uri.joinPath(this.context.extensionUri, "out", "vendor", "pdfjs");
    const panel = vscode.window.createWebviewPanel(
      "vscode-fortex.pdfPreview",
      `${path.basename(pdf.fsPath)} — PDF Preview`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.dirname(pdf.fsPath)), pdfjsRoot]
      }
    );
    // スクリプトの準備完了は非同期で通知される．パネルを開いた直後のCtrl+T T Jを失わないよう，順検索の要求を保留する．
    const entry: ViewerEntry = { panel, pdf, ready: false, loadId: 0, report };
    this.viewers.set(key, entry);
    panel.onDidDispose(() => this.viewers.delete(key), undefined, this.context.subscriptions);
    panel.webview.onDidReceiveMessage(async message => {
      if (message?.type === "ready") {
        try {
          // Webviewのリソースを取得するモジュールWorkerは起動まで数秒止まることがある．同梱コードをプロセス間通信で渡し，ローカルのBlob URLから起動する．
          const data = await this.workerSource.read();
          if (!await panel.webview.postMessage({ type: "initializeWorker", data })) {
            return;
          }
          entry.ready = true;
          await this.reload(entry);
          if (entry.pendingForward) {
            await entry.panel.webview.postMessage({ type: "forwardSearch", result: entry.pendingForward });
          }
        } catch (error) {
          this.reportIssue(entry, String(error));
        }
      } else if (message?.type === "inverseSearch") {
        await this.inverseSearch(entry, Number(message.page), Number(message.x), Number(message.y));
      } else if ((message?.type === 'error' || message?.type === 'loaded') && message.requestId === entry.loadId) {
        this.reportIssue(entry, message.type === 'error' ? String(message.message) : undefined);
      }
    }, undefined, this.context.subscriptions);
    panel.webview.html = this.html(panel.webview, pdfjsRoot);
  }

  /**
   * ソース位置に対応するPDF上の位置を内部ビューアに表示する．
   * @param pdf 表示または更新するPDFのURI．
   * @param source 対象ソースのURI．
   * @param line 1始まりのソース行番号．
   * @param column ソース内の列番号．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
  public async forwardSearch(pdf: vscode.Uri, source: vscode.Uri, line: number, column: number): Promise<void> {
    assertWorkspaceTrusted("Internal PDF preview");
    const entry = this.viewers.get(Workspace.uriKey(pdf));
    if (!entry) {
      throw new Error("Open the internal PDF viewer before running forward SyncTeX search.");
    }
    let result: SyncTeXForwardResult;
    // SyncTeXの入力パスは絶対パスの場合とビルドディレクトリからの相対パスの場合があるため，両方を試す．
    try {
      result = await SyncTeX.forward(pdf.fsPath, source.fsPath, line, column);
    } catch (absolutePathError) {
      const relativeSource = path.relative(path.dirname(pdf.fsPath), source.fsPath);
      if (path.isAbsolute(relativeSource)) {
        throw absolutePathError;
      }
      result = await SyncTeX.forward(pdf.fsPath, relativeSource, line, column);
    }
    entry.pendingForward = result;
    if (entry.ready) {
      await entry.panel.webview.postMessage({ type: "forwardSearch", result });
    }
  }

  /**
   * 既存のパネルを更新し，その後の非同期通知を受け取る所有者を置き換える．
   * @param pdf 表示または更新するPDFのURI．
   * @param report 表示上の問題を所有者へ通知するコールバック．省略可能．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
  public async refresh(pdf: vscode.Uri, report?: (message?: string) => void): Promise<void> {
    assertWorkspaceTrusted("Internal PDF preview");
    const entry = this.viewers.get(Workspace.uriKey(pdf));
    if (entry) {
      entry.report = report;
      if (entry.ready) { await this.reload(entry); }
    }
  }

  /**
   * 読み込みごとに識別番号を付け，遅れて届いたブラウザの応答を新しい文書に適用しないようにする．
   * @param entry PDFのURI，Webviewパネル，読み込み番号，および表示準備の状態．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
  private async reload(entry: ViewerEntry): Promise<void> {
    const requestId = ++entry.loadId;
    try {
      const stat = await vscode.workspace.fs.stat(entry.pdf);
      // 大きな文書はURLと範囲指定による読み込みを使い，プロセス間通信のメモリ使用量を抑える．
      if (requestId !== entry.loadId) { return; }
      if (stat.size <= 16 * 1024 * 1024) {
        const bytes = await vscode.workspace.fs.readFile(entry.pdf);
        if (requestId !== entry.loadId) { return; }
        await entry.panel.webview.postMessage({
          type: "load", requestId,
          data: Buffer.from(bytes).toString("base64")
        });
      } else {
        const uri = entry.panel.webview.asWebviewUri(entry.pdf.with({ query: `v=${stat.mtime}` }));
        await entry.panel.webview.postMessage({ type: "load", requestId, url: uri.toString() });
      }
    } catch (error) {
      if (requestId !== entry.loadId) { return; }
      if (entry.report) { entry.report(error instanceof Error ? error.message : String(error)); }
      else { throw error; }
    }
  }

  /**
   * ビルドに属する通知は管理側へ渡し，利用者が直接実行したビューア操作とは分けて扱う．
   * @param entry PDFのURI，Webviewパネル，読み込み番号，および表示準備の状態．
   * @param message 表示または記録するメッセージ．省略可能．
   * @returns なし．
   */
  private reportIssue(entry: ViewerEntry, message?: string): void {
    if (entry.report) { entry.report(message); }
    else if (message !== undefined) { void vscode.window.showErrorMessage(`PDF preview: ${message}`); }
  }

  /**
   * PDF上のクリック位置をソースファイルの行・列へ変換して開く．
   * @param entry PDFのURI，Webviewパネル，読み込み番号，および表示準備の状態．
   * @param page 1始まりのPDFページ番号．
   * @param x PDFページ上の横座標．
   * @param y PDFページ上の縦座標．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
  private async inverseSearch(entry: ViewerEntry, page: number, x: number, y: number): Promise<void> {
    if (![page, x, y].every(Number.isFinite)) {
      return;
    }
    try {
      const result = await SyncTeX.edit(entry.pdf.fsPath, page, x, y);
      const inputPath = path.isAbsolute(result.input)
        ? result.input
        : path.resolve(path.dirname(entry.pdf.fsPath), result.input);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(inputPath));
      // 外部コマンドの位置は1始まりで，編集後の文書範囲を超える場合がある．VS Codeの選択範囲を作る前に補正する．
      const line = Math.max(0, Math.min(document.lineCount - 1, result.line - 1));
      const maxColumn = document.lineAt(line).text.length;
      const column = result.column < 0 ? 0 : Math.min(maxColumn, result.column);
      const position = new vscode.Position(line, column);
      await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false,
        preview: false,
        selection: new vscode.Range(position, position)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showWarningMessage(`SyncTeX reverse search failed: ${message}`);
    }
  }

  /**
   * テーマに対応するPDFビューアのHTMLと，要求番号付きの拡張機能へのメッセージを作る．
   * @param webview HTMLの表示先となるVS CodeのWebview．
   * @param pdfjsRoot 同梱されたPDF.jsリソースの基点URI．
   * @returns PDF.jsと拡張機能の間でメッセージを交換するビューアのHTML全文．
   */
  private html(webview: vscode.Webview, pdfjsRoot: vscode.Uri): string {
    // このパネルのnonceと同梱PDF.jsリソースだけをCSPで許可できるよう，ここでHTMLを生成する．
    const nonce = this.nonce();
    const pdfjs = webview.asWebviewUri(vscode.Uri.joinPath(pdfjsRoot, "pdf.min.mjs"));
    const cMapUrl = webview.asWebviewUri(vscode.Uri.joinPath(pdfjsRoot, "cmaps")).toString() + "/";
    const standardFontDataUrl = webview.asWebviewUri(vscode.Uri.joinPath(pdfjsRoot, "standard_fonts")).toString() + "/";
    const wasmUrl = webview.asWebviewUri(vscode.Uri.joinPath(pdfjsRoot, "wasm")).toString() + "/";
    const iccUrl = webview.asWebviewUri(vscode.Uri.joinPath(pdfjsRoot, "iccs")).toString() + "/";
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; font-src ${webview.cspSource} data: blob:; connect-src ${webview.cspSource} data: blob:; script-src 'nonce-${nonce}' ${webview.cspSource} blob:; style-src 'nonce-${nonce}'; worker-src blob:;">
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    #toolbar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 6px; height: 38px; padding: 0 10px; background: var(--vscode-editorWidget-background); border-bottom: 1px solid var(--vscode-editorWidget-border); }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 2px; padding: 4px 10px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    #status { margin-left: 6px; color: var(--vscode-descriptionForeground); }
    #pages { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 16px; }
    .page { position: relative; flex: none; background: white; box-shadow: 0 2px 10px rgba(0,0,0,.35); }
    canvas { display: block; max-width: none; }
    .synctex-highlight { position: absolute; z-index: 1; pointer-events: none; box-sizing: border-box; border: 2px solid var(--vscode-editorWarning-foreground); background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 24%, transparent); animation: synctex-highlight-fade 5s ease-in-out forwards; }
    @keyframes synctex-highlight-fade { 0%, 40% { opacity: 1; } 100% { opacity: 0; } }
    #error { display: none; padding: 24px; color: var(--vscode-errorForeground); white-space: pre-wrap; }
  </style>
</head>
<body>
  <div id="toolbar">
    <button id="zoomOut" title="Zoom out">−</button>
    <button id="zoomIn" title="Zoom in">＋</button>
    <button id="fit" title="Fit page width">Fit width</button>
    <span id="status">Waiting for PDF… · Double-click the PDF to open its source</span>
  </div>
  <div id="error"></div>
  <main id="pages"></main>
  <script type="module" nonce="${nonce}">
    import * as pdfjsLib from "${pdfjs}";
    const vscode = acquireVsCodeApi();
    const pages = document.getElementById("pages");
    const status = document.getElementById("status");
    const errorBox = document.getElementById("error");
    let documentTask;
    let pdfWorker;
    let workerUrl;
    const workerReady = Promise.withResolvers();
    // 初期化エラーはload()で通知する．最初の読み込み要求より前にWorkerの初期化が失敗する場合に備え，直ちにエラー処理を登録する．
    void workerReady.promise.catch(() => {});
    let pdf;
    let pdfRequestId;
    let scale = 1.25;
    let generation = 0;
    let pendingHighlight;
    let highlightTimer;
    let highlightStartedAt = 0;
    let pageObserver;
    const pageElements = new Map();
    /**
     * ページ番号ごとに保持する遅延描画の状態．
     * wrapper: ページの寸法と位置を持つDOM要素．
     * page: 取得済みのPDF.jsページ．未取得ならundefined．
     * canvas: ページを描画するCanvas．描画前は未設定．
     * renderedScale: 描画を完了した倍率．未描画なら未設定．
     * renderPromise: 実行中の描画．同じページへの要求で共有し，完了後に解除する．
     */
    const pageStates = new Map();
    const activeRenderTasks = new Set();

    /**
     * 現在の倍率で順検索位置の矩形を表示し，その位置へスクロールする．
     * 引数はない．
     * @returns なし．
     */
    function showHighlight() {
      // 倍率の変更に合わせてマーカーを作り直す．負の遅延を設定し，再描画後も最初の表示から5秒で消える期限を保つ．
      document.querySelectorAll(".synctex-highlight").forEach(element => element.remove());
      if (!pendingHighlight) return;
      const wrapper = pageElements.get(pendingHighlight.page);
      if (!wrapper) return;
      const height = Math.max(4, pendingHighlight.height * scale);
      const highlight = document.createElement("div");
      highlight.className = "synctex-highlight";
      highlight.style.left = Math.max(0, pendingHighlight.h * scale) + "px";
      highlight.style.top = Math.max(0, (pendingHighlight.v - pendingHighlight.height) * scale) + "px";
      highlight.style.width = Math.max(6, pendingHighlight.width * scale) + "px";
      highlight.style.height = height + "px";
      highlight.style.animationDelay = -Math.max(0, performance.now() - highlightStartedAt) + "ms";
      wrapper.appendChild(highlight);
      highlight.scrollIntoView({ block: "center", inline: "nearest" });
    }

    /**
     * 順検索位置と表示中の矩形を解除する．
     * 引数はない．
     * @returns なし．
     */
    function clearHighlight() {
      pendingHighlight = undefined;
      document.querySelectorAll(".synctex-highlight").forEach(element => element.remove());
    }

    /**
     * 1ページを描画し，この描画に対応するPDF読み込み要求へ失敗を通知する．
     * @param number 描画する1始まりのPDFページ番号．
     * @param current この描画を開始した世代番号．PDFや倍率の更新後は結果を破棄する．
     * @returns 描画または既存の描画待ちが完了するPromise．対象が古い場合は描画しない．
     */
    async function renderPage(number, current) {
      // 必要になったページだけを描画する．PDFや倍率がすでに変わっていれば，世代番号で古い処理を破棄する．
      const state = pageStates.get(number);
      if (!state || current !== generation) return;
      if (state.renderedScale === scale) return;
      if (state.renderPromise) return state.renderPromise;

      const requestedScale = scale;
      const requestId = pdfRequestId;
      state.renderPromise = (async () => {
        const page = state.page || await pdf.getPage(number);
        if (current !== generation) return;
        state.page = page;
        if (!state.canvas) {
          state.canvas = document.createElement("canvas");
          state.wrapper.appendChild(state.canvas);
        }
        const viewport = page.getViewport({ scale: requestedScale });
        const ratio = window.devicePixelRatio || 1;
        state.wrapper.style.width = Math.floor(viewport.width) + "px";
        state.wrapper.style.height = Math.floor(viewport.height) + "px";
        state.canvas.width = Math.floor(viewport.width * ratio);
        state.canvas.height = Math.floor(viewport.height * ratio);
        state.canvas.style.width = Math.floor(viewport.width) + "px";
        state.canvas.style.height = Math.floor(viewport.height) + "px";
        const task = page.render({
          canvasContext: state.canvas.getContext("2d"),
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0]
        });
        activeRenderTasks.add(task);
        try {
          await task.promise;
          if (current === generation) state.renderedScale = requestedScale;
        } finally {
          activeRenderTasks.delete(task);
        }
      })().catch(error => {
        if (current === generation && error?.name !== "RenderingCancelledException") {
          vscode.postMessage({ type: "error", message: String(error?.message || error), requestId });
        }
      }).finally(() => {
        state.renderPromise = undefined;
      });
      return state.renderPromise;
    }

    /**
     * 現在の倍率に合わせてページ枠と遅延描画の監視を作り直す．
     * 引数はない．
     * @returns ページ枠と監視の準備が完了するPromise．各ページの描画完了までは待たない．
     */
    async function render() {
      if (!pdf) return;
      for (const task of activeRenderTasks) task.cancel();
      activeRenderTasks.clear();
      pageObserver?.disconnect();
      const current = ++generation;
      const oldHeight = Math.max(1, document.documentElement.scrollHeight - innerHeight);
      const scrollRatio = scrollY / oldHeight;
      pages.replaceChildren();
      pageElements.clear();
      pageStates.clear();
      status.textContent = pdf.numPages + " pages · " + Math.round(scale * 100) + "%";

      const firstPage = await pdf.getPage(1);
      if (current !== generation) return;
      const defaultViewport = firstPage.getViewport({ scale });
      pageObserver = new IntersectionObserver(entries => {
        // 文書全体を描画せず，表示範囲の近くのページを先に描画する．
        for (const entry of entries) {
          if (entry.isIntersecting) {
            void renderPage(Number(entry.target.dataset.page), current);
          }
        }
      }, { rootMargin: "1200px 0px" });

      for (let number = 1; number <= pdf.numPages; number++) {
        const wrapper = document.createElement("div");
        wrapper.className = "page";
        wrapper.dataset.page = String(number);
        wrapper.style.width = Math.floor(defaultViewport.width) + "px";
        wrapper.style.height = Math.floor(defaultViewport.height) + "px";
        wrapper.addEventListener("dblclick", event => {
          const rect = wrapper.getBoundingClientRect();
          vscode.postMessage({
            type: "inverseSearch",
            page: number,
            x: Math.max(0, (event.clientX - rect.left) / scale),
            y: Math.max(0, (event.clientY - rect.top) / scale)
          });
        });
        pageElements.set(number, wrapper);
        pageStates.set(number, { wrapper, page: number === 1 ? firstPage : undefined });
        pages.appendChild(wrapper);
        pageObserver.observe(wrapper);
      }

      requestAnimationFrame(() => {
        if (pendingHighlight) {
          showHighlight();
          void renderPage(pendingHighlight.page, current);
        } else {
          scrollTo(0, scrollRatio * Math.max(1, document.documentElement.scrollHeight - innerHeight));
          void renderPage(1, current);
        }
      });
    }

    /**
     * 拡張機能から受信したBase64のPDFデータをバイト列へ戻す．
     * @param data Base64で符号化されたPDFの内容．
     * @returns 復号したPDFデータを持つUint8Array．
     */
    function decodeBase64(data) {
      // 小さなPDFは高速化のためWebviewのメッセージで受け取る．一時的な処理量を抑えるため分割して復号する．
      const binary = atob(data);
      const bytes = new Uint8Array(binary.length);
      for (let offset = 0; offset < binary.length; offset += 65536) {
        const end = Math.min(binary.length, offset + 65536);
        for (let index = offset; index < end; index++) {
          bytes[index] = binary.charCodeAt(index);
        }
      }
      return bytes;
    }

    let loadSequence = 0;
    /**
     * 読み込みに成功したPDFを要求に関連付け，新しい要求に置き換えられた読み込みを破棄する．
     * @param source 読み込み要求．requestIdは要求番号，dataは任意のBase64本文，urlは本文がない場合の取得先．
     * @returns 読み込みと初期表示の準備が完了するPromise．失敗は画面と拡張機能へ通知する．
     */
    async function load(source) {
      const request = ++loadSequence;
      // 日本語などの非ラテン文字を含むPDFを正しく描画するため，同梱のCMap・フォント・WASM・ICCデータを使用する．
      try {
        generation++;
        status.textContent = "Loading…";
        errorBox.style.display = "none";
        const worker = await workerReady.promise;
        if (request !== loadSequence) return;
        if (documentTask) await documentTask.destroy();
        if (request !== loadSequence) return;
        documentTask = pdfjsLib.getDocument({
          // Workerの所有者を明示し，文書の再読み込み時にもWorkerを保持する．
          worker,
          ...(source.data ? { data: decodeBase64(source.data) } : { url: source.url }),
          cMapUrl: "${cMapUrl}",
          cMapPacked: true,
          standardFontDataUrl: "${standardFontDataUrl}",
          wasmUrl: "${wasmUrl}",
          iccUrl: "${iccUrl}",
          // BlobのWorkerからはWebviewのリソースを安定して取得できないため，CMapとフォントをPDF.jsのメインスレッド側で取得する．
          // CMapの取得に失敗すると，日本語が通知なしにErrorFontへ置き換わる．この設定ではICCを使わない色変換にも切り替わる．
          useWorkerFetch: false,
          useSystemFonts: true
        });
        const loaded = await documentTask.promise;
        if (request !== loadSequence) return;
        pdf = loaded;
        pdfRequestId = source.requestId;
        await render();
        if (request !== loadSequence) return;
        vscode.postMessage({ type: 'loaded', requestId: source.requestId });
      } catch (error) {
        if (request !== loadSequence) return;
        errorBox.textContent = String(error && error.message ? error.message : error);
        errorBox.style.display = "block";
        status.textContent = "Could not open PDF";
        vscode.postMessage({ type: "error", message: errorBox.textContent, requestId: source.requestId });
      }
    }

    document.getElementById("zoomIn").addEventListener("click", () => { scale = Math.min(4, scale + .15); void render(); });
    document.getElementById("zoomOut").addEventListener("click", () => { scale = Math.max(.25, scale - .15); void render(); });
    document.getElementById("fit").addEventListener("click", async () => {
      if (!pdf) return;
      const page = await pdf.getPage(1);
      scale = Math.max(.25, Math.min(4, (innerWidth - 48) / page.getViewport({ scale: 1 }).width));
      void render();
    });
    addEventListener("message", event => {
      if (event.data?.type === "initializeWorker") {
        if (pdfWorker) return;
        try {
          workerUrl = URL.createObjectURL(new Blob([event.data.data], { type: "text/javascript" }));
          pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
          pdfWorker = new pdfjsLib.PDFWorker();
          workerReady.resolve(pdfWorker.promise.then(() => pdfWorker));
        } catch (error) {
          workerReady.reject(error);
        }
      } else if (event.data?.type === "load") {
        void load(event.data);
      } else if (event.data?.type === "forwardSearch") {
        clearTimeout(highlightTimer);
        pendingHighlight = event.data.result;
        highlightStartedAt = performance.now();
        showHighlight();
        void renderPage(pendingHighlight.page, generation);
        highlightTimer = setTimeout(clearHighlight, 5000);
      }
    });
    addEventListener("pagehide", () => {
      pdfWorker?.destroy();
      if (workerUrl) URL.revokeObjectURL(workerUrl);
    });
    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }

  /**
   * Webview内のスクリプト実行を許可するランダムな識別文字列を作る．
   * 引数はない．
   * @returns Content Security Policyのnonceに使用する文字列．
   */
  private nonce(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    return Array.from({ length: 32 }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join("");
  }

  /**
   * 所有する監視・購読・表示などのリソースを解放する．
   * 引数はない．
   * @returns なし．
   */
  public dispose(): void {
    for (const entry of this.viewers.values()) {
      entry.panel.dispose();
    }
    this.viewers.clear();
  }
}
