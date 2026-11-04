import * as vscode from 'vscode';
import * as path from 'path';
import * as Workspace from '../workspace';

export interface CompletionQuery {
  /** 変更可能な検索文字列だけの範囲．コマンドや開き区切りは含めない． */
  start: number;
  /** 検索文字列だけの終端UTF-16位置．この位置は含まない． */
  end: number;
  /** 同じ候補の読み込みを共有できる補完種別などの識別文字列． */
  scope: string;
}

interface ActiveSession<T> extends CompletionQuery {
  /** 対象の開いている文書． */
  document: vscode.TextDocument;
  /** ソースを読み取った時点または投影を計算した時点の文書版番号． */
  version: number;
  /** 所有する処理へキャンセルを通知するトークンソース． */
  cancellation: vscode.CancellationTokenSource;
  /** 処理のキャンセル状態を確認するトークン． */
  token: vscode.CancellationToken;
  /** 共有結果の完了を待っている要求の数． */
  waiters: number;
  /** 要求間で共有する補完候補の読み込み結果． */
  value: Promise<T>;
  /** 依存するファイルやディレクトリの監視ハンドルの対応表． */
  watches: Map<string, vscode.Disposable>;
  /** この処理が参照したファイルの識別キーの集合． */
  dependencies: Set<string>;
}

/** 1つの補完用の検索文字列を編集中の間だけ，候補を保持する． */
export default class CompletionSession<T> implements vscode.Disposable {
  /** 現在実行中または共有中のセッション． */
  private active?: ActiveSession<T>;
  /** 所有するリソースを解放し，新しい要求を受け付けない場合はtrue． */
  private disposed = false;
  /** 所有者の終了時に解除するイベント購読． */
  private readonly subscriptions: vscode.Disposable[];

