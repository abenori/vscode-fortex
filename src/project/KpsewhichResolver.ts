import * as path from 'path';
import * as ChildProcess from 'child_process';
import * as spawn from 'cross-spawn';
import * as vscode from 'vscode';
import Config from '../Config';
import { uriKey } from '../workspace';

interface Lookup {
  /** 検索したファイルのURI．解決できなかった名前の結果はundefined． */
  readonly promise: Promise<vscode.Uri | undefined>;
  /** この検索結果を無効にし得るファイルの識別キー． */
  readonly paths: Set<string>;
}

interface DirectoryWatch {
  /** イベント購読または監視を解除するためのハンドル． */
  readonly disposable: vscode.Disposable;
  /** 監視するファイルの識別キーから，影響を受ける検索キャッシュのキーの集合への表． */
  readonly files: Map<string, Set<string>>;
}

/**
 * 処理方式の選択とKpathseaのプログラム指定に使用する，実行ファイルの名前を返す．
 * @param command 実行または解析するコマンド．
 * @returns 拡張子とディレクトリを除去して小文字にしたプログラム名．
 */
export function programName(command: string): string {
  return path.posix.basename(command.replace(/\\/g, '/')).replace(/\.(exe|com|cmd|bat)$/i, '').toLowerCase();
}

/** すべての利用側で，Kpathseaの検索結果，存在確認の監視，有効期間を共有する． */
export default class KpsewhichResolver {
  /** 同じ実行条件と名前のKpathsea検索結果を共有するキャッシュ． */
  private static readonly cache = new Map<string, Lookup>();
  /** 依存するファイルやディレクトリの監視ハンドルの対応表． */
  private static readonly watches = new Map<string, DirectoryWatch>();
  /** 実行中のkpsewhichの子プロセスの集合． */
  private static readonly processes = new Set<ChildProcess.ChildProcess>();
  /** 検索用の設定変更を受け取る共有購読． */
  private static configuration?: vscode.Disposable;
  /** 古い非同期結果を識別して無視するための世代番号． */
  private static generation = 0;

