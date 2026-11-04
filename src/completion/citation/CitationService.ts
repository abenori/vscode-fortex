import * as vscode from 'vscode';
import { discoverBibReferences, resolveBibUri } from './BibFileDiscovery';
import { CitationEntry } from './Citation';
import BibFileCache from './BibFileCache';
import KpsewhichResolver, { programName } from '../../project/KpsewhichResolver';
import Config from '../../Config';
import LaTeXProject from '../../project/LaTeXProject';
import * as Workspace from '../../workspace';

interface ProjectScope {
  /** プロジェクトのメインTeXファイルのURI． */
  main: vscode.Uri;
  /** 文献宣言の探索対象とするプロジェクトのソースURI． */
  files: vscode.Uri[];
  /** 探索対象のソースで宣言された文献ファイル名． */
  references: string[];
  /** 文献処理に使用する実行プログラム． */
  program: string;
  /** 実行ファイルへ個別に渡す追加引数．シェル用の引用符は加えない． */
  args: readonly string[];
}

/**
 * 要求ごとに文献の入力元を探索する．要求間で保持するのは文献の本文と文献パスの検索結果だけ．
 */
export default class CitationService implements vscode.Disposable {
  /** 終了時にまとめて解除する監視とイベント購読． */
  private readonly disposables: vscode.Disposable[] = [];
  /** 文献ファイルの内容と共有監視を保持するキャッシュ． */
  private readonly bibliography = new BibFileCache();
  /** ソース変更の前後で古い要求を識別する改訂番号． */
  private sourceRevision = 0;
  /** 所有するリソースを解放し，新しい要求を受け付けない場合はtrue． */
  private disposed = false;

