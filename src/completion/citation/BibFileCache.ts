import * as vscode from 'vscode';
import * as Workspace from '../../workspace';
import { parseBibTeX } from './BibTeXParser';
import { CitationEntry } from './Citation';
import { latexToPlainText } from './CitationSearch';

interface ParsedFile {
  /** 対象の開いている文書． */
  document: vscode.TextDocument | undefined;
  /** 読み取り時点のエディタ文書の版番号． */
  documentVersion?: number;
  /** 解析済みの項目の配列． */
  entries: CitationEntry[];
}

interface PendingRead {
  /** キャッシュや位置情報の更新を識別する改訂番号． */
  revision: number;
  /** 対象の開いている文書． */
  document: vscode.TextDocument | undefined;
  /** 読み取り時点のエディタ文書の版番号． */
  documentVersion: number | undefined;
  /** 進行中の非同期処理を共有するPromise． */
  promise: Promise<CitationEntry[]>;
}

interface WatchedFile {
  /** イベント購読または監視を解除するためのハンドル． */
  disposable: vscode.Disposable;
  /** キャッシュや位置情報の更新を識別する改訂番号． */
  revision: number;
  /** 最後に有効と確認した解析結果． */
  cached?: ParsedFile;
  /** 現在進行中の処理．未開始または完了後は未設定． */
  pending?: PendingRead;
}

/** 解析済みの文献と，ワークスペース外も含む非再帰的なファイル監視． */
export default class BibFileCache implements vscode.Disposable {
  /** 文献ファイルの識別キーから監視・改訂・読み取り状態への表． */
  private readonly files = new Map<string, WatchedFile>();
  /** 所有者の識別キーから，参照する文献ファイルの識別キーの集合への表． */
  private readonly references = new Map<string, Set<string>>();
  /** 所有するリソースを解放し，新しい要求を受け付けない場合はtrue． */
  private disposed = false;

  /**
   * 参照元の間で文献ファイルの監視を共有し，どこからも参照されなくなったファイルを解放する．
   * @param owner 文献ファイルの参照元を識別する文字列．
   * @param uris 対象ファイルのURIの一覧．
   * @returns なし．
   */
  public setReferences(owner: string, uris: readonly vscode.Uri[]): void {
    if (this.disposed) {
      return;
    }
    const keys = new Set<string>();
    for (const uri of uris) {
      const key = Workspace.uriKey(uri);
      keys.add(key);
      if (!this.files.has(key)) {
        // 親ディレクトリを監視することで，ファイルの置き換えによる保存にも対応する．
        // 単純なパターンで再帰監視とファイル名のエスケープ問題を避け，references[1].bibなども正確なURIで照合する．
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), '*')
        );
        const changed = (eventUri: vscode.Uri) => {
          if (Workspace.uriKey(eventUri) !== key) {
            return;
          }
          this.invalidate(uri);
        };
        this.files.set(key, {
          revision: 0,
          disposable: vscode.Disposable.from(
            watcher,
            watcher.onDidChange((eventUri) => changed(eventUri)),
            watcher.onDidCreate(changed),
            watcher.onDidDelete(changed)
          )
        });
      }
    }
    this.references.set(owner, keys);
    this.releaseUnused();
  }

  /**
   * 指定した所有者による文献ファイルの参照を解除する．
   * @param owner 文献ファイルの参照元を識別する文字列．
   * @returns なし．
   */
  public release(owner: string): void {
    this.references.delete(owner);
    this.releaseUnused();
  }

  /**
   * 変更された入力に依存するキャッシュを無効にする．
   * @param uri 対象ファイルのURI．
   * @returns なし．
   */
  public invalidate(uri: vscode.Uri): void {
    const file = this.files.get(Workspace.uriKey(uri));
    if (file) {
      file.revision++;
      file.cached = undefined;
      file.pending = undefined;
    }
  }

  /**
   * 文献ファイルの現在の版に対応する解析結果を取得する．
   * @param uri 対象ファイルのURI．
   * @returns 現在の文献項目の配列．同じ版の読み取りは共有する．Promiseで返す．
   */
  public async read(uri: vscode.Uri): Promise<CitationEntry[]> {
    const key = Workspace.uriKey(uri);
    const file = this.files.get(key);
    // 最初の読み取り中の更新をキャッシュ作成前に取り逃さないよう，読み取りより先に監視を登録する．
    if (!file) {
      return [];
    }
    // 外部からの書き込みが続いても，補完要求を無期限に保持しない．キャッシュを空にして次の要求で再試行する．
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.disposed || this.files.get(key) !== file) {
        return [];
      }
      const document = Workspace.findOpenDocument(uri);
      const documentVersion = document?.version;
      if (file.cached && file.cached.document === document && file.cached.documentVersion === documentVersion) {
        return file.cached.entries;
      }
      let pending = file.pending;
      if (!pending || pending.revision !== file.revision || pending.document !== document
        || pending.documentVersion !== documentVersion) {
        pending = {
          revision: file.revision,
          document,
          documentVersion,
          promise: this.parse(uri)
        };
        file.pending = pending;
      }
      let entries: CitationEntry[] | undefined;
      try {
        entries = await pending.promise;
      } catch {
        // 存在しないファイルはキャッシュしない．作成通知または次の補完要求で，後から利用可能になったファイルを読み取る．
      }
      if (file.pending === pending) {
        file.pending = undefined;
      }
      if (this.disposed || this.files.get(key) !== file) {
        return [];
      }
      const currentDocument = Workspace.findOpenDocument(uri);
      if (file.revision !== pending.revision || currentDocument !== document
        || currentDocument?.version !== documentVersion) {
        continue;
      }
      if (entries) {
        file.cached = { document, documentVersion, entries };
      }
      return entries ?? [];
    }
    return [];
  }

  /**
   * 所有する監視・購読・表示などのリソースを解放する．
   * 引数はない．
   * @returns なし．
   */
  public dispose(): void {
    this.disposed = true;
    for (const file of this.files.values()) {
      file.disposable.dispose();
    }
    this.files.clear();
    this.references.clear();
  }

  /**
   * どの所有者からも参照されない文献ファイルの監視とキャッシュを解放する．
   * 引数はない．
   * @returns なし．
   */
  private releaseUnused(): void {
    const retained = new Set(Array.from(this.references.values()).flatMap((keys) => [...keys]));
    for (const [key, file] of this.files) {
      if (!retained.has(key)) {
        file.disposable.dispose();
        this.files.delete(key);
      }
    }
  }

  /**
   * 文献ファイルの本文を読み取り，表示と検索に使用する項目へ変換する．
   * @param uri 対象ファイルのURI．
   * @returns 引用キー，種別，著者，題名，年，および元ファイルを持つ文献項目の配列を返すPromise．
   */
  private async parse(uri: vscode.Uri): Promise<CitationEntry[]> {
    const source = await Workspace.readDocumentText(uri);
    return parseBibTeX(source).map((parsed): CitationEntry => ({
      key: parsed.key,
      type: parsed.type,
      author: latexToPlainText(parsed.fields.author ?? ''),
      title: latexToPlainText(parsed.fields.title ?? ''),
      year: parsed.fields.year ? latexToPlainText(parsed.fields.year) : undefined,
      sourceUri: uri
    }));
  }
}