  /**
   * 拡張機能の有効化処理より前に初めて使われた場合も，設定変更による無効化を一度だけ登録する．
   * 引数はない．
   * @returns なし．
   */
  public static initialize(): void {
    this.configuration ??= vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('vscode-fortex.kpsewhich.path')) { this.clear(); }
    });
  }

  /**
   * 名前ごとのPromiseを再利用し，未検索の名前を1つのプロセスでまとめて調べる．
   * @param texUri 親ディレクトリを検索の作業場所にするTeXファイル．
   * @param references 拡張子を含む，解決対象のファイル名の一覧．
   * @param program --prognameへ渡すプログラム名．省略時はbibtex．
   * @param searchPath --pathへ渡すKpathseaの検索パス．例: $INDEXDICTIONARY．省略可能．
   * @returns 要求順を保った解決結果．各名前に対してURIまたはundefinedを返す．
   */
  public static resolve(texUri: vscode.Uri, references: readonly string[], program = 'bibtex', searchPath?: string):
    Promise<readonly (vscode.Uri | undefined)[]> {
    if (!vscode.workspace.isTrusted || texUri.scheme !== 'file' || references.length === 0) {
      return Promise.resolve(references.map(() => undefined));
    }
    this.initialize();
    const cwd = path.dirname(texUri.fsPath);
    const executable = Config.kpsewhichPath().trim() || 'kpsewhich';
    const context = programName(program);
    const keyFor = (name: string) => JSON.stringify([executable, cwd, context, searchPath, name]);
    const missing = [...new Set(references)].filter(name => !this.cache.has(keyFor(name)));
    if (missing.length) {
      // すべてのPromiseと監視を登録してから検索を開始し，同時の呼び出しで同じ検索を共有する．
      const generation = this.generation;
      const batch = Promise.resolve().then(() => generation === this.generation
        ? this.run(executable, cwd, missing, context, searchPath) : missing.map(() => undefined));
      missing.forEach((name, index) => {
        const key = keyFor(name);
        const entry: Lookup = { paths: new Set(), promise: batch.then(results => {
          const result = results[index];
          if (result && this.cache.get(key) === entry) { this.watch(key, result); }
          return result;
        }) };
        this.cache.set(key, entry);
        this.watch(key, vscode.Uri.file(path.resolve(cwd, name)));
      });
    }
    return Promise.all(references.map(name => this.cache.get(keyFor(name))!.promise));
  }

  /**
   * 新しい検索を開始せず，検索結果とその監視を破棄する．
   * 引数はない．
   * @returns なし．
   */
  public static clear(): void {
    this.generation++;
    this.cache.clear();
    for (const watch of this.watches.values()) { watch.disposable.dispose(); }
    this.watches.clear();
  }

  /**
   * 共有のイベント購読，存在確認の監視，実行中の補助プロセスを解放する．
   * 引数はない．
   * @returns なし．
   */
  public static dispose(): void {
    this.configuration?.dispose();
    this.configuration = undefined;
    this.clear();
    for (const child of this.processes) { child.kill(); }
  }

  /**
   * 親ディレクトリの非再帰監視を共有し，正確なファイルパスを影響する検索キーへ対応付ける．
   * @param key 検索または設定の項目を識別するキー．
   * @param uri 対象ファイルのURI．
   * @returns なし．
   */
  private static watch(key: string, uri: vscode.Uri): void {
    const entry = this.cache.get(key);
    if (!entry) { return; }
    const fileKey = uriKey(uri);
    if (entry.paths.has(fileKey)) { return; }
    const directory = vscode.Uri.joinPath(uri, '..');
    const directoryKey = uriKey(directory);
    let watch = this.watches.get(directoryKey);
    if (!watch) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(directory, '*'), false, true, false);
      const files = new Map<string, Set<string>>();
      const changed = (changedUri: vscode.Uri) => {
        for (const affected of [...(files.get(uriKey(changedUri)) ?? [])]) { this.remove(affected); }
      };
      watch = { files, disposable: vscode.Disposable.from(watcher,
        watcher.onDidCreate(changed), watcher.onDidDelete(changed)) };
      this.watches.set(directoryKey, watch);
    }
    const keys = watch.files.get(fileKey) ?? new Set<string>();
    keys.add(key);
    watch.files.set(fileKey, keys);
    entry.paths.add(fileKey);
  }

  /**
   * 1件の検索結果を取り除き，どのキャッシュからも使われなくなったディレクトリの監視を解放する．
   * @param key 検索または設定の項目を識別するキー．
   * @returns なし．
   */
  private static remove(key: string): void {
    const entry = this.cache.get(key);
    if (!entry) { return; }
    this.cache.delete(key);
    for (const [directory, watch] of this.watches) {
      for (const file of entry.paths) {
        const keys = watch.files.get(file);
        keys?.delete(key);
        if (keys?.size === 0) { watch.files.delete(file); }
      }
      if (watch.files.size === 0) {
        watch.disposable.dispose();
        this.watches.delete(directory);
      }
    }
  }

  /**
   * .bibと.bstの両方を拡張子に応じて検索し，未解決の要素の位置も保持する．
   * @param executable 起動する実行ファイル名またはパス．
   * @param cwd 外部コマンドを実行する作業ディレクトリのパス．
   * @param references 解決する文献または補助ファイルの参照名の一覧．
   * @param program 補助プログラムの種類または実行名．
   * @param searchPath kpsewhichの--pathへ渡す検索パス．省略可能．
   * @returns 要求と同じ順序のURI．解決できない名前はundefined．Promiseで返す．
   */
  private static run(executable: string, cwd: string, references: readonly string[], program: string, searchPath?: string):
    Promise<readonly (vscode.Uri | undefined)[]> {
    return new Promise(resolve => {
      const child = spawn.spawn(executable, [`--progname=${program}`, ...(searchPath !== undefined ? [`--path=${searchPath}`] : []), ...references], {
        cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
      });
      this.processes.add(child);
      const output: Buffer[] = [];
      let settled = false;
      const finish = (result: readonly (vscode.Uri | undefined)[]) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timeout);
        this.processes.delete(child);
        resolve(result);
      };
      const timeout = setTimeout(() => {
        child.kill();
        finish(references.map(() => undefined));
      }, 5000);
      child.stdout?.on('data', (chunk: Buffer) => output.push(chunk));
      child.once('error', () => finish(references.map(() => undefined)));
      child.once('close', () => finish(this.parseOutput(Buffer.concat(output).toString('utf8'), references.length)
        .map(result => result ? vscode.Uri.file(path.resolve(cwd, result)) : undefined)));
    });
  }

  /**
   * 一括検索で解決できなかった名前を表す空行を保持する．
   * @param output 外部コマンドの標準出力．
   * @param expectedResults 要求された検索結果の個数．
   * @returns 要求と同じ順序の解決済みパス．空行や不足した結果はundefined．
   */
  private static parseOutput(output: string, expectedResults: number): (string | undefined)[] {
    const lines = output.replace(/\r/g, '').split('\n');
    if (lines.length > expectedResults && lines[lines.length - 1] === '') { lines.pop(); }
    return Array.from({ length: expectedResults }, (_, index) => lines[index]?.trim() || undefined);
  }
}