  /**
   * 内容の無効化を登録する．パスキャッシュの有効期間は共有の検索サービスに任せる．
   * 引数はない．
   * @returns 新しいインスタンス．コンストラクタから明示的な値は返さない．
   */
  public constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (isBibDocument(event.document)) {
          this.bibliography.invalidate(event.document.uri);
        } else if (event.contentChanges.length > 0) {
          // 文字入力時にはソースの読み取りや解析を行わない．ソース変更前に始まった古い要求の結果が公開されることだけを防ぐ．
          this.sourceRevision++;
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (isBibDocument(document)) {
          this.bibliography.invalidate(document.uri);
        } else if (document.languageId === 'latex') {
          const key = Workspace.uriKey(document.uri);
          this.bibliography.release(key);
          this.sourceRevision++;
        }
      })
    );
  }

  /**
   * 宣言された文献ファイルを解決し，古い要求を除外しながら現在の文献一覧をまとめる．
   * @param document 要求の対象となる編集中の文書．
   * @param token 要求のキャンセルを確認するトークン．省略可能．
   * @param watch 読み取った依存ファイルの監視を登録するコールバック．省略時は() => undefined．
   * @param watchDirectories 探索したディレクトリの監視を登録するコールバック．省略時は() => undefined．
   * @returns 対象文書のプロジェクトで利用できる文献の配列．Promiseで返す．
   */
  public async entriesFor(
    document: vscode.TextDocument,
    token?: vscode.CancellationToken,
    watch: (uris: readonly vscode.Uri[]) => void = () => undefined,
    watchDirectories: (uris: readonly vscode.Uri[]) => void = () => undefined
  ): Promise<CitationEntry[]> {
    if (this.disposed || document.isClosed || token?.isCancellationRequested) {
      return [];
    }
    const key = Workspace.uriKey(document.uri);
    const revision = this.sourceRevision;
    const version = document.version;
    // 補完セッションは検索文字列内の編集を許容し，その有効性をトークンで管理する．単独の呼び出しでは，ソースが編集された時点で要求を無効にする．
    const current = () => !this.disposed && !document.isClosed && !token?.isCancellationRequested
      && (token !== undefined || (this.sourceRevision === revision && document.version === version));
    let scope: ProjectScope;
    try {
      scope = await this.projectScope(document, token,
        uris => { if (current()) { watch(uris); } },
        uris => { if (current()) { watchDirectories(uris); } });
    } catch (error) {
      if (!current() || error instanceof vscode.CancellationError) { return []; }
      throw error;
    }
    if (!current()) {
      return [];
    }
    const localBiber = programName(scope.program) === 'biber'
      ? await this.localBiberFiles(scope) : scope.references.map(() => undefined);
    if (!current()) { return []; }
    const unresolved = scope.references.filter((_reference, index) => !localBiber[index]);
    const kpsewhichResults = await KpsewhichResolver.resolve(scope.main, unresolved,
      programName(scope.program) === 'biber' ? 'kpsewhich' : scope.program);
    let resolvedIndex = 0;
    // 非同期のプロジェクト・パス探索が終わった後，閉じた文書や新しい構造に対して古い監視を登録しない．
    if (!current()) {
      return [];
    }
    const uris: vscode.Uri[] = [];
    const seen = new Set<string>();
    for (const [index, reference] of scope.references.entries()) {
      const uri = localBiber[index] ?? kpsewhichResults[resolvedIndex++] ?? resolveBibUri(scope.main, reference);
      const uriKey = Workspace.uriKey(uri);
      if (!seen.has(uriKey)) {
        seen.add(uriKey);
        uris.push(uri);
      }
    }
    watch(uris);
    this.bibliography.setReferences(key, uris);
    const groups = await Promise.all(uris.map((uri) => this.bibliography.read(uri)));
    if (!current()) {
      return [];
    }
    // 引用キーが重複した場合は，文献ファイルの順序に従って最初の項目を保持する．
    const unique = new Map<string, CitationEntry>();
    for (const entry of groups.flat()) {
      if (!unique.has(entry.key)) {
        unique.set(entry.key, entry);
      }
    }
    return Array.from(unique.values());
  }

  /**
   * 共有の検索キャッシュは破棄せず，補完が所有するリソースを解放する．
   * 引数はない．
   * @returns なし．
   */
  public dispose(): void {
    this.disposed = true;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.bibliography.dispose();
    this.sourceRevision++;
  }

  /**
   * Biberで設定された入出力ディレクトリを優先し，その後でプロジェクト内の文献候補を探す．
   * @param scope 文献探索対象のメインファイルと関連ソース・実行設定．
   * @returns 宣言された順序のローカル文献URI．候補が見つからない要素はundefined．Promiseで返す．
   */
  private async localBiberFiles(scope: ProjectScope): Promise<(vscode.Uri | undefined)[]> {
    let input: string | undefined;
    for (const option of ['--input-directory', '--output-directory']) {
      const index = scope.args.findIndex(arg => arg === option || arg.startsWith(`${option}=`));
      if (index >= 0) {
        input = scope.args[index] === option ? scope.args[index + 1] : scope.args[index].slice(option.length + 1);
        if (input) { break; }
      }
    }
    const bases = input ? [vscode.Uri.joinPath(resolveBibUri(scope.main, input), '_'), scope.main] : [scope.main];
    return Promise.all(scope.references.map(async reference => {
      for (const base of bases) {
        const uri = resolveBibUri(base, reference);
        try { if ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.File) { return uri; } }
        catch { /* 次のローカル候補，またはKpathseaでこの名前を解決できる可能性がある． */ }
      }
      return undefined;
    }));
  }

  /**
   * 要求内で固定したソースの読み取り結果を使い，両方の形式の文献宣言を収集する．
   * @param document 要求の対象となる編集中の文書．
   * @param token 要求のキャンセルを確認するトークン．
   * @param watch 読み取った依存ファイルの監視を登録するコールバック．
   * @param watchDirectories 探索したディレクトリの監視を登録するコールバック．
   * @returns メインファイル，関連ソース，文献参照，および文献処理コマンドの設定．Promiseで返す．
   */
  private async projectScope(
    document: vscode.TextDocument, token: vscode.CancellationToken | undefined,
    watch: (uris: readonly vscode.Uri[]) => void,
    watchDirectories: (uris: readonly vscode.Uri[]) => void
  ): Promise<ProjectScope> {
    const key = Workspace.uriKey(document.uri);
    // 1件の要求では検索中の文書も含めて読み取り結果を固定する．検索文字列の続きの入力でメインファイルやプロジェクトの探索を繰り返さない．
    const sources = new Map<string, Promise<string>>([[key, Promise.resolve(document.getText())]]);
    const readSource = (uri: vscode.Uri): Promise<string> => {
      if (token?.isCancellationRequested) { return Promise.reject(new vscode.CancellationError()); }
      const sourceKey = Workspace.uriKey(uri);
      let source = sources.get(sourceKey);
      if (!source) { source = Workspace.readDocumentText(uri); sources.set(sourceKey, source); }
      return source;
    };
    let main = document.uri;
    let projectFiles = [document.uri];
    let bibliography = Config.programSettings('bibtex');
    try {
      const project = await LaTeXProject.create(document.uri, {
        readSource, onDependency: uri => watch([uri]), onDirectory: uri => watchDirectories([uri])
      });
      main = project.mainfile;
      bibliography = Config.programSettings('bibtex', project.percent_sharp?.('bibtex')?.trim());
      const files = project.filelist.filter(entry => entry.exists).map(entry => entry.uri);
      if (files.length > 0) { projectFiles = files; }
    } catch (error) {
      if (error instanceof vscode.CancellationError) { throw error; }
      // 単独の文書や未保存の文書は，その文書自体をプロジェクトの起点とする．
    }
    const texts = await Promise.all(projectFiles.map(uri => readSource(uri).catch(() => '')));
    const references: string[] = [];
    const seen = new Set<string>();
    for (const source of texts) {
      for (const reference of discoverBibReferences(source)) {
        if (!seen.has(reference)) {
          seen.add(reference);
          references.push(reference);
        }
      }
    }
    return { main, files: projectFiles, references, program: bibliography.command, args: bibliography.args };
  }
}

/**
 * 文書が文献情報の更新対象であるかを判定する．
 * @param document 要求の対象となる編集中の文書．
 * @returns BibTeX文書または.bibファイルであればtrue．
 */
function isBibDocument(document: vscode.TextDocument): boolean {
  return document.uri.path.toLocaleLowerCase().endsWith('.bib');
}
