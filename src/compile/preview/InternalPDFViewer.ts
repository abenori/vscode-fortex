import * as path from "path";
import * as vscode from "vscode";
import SyncTeX, { SyncTeXForwardResult } from "./SyncTeX";
import { assertWorkspaceTrusted } from "../../WorkspaceTrust";
import PDFWorkerSource from "./PDFWorkerSource";

type ViewerEntry = {
  panel: vscode.WebviewPanel;
  pdf: vscode.Uri;
  ready: boolean;
  pendingForward?: SyncTeXForwardResult;
};

/** Hosts PDF.js in one reusable webview per PDF and bridges SyncTeX messages. */
export default class InternalPDFViewer implements vscode.Disposable {
  private readonly viewers = new Map<string, ViewerEntry>();
  private readonly workerSource: PDFWorkerSource;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.workerSource = new PDFWorkerSource(context.extensionUri);
  }

  public async open(pdf: vscode.Uri, preserveFocus = false): Promise<void> {
    assertWorkspaceTrusted("Internal PDF preview");
    await vscode.workspace.fs.stat(pdf);
    const key = this.key(pdf);
    const existing = this.viewers.get(key);
    if (existing) {
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
    // The script reports readiness asynchronously. Preserve a pending forward
    // search so Ctrl+T J immediately after opening the panel is not lost.
    const entry: ViewerEntry = { panel, pdf, ready: false };
    this.viewers.set(key, entry);
    panel.onDidDispose(() => this.viewers.delete(key), undefined, this.context.subscriptions);
    panel.webview.onDidReceiveMessage(async message => {
      if (message?.type === "ready") {
        try {
          // A module worker fetching a webview resource can stall for seconds
          // before starting. Deliver our packaged code over IPC and start it
          // from a local Blob URL instead.
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
          void vscode.window.showErrorMessage(`PDF preview: ${String(error)}`);
        }
      } else if (message?.type === "inverseSearch") {
        await this.inverseSearch(entry, Number(message.page), Number(message.x), Number(message.y));
      } else if (message?.type === "error") {
        void vscode.window.showErrorMessage(`PDF preview: ${String(message.message)}`);
      }
    }, undefined, this.context.subscriptions);
    panel.webview.html = this.html(panel.webview, pdfjsRoot);
  }

  public async forwardSearch(pdf: vscode.Uri, source: vscode.Uri, line: number, column: number): Promise<void> {
    assertWorkspaceTrusted("Internal PDF preview");
    const entry = this.viewers.get(this.key(pdf));
    if (!entry) {
      throw new Error("Open the internal PDF viewer before running forward SyncTeX search.");
    }
    let result: SyncTeXForwardResult;
    // SyncTeX metadata may store either absolute input paths or paths relative to
    // the build directory, so try both forms.
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

  public async refresh(pdf: vscode.Uri): Promise<void> {
    assertWorkspaceTrusted("Internal PDF preview");
    const entry = this.viewers.get(this.key(pdf));
    if (entry?.ready) {
      await this.reload(entry);
    }
  }

  private async reload(entry: ViewerEntry): Promise<void> {
    const stat = await vscode.workspace.fs.stat(entry.pdf);
    // Passing local PDFs directly avoids the comparatively slow webview resource
    // proxy. Keep URL/range loading for large documents to limit IPC memory use.
    if (stat.size <= 16 * 1024 * 1024) {
      const bytes = await vscode.workspace.fs.readFile(entry.pdf);
      await entry.panel.webview.postMessage({
        type: "load",
        data: Buffer.from(bytes).toString("base64")
      });
    } else {
      const uri = entry.panel.webview.asWebviewUri(entry.pdf.with({ query: `v=${stat.mtime}` }));
      await entry.panel.webview.postMessage({ type: "load", url: uri.toString() });
    }
  }

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
      // CLI positions are one-based and may point past an edited document. Clamp
      // them before constructing a VS Code selection.
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

  private key(uri: vscode.Uri): string {
    const value = path.normalize(uri.fsPath);
    return process.platform === "win32" ? value.toLowerCase() : value;
  }

  private html(webview: vscode.Webview, pdfjsRoot: vscode.Uri): string {
    // Generate markup here so the CSP can authorize only this panel's nonce and
    // the packaged PDF.js resources.
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
    // load() reports initialization errors. Attach a handler immediately in case
    // worker initialization fails before the first load message arrives.
    void workerReady.promise.catch(() => {});
    let pdf;
    let scale = 1.25;
    let generation = 0;
    let pendingHighlight;
    let highlightTimer;
    let highlightStartedAt = 0;
    let pageObserver;
    const pageElements = new Map();
    const pageStates = new Map();
    const activeRenderTasks = new Set();

    function showHighlight() {
      // Recreating the marker handles zoom changes. A negative delay preserves the
      // original five-second fade deadline after a rerender.
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

    function clearHighlight() {
      pendingHighlight = undefined;
      document.querySelectorAll(".synctex-highlight").forEach(element => element.remove());
    }

    async function renderPage(number, current) {
      // Render lazily. The generation token discards work for a PDF or zoom level
      // that has already been replaced.
      const state = pageStates.get(number);
      if (!state || current !== generation) return;
      if (state.renderedScale === scale) return;
      if (state.renderPromise) return state.renderPromise;

      const requestedScale = scale;
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
          vscode.postMessage({ type: "error", message: String(error?.message || error) });
        }
      }).finally(() => {
        state.renderPromise = undefined;
      });
      return state.renderPromise;
    }

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
        // Pre-render pages near the viewport without rendering the whole document.
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

    function decodeBase64(data) {
      // Small PDFs arrive over webview messaging for speed. Decode in chunks to
      // keep temporary work bounded.
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

    async function load(source) {
      // Packaged CMaps, fonts, WASM, and ICC data are required for reliable
      // Japanese and other non-Latin PDF rendering.
      try {
        generation++;
        status.textContent = "Loading…";
        errorBox.style.display = "none";
        const worker = await workerReady.promise;
        if (documentTask) await documentTask.destroy();
        documentTask = pdfjsLib.getDocument({
          // Explicit ownership preserves the worker across document reloads.
          worker,
          ...(source.data ? { data: decodeBase64(source.data) } : { url: source.url }),
          cMapUrl: "${cMapUrl}",
          cMapPacked: true,
          standardFontDataUrl: "${standardFontDataUrl}",
          wasmUrl: "${wasmUrl}",
          iccUrl: "${iccUrl}",
          useSystemFonts: true
        });
        pdf = await documentTask.promise;
        await render();
      } catch (error) {
        errorBox.textContent = String(error && error.message ? error.message : error);
        errorBox.style.display = "block";
        status.textContent = "Could not open PDF";
        vscode.postMessage({ type: "error", message: errorBox.textContent });
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

  private nonce(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    return Array.from({ length: 32 }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join("");
  }

  public dispose(): void {
    for (const entry of this.viewers.values()) {
      entry.panel.dispose();
    }
    this.viewers.clear();
  }
}