  /**
   * CompletionSessionの初期状態と所有するリソースを準備する．
   * 引数はない．
   * @returns 新しいインスタンス．コンストラクタから明示的な値は返さない．
   */
  constructor() {
    this.subscriptions = [
      vscode.workspace.onDidChangeTextDocument(event => this.changed(event)),
      vscode.workspace.onDidCloseTextDocument(document => {
        if (this.active && (this.active.document === document || this.active.scope === 'project')) { this.invalidate(); }
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('vscode-fortex.completion')
          || event.affectsConfiguration('vscode-fortex.mainFileOrder')
          || event.affectsConfiguration('vscode-fortex.kpsewhich.path')) { this.invalidate(); }
      }),
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (this.active && editor?.document !== this.active.document) { this.invalidate(); }
      }),
      vscode.window.onDidChangeTextEditorSelection(event => {
        const active = this.active;
        if (!active || event.textEditor.document !== active.document) { return; }
        if (event.selections.length !== 1 || !event.selections[0].isEmpty
          || event.textEditor.document.offsetAt(event.selections[0].active) !== active.end) { this.invalidate(); }
      })
    ];
  }

  /**
   * 検索文字列の範囲が変化する間，同じ入力元に対する候補の読み込みを共有する．
   * @param document 要求の対象となる編集中の文書．
   * @param query 入力中の検索文字列の開始・終了位置と，候補を共有できる補完範囲．
   * @param token 要求のキャンセルを確認するトークン．
   * @param load キャンセル状態を受け取り，共有する補完候補を読み込む処理．
   * @returns 読み込んだ候補データ．呼び出し元または共有要求のキャンセル時はundefined．Promiseで返す．
   */
  async get(
    document: vscode.TextDocument,
    query: CompletionQuery,
    token: vscode.CancellationToken,
    load: (token: vscode.CancellationToken) => T | Promise<T>
  ): Promise<T | undefined> {
    if (this.disposed || token.isCancellationRequested) { return undefined; }
    const requestedVersion = document.version;
    let active = this.active;
    if (!active || active.document !== document || active.version !== document.version
      || active.start !== query.start || active.end !== query.end || active.scope !== query.scope) {
      this.invalidate();
      const cancellation = new vscode.CancellationTokenSource();
      const sessionToken = cancellation.token;
      active = {
        ...query, document, version: document.version, cancellation, token: sessionToken, waiters: 0,
        watches: new Map(), dependencies: new Set(), value: Promise.resolve().then(() => load(sessionToken))
      };
      this.active = active;
      if (query.scope === 'project') {
        // 新しい候補ファイルは，検出済みの依存関係に加わる前に作成される場合がある．
        const watcher = vscode.workspace.createFileSystemWatcher('**/*.tex');
        const invalidate = () => { if (this.active === active) { this.invalidate(); } };
        active.watches.set('workspace', vscode.Disposable.from(watcher,
          watcher.onDidChange(invalidate), watcher.onDidCreate(invalidate), watcher.onDidDelete(invalidate)));
      }
    }
    let subscription: vscode.Disposable | undefined;
    active.waiters++;
    try {
      const result = await Promise.race([
        active.value.then(value => ({ value })),
        new Promise<{
          /** 要求がキャンセルされたことを表す値． */
          cancelled: true
        }>(resolve => {
          subscription = token.onCancellationRequested(() => resolve({ cancelled: true }));
          if (token.isCancellationRequested) { resolve({ cancelled: true }); }
        })
      ]);
      return !('cancelled' in result) && !token.isCancellationRequested && this.active === active ? result.value : undefined;
    } catch (error) {
      if (this.active === active) { this.invalidate(); }
      if (token.isCancellationRequested || active.token.isCancellationRequested
        || error instanceof vscode.CancellationError) { return undefined; }
      throw error;
    } finally {
      subscription?.dispose();
      active.waiters--;
      // VS Codeは次の検索文字が入力されると，後続の要求を登録する前に以前の要求をキャンセルする場合がある．許可された編集ですでに文書版が進んでいれば，共有中の読み込みを保持する．
      if (token.isCancellationRequested && active.waiters === 0 && this.active === active
        && active.version === requestedVersion) { this.invalidate(); }
    }
  }

  /**
   * 一時的な監視は，ワークスペースフォルダ外のプロジェクトソースも対象とする．
   * @param uris 対象ファイルのURIの一覧．
   * @param token 要求のキャンセルを確認するトークン．省略可能．
   * @returns なし．
   */
  watch(uris: readonly vscode.Uri[], token?: vscode.CancellationToken): void {
    const active = this.active;
    if (!active || active.scope !== 'project' || (token && (active.token !== token || token.isCancellationRequested))) { return; }
    for (const uri of uris) { active.dependencies.add(Workspace.uriKey(uri)); }
    this.watchDirectories(uris.filter(uri => uri.scheme === 'file').map(uri => vscode.Uri.file(path.dirname(uri.fsPath))), token);
  }

  /**
   * 補完に影響するファイルの作成・削除をディレクトリ単位で監視する．
   * @param directories 監視するディレクトリのURIの一覧．
   * @param token 要求のキャンセルを確認するトークン．省略可能．
   * @returns なし．
   */
  watchDirectories(directories: readonly vscode.Uri[], token?: vscode.CancellationToken): void {
    const active = this.active;
    if (!active || active.scope !== 'project' || (token && (active.token !== token || token.isCancellationRequested))) { return; }
    for (const directory of directories) {
      if (directory.scheme !== 'file') { continue; }
      const key = Workspace.uriKey(directory);
      if (active.watches.has(key)) { continue; }
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(directory, '*'));
      const invalidate = () => { if (this.active === active) { this.invalidate(); } };
      active.watches.set(key, vscode.Disposable.from(watcher,
        watcher.onDidChange(uri => {
          if (active.dependencies.has(Workspace.uriKey(uri)) || path.extname(uri.path).toLowerCase() === '.tex') { invalidate(); }
        }), watcher.onDidCreate(invalidate), watcher.onDidDelete(invalidate)));
    }
  }

  /**
   * 変更された入力に依存するキャッシュを無効にする．
   * 引数はない．
   * @returns なし．
   */
  invalidate(): void {
    const active = this.active;
    this.active = undefined;
    if (!active) { return; }
    active.cancellation.cancel();
    active.cancellation.dispose();
    for (const watch of active.watches.values()) { watch.dispose(); }
  }

  /**
   * 所有する監視・購読・表示などのリソースを解放する．
   * 引数はない．
   * @returns なし．
   */
  dispose(): void {
    this.disposed = true;
    this.invalidate();
    for (const subscription of this.subscriptions) { subscription.dispose(); }
  }

  /**
   * 文書変更が補完の検索文字列だけに収まるかを確認し，必要ならセッションを破棄する．
   * @param event 状態変更の内容を伝えるイベント．
   * @returns なし．
   */
  private changed(event: vscode.TextDocumentChangeEvent): void {
    const active = this.active;
    if (!active || event.contentChanges.length === 0) { return; }
    if (event.document !== active.document) {
      if (active.scope === 'project') { this.invalidate(); }
      return;
    }
    let delta = 0;
    for (const change of event.contentChanges) {
      if (change.rangeOffset < active.start || change.rangeOffset + change.rangeLength > active.end
        || /[\r\n\\%{}\[\],]/.test(change.text)) {
        this.invalidate();
        return;
      }
      delta += change.text.length - change.rangeLength;
    }
    active.end += delta;
    active.version = event.document.version;
  }
}
