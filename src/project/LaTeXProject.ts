import * as vscode from 'vscode';
import * as path from 'path';
import Config from "../Config";
import * as Workspace from '../workspace';
import * as LaTeXParser from '../latex-parser';
import { resolveInputFile } from './InputFileResolver';
import type { InputToken } from './InputFileResolver';
import { MacroState } from './InputMacros';

type LaTeXFileType = typeof LaTeXProject.LaTeXFileType[keyof typeof LaTeXProject.LaTeXFileType];

interface IncludedFile {
  /** 対象ファイルのURI． */
  readonly uri: vscode.Uri;
  /** メインファイル，include，inputのどの参照から得たファイルかを表す． */
  readonly type: LaTeXFileType;
}

/** 存在しない参照もビルド用の情報には保持するが，ソース本文の探索からは除外する． */
interface ProjectFileEntry extends IncludedFile {
  /** 存在確認時点で対象がファイルとして存在した場合はtrue． */
  readonly exists: boolean;
}

type ProjectDescription = [
  /** プロジェクト検出の起点ファイル．指定がなければnull． */
  file: vscode.Uri | null,
  /** プロジェクトのメインTeXファイルのURI． */
  main: vscode.Uri,
  /** 検出した文書クラス名．未指定なら空文字列． */
  classFile: string,
  /** 文書クラスに指定されたオプション文字列． */
  classOption: string,
  /** %#指示のキーから指示本文への対応表． */
  directives: {
    /** %#指示のキーから指示本文への対応． */
    [key: string]: string
  }
];

interface ProjectSource {
  /** 同じ不変ソースを共有するLaTeX構文解析結果． */
  readonly syntax: LaTeXParser.LaTeXSource;
}

/** ソースの選択と探索結果の通知設定．更新と監視の管理は呼び出し側で行う． */
export interface ProjectReadOptions {
  /** 既定ではエディタのバッファを優先する．URIごとに一度だけ呼び，要求中の差し替えや再試行は行わない． */
  readonly readSource?: (uri: vscode.Uri) => Promise<string>;
  /** 欠落したファイルも含め，読み取り・存在確認の候補を一度だけ通知し，呼び出し側が監視できるようにする． */
  readonly onDependency?: (uri: vscode.Uri) => void;
  /** メインファイルの候補を探したディレクトリを一度だけ通知する． */
  readonly onDirectory?: (uri: vscode.Uri) => void;
}

interface ProjectRequest {
  /** この要求が開始されたプロジェクト処理の有効世代． */
  readonly lifetime: number;
  /** 今回の探索で固定するソース読み取り関数と依存先の通知先． */
  readonly options: ProjectReadOptions;
  /** メインファイルを探す方法の優先順． */
  readonly order: readonly string[];
  /** ファイルの識別キーから共有するソース読み取り結果への表． */
  readonly sources: Map<string, Promise<ProjectSource>>;
  /** この処理が参照したファイルの識別キーの集合． */
  readonly dependencies: Set<string>;
  /** メインファイルの探索で訪れたディレクトリの識別キー． */
  readonly directories: Set<string>;
}

/**
 * 現在のLaTeXプロジェクトを表し，メイン文書を探索する．
 *
 * 利用者の設定順に，%#main，親ファイルの再帰的な探索，現在ファイルをメインとして扱う方法を適用する．
 */
export default class LaTeXProject {
  /** この要求が開始されたプロジェクト処理の有効世代． */
  private static lifetime = 0;

  /**
   * 要求間でプロジェクトの状態を保持せず，進行中の要求をキャンセルする．
   * 引数はない．
   * @returns なし．
   */
  public static dispose(): void {
    LaTeXProject.lifetime++;
  }

  /**
   * 1回のプロジェクト探索で読み取り結果と依存先の記録を共有する．
   * @param options 処理の動作を指定するオプション．
   * @param run 要求の有効期間中に実行する処理．
   * @returns 渡された処理の結果．有効世代が変化した場合はキャンセル例外．Promiseで返す．
   */
  private static async request<T>(options: ProjectReadOptions, run: (request: ProjectRequest) => Promise<T>): Promise<T> {
    // 入力は最初に読み取った時点で固定する．変更は実行中の処理をやり直すのではなく，次の呼び出しに反映する．
    const request: ProjectRequest = {
      lifetime: LaTeXProject.lifetime, options, order: [...Config.mainFileOrder()],
      sources: new Map(), dependencies: new Set(), directories: new Set()
    };
    try {
      const result = await run(request);
      LaTeXProject.checkRequest(request);
      return result;
    } catch (error) {
      LaTeXProject.checkRequest(request);
      throw error;
    }
  }

  /**
   * プロジェクト読み取り要求が有効な世代かを確認する．
   * @param request 今回の探索の有効世代，読み取り設定，および依存先の記録．
   * @returns なし．
   */
  private static checkRequest(request: ProjectRequest): void {
    if (request.lifetime !== LaTeXProject.lifetime) { throw new vscode.CancellationError(); }
  }

  /**
   * 依存ファイルを要求内で一度だけ登録して通知する．
   * @param request 今回の探索の有効世代，読み取り設定，および依存先の記録．
   * @param uri 対象ファイルのURI．
   * @returns 初めて登録した場合はtrue，登録済みならfalse．
   */
  private static dependency(request: ProjectRequest, uri: vscode.Uri): boolean {
    LaTeXProject.checkRequest(request);
    const key = Workspace.uriKey(uri);
    if (request.dependencies.has(key)) { return false; }
    request.dependencies.add(key);
    request.options.onDependency?.(uri);
    return true;
  }

  /**
   * 要求内でソースの読み取りと構文解析を共有する．
   * @param request 今回の探索の有効世代，読み取り設定，および依存先の記録．
   * @param file 対象ファイルのURI．
   * @returns 同じ本文から作成し，要求内で共有するLaTeX構文解析結果を持つProjectSourceのPromise．
   */
  private static async readSource(request: ProjectRequest, file: vscode.Uri): Promise<ProjectSource> {
    LaTeXProject.dependency(request, file);
    const key = Workspace.uriKey(file);
    let pending = request.sources.get(key);
    if (!pending) {
      pending = (async () => {
        const source = await (request.options.readSource?.(file) ?? Workspace.readDocumentText(file));
        LaTeXProject.checkRequest(request);
        return { syntax: new LaTeXParser.LaTeXSource(source) };
      })();
      request.sources.set(key, pending);
    }
    return pending;
  }

  /** メインファイル・include・inputの参照種別に対応する定数． */
  static readonly LaTeXFileType = {
    /** プロジェクトのメインファイル． */
    main: 0,
    /** include宣言から参照されたファイル． */
    include: 1,
    /** input宣言から参照されたファイル． */
    input: 2,
  } as const;
  /** プロジェクト検出の起点ファイル．起点がなければnull． */
  private file_: vscode.Uri | null = null;
  /**
   * プロジェクト検出の起点となったファイルを取得する．
   * 引数はない．
   * @returns 起点のURI．ファイルを指定せず作成した場合はnull．
   */
  get file(): vscode.Uri | null { return this.file_; }
  /** 検出したメインTeXファイルのURI． */
  private mainfile_: vscode.Uri;
  /**
   * ビルド対象のメインファイルを取得する．
   * 引数はない．
   * @returns 検出されたメインTeXファイルのURI．
   */
  get mainfile(): vscode.Uri { return this.mainfile_; }
  /** メインファイルで指定された文書クラス名． */
  private classfile_: string = "";
  /**
   * メインファイルで指定された文書クラスを取得する．
   * 引数はない．
   * @returns 文書クラス名．指定を読み取れなければ空文字列．
   */
  get classfile(): string { return this.classfile_; }
  /** メインファイルで指定されたクラスオプション． */
  private classoption_: string = "";
  /**
   * メインファイルの文書クラスオプションを取得する．
   * 引数はない．
   * @returns クラスオプションの文字列．指定がなければ空文字列．
   */
  get classoption(): string { return this.classoption_; }
  /** 重複を除いた関連ファイルと参照種別・存在確認結果． */
  private readonly filelist_: readonly ProjectFileEntry[];
  /**
   * 探索順の重複しない参照一覧．作成時点の存在状態も記録する．
   * 引数はない．
   * @returns 探索順の関連ファイルと，その参照種別・存在確認結果．
   */
  get filelist(): readonly ProjectFileEntry[] { return this.filelist_; }
  /** %#指示のキーから指示本文への対応表． */
  private percent_sharp_: {
    /** %#指示のキーから指示本文への対応． */
    [key: string]: string
  } = {};
  /**
   * ソース中の%#指示をキーで取得する．
   * @param key 検索または設定の項目を識別するキー．
   * @returns 対応する指示の本文．未指定ならundefined．
   */
  public percent_sharp(key: string): string | undefined {
    return this.percent_sharp_[key];
  }

  /**
   * LaTeXProjectの初期状態と所有するリソースを準備する．
   * @param [file, main, classFile, classOption, directives] 順番に取り出す組の要素．対象ファイルのURI． ビルドの起点となるメインTeXファイルのURI． classFile classOption ソース中の%#指示をキーから本文へ対応付けた表．
   * @param entries 処理する項目の一覧．
   * @returns 新しいインスタンス．コンストラクタから明示的な値は返さない．
   */
  private constructor([file, main, classFile, classOption, directives]: ProjectDescription, entries: readonly ProjectFileEntry[]) {
    this.file_ = file;
    this.mainfile_ = main;
    this.classfile_ = classFile;
    this.classoption_ = classOption;
    this.percent_sharp_ = directives;
    this.filelist_ = entries;
  }

  /**
   * 関連ファイルの一覧を最後まで収集してからプロジェクトを返す．
   * @param file 探索の起点ファイルのURI．nullなら現在のアクティブエディタの文書を使う．
   * @param options 処理の動作を指定するオプション．省略時は{}．
   * @returns メインファイル，クラス設定，指示，および関連ファイルを確定したプロジェクト．Promiseで返す．
   */
  public static async create(file: vscode.Uri | null, options: ProjectReadOptions = {}): Promise<LaTeXProject> {
    return LaTeXProject.request(options, async request => {
      const description = await LaTeXProject.generate_project(request, file);
      const entries = await LaTeXProject.collectProjectEntries(request, description[1]);
      return new LaTeXProject(description, entries);
    });
  }

  /**
   * メインファイルから文書クラスとオプションを読み取る．
   * @param request 今回の探索の有効世代，読み取り設定，および依存先の記録．
   * @param main ビルドの起点となるメインTeXファイルのURI．
   * @returns 文書クラス名とクラスオプションの2要素の組．Promiseで返す．
   */
  private static async get_class_option_from_main(request: ProjectRequest, main: vscode.Uri): Promise<[string, string]> {
    const parsed = await LaTeXProject.readSource(request, main);
    return LaTeXProject.get_classfile(parsed.syntax);
  }
  /**
   * 要求の依存先として登録しながらファイルの存在を確認する．
   * @param request 今回の探索の有効世代，読み取り設定，および依存先の記録．
   * @param file 対象ファイルのURI．
   * @returns ファイルが存在する場合はtrue．Promiseで返す．
   */
  private static async fileExists(request: ProjectRequest, file: vscode.Uri): Promise<boolean> {
    LaTeXProject.dependency(request, file);
    let exists = false;
    try {
      const stat = await vscode.workspace.fs.stat(file);
      exists = (stat.type & vscode.FileType.File) !== 0;
    } catch { /* 利用できない候補はメインファイルとして選択しない． */ }
    LaTeXProject.checkRequest(request);
    return exists;
  }
  /**
   * ソースのマジックコメントからメインファイルを求める．
   * @param file 対象ファイルのURI．
   * @param directives ソース中の%#指示をキーから本文へ対応付けた表．
   * @returns 指示されたメインファイルのURI．指示がなければundefined．Promiseで返す．
   */
  private static async mainFromMagic(file: vscode.Uri, directives: {
    /** %#指示のキーから指示本文への対応． */
    [key: string]: string
  }): Promise<vscode.Uri | undefined> {
    const name = directives.main?.trim();
    if (!name) { return undefined; }
    const main = vscode.Uri.file(path.resolve(path.dirname(file.fsPath), name));
    return main;
  }

  /**
   * 現在のファイルをメイン候補として返す．
   * @param file 対象ファイルのURI．
   * @returns 渡された現在のファイルのURI．Promiseで返す．
   */
  private static async mainFromCurrentFile(file: vscode.Uri): Promise<vscode.Uri | undefined> {
    return file;
  }

  /**
   * 関連ファイルの収集を追加で行わず，メインファイルのURIを解決する．
   * @param file 探索の起点ファイルのURI．nullなら現在のアクティブエディタの文書を使う．
   * @param options 処理の動作を指定するオプション．省略時は{}．
   * @returns 設定された優先順で検出したメインTeXファイルのURI．Promiseで返す．
   */
  public static async resolveMainFile(file: vscode.Uri | null, options: ProjectReadOptions = {}): Promise<vscode.Uri> {
    return LaTeXProject.request(options, async request => (await LaTeXProject.generate_project(request, file))[1]);
  }

  /**
   * 起点ファイルからメインファイル，クラス，および指示を検出する．
   * @param request 今回の探索の有効世代，読み取り設定，および依存先の記録．
   * @param f 探索の起点ファイルのURI．nullなら現在のアクティブエディタの文書を使う．
   * @returns 起点，メインURI，クラス名，オプション，および指示の組．Promiseで返す．
   */
  private static async generate_project(request: ProjectRequest, f: vscode.Uri | null): Promise<ProjectDescription> {
    const file = f ?? vscode.window.activeTextEditor?.document.uri;
    if (!file) { throw new Error("Cannot get the current file"); }
    const parsed = await LaTeXProject.readSource(request, file);
    const directives = LaTeXProject.parse_percent_sharp_doc(parsed.syntax);
    const main = await LaTeXProject.discoverMain(request, file, directives, request.order);
    const [cls, options] = await LaTeXProject.get_class_option_from_main(request, main);
    return [f, main, cls, options, directives];
  }

  /**
   * 指定された優先順にメインファイルの検出方法を試す．
   * @param request 今回の探索の有効世代，読み取り設定，および依存先の記録．
   * @param file 対象ファイルのURI．
   * @param directives ソース中の%#指示をキーから本文へ対応付けた表．
   * @param order メインファイルの検出方法を試す優先順．
   * @returns 最初に決まったメインTeXファイルのURI．Promiseで返す．
   */
  private static async discoverMain(request: ProjectRequest, file: vscode.Uri, directives: {
    /** %#指示のキーから指示本文への対応． */
    [key: string]: string
  }, order: readonly string[]): Promise<vscode.Uri> {
    // 探索方法をデータとして定義し，mainFileOrderの変更で検証や結果の組み立てを重複させない．
    const strategies = new Map<string, () => Promise<vscode.Uri | undefined>>([
      ['magic', () => LaTeXProject.mainFromMagic(file, directives)],
      ['guess', () => LaTeXProject.guessMainFile(request, file)],
      ['current', () => LaTeXProject.mainFromCurrentFile(file)]
    ]);
    for (const name of order) {
      const main = await strategies.get(name)?.();
      if (main && await LaTeXProject.fileExists(request, main)) { return main; }
    }
    throw new Error("The main cannot be found.");
  }

  // [class,option]を返す
  /**
   * 共有構文から文書クラス名とクラスオプションを抽出する．
   * @param source 読み取りと範囲の基準となる共有LaTeXソース．
   * @returns 文書クラス名とクラスオプションの2要素の組．
   */
  private static get_classfile(source: string | LaTeXParser.SourceScanner | LaTeXParser.LaTeXSource): [string, string] {
    const syntax = source instanceof LaTeXParser.LaTeXSource ? source : new LaTeXParser.LaTeXSource(source);
    const scanner = syntax.sourceScanner;
    const parsed = syntax.documentParser;
    const declaration = parsed.declarations.find(item => item.kind === 'documentClass' && item.complete);
    if (!declaration?.argument) { return ["", ""]; }
    const name = scanner.textWithoutComments(declaration.argument.contentStart, declaration.argument.contentEnd)?.trim() ?? '';
    const options = declaration.options;
    return [name, options ? scanner.textWithoutComments(options.contentStart, options.contentEnd) ?? '' : ''];
  }

  /**
   * 親ディレクトリを調べて現在ファイルを含むメインファイルを推測する．
   * @param request 今回の探索の有効世代，読み取り設定，および依存先の記録．
   * @param file 対象ファイルのURI．
   * @returns 候補となるメインURI．見つからなければundefined．Promiseで返す．
   */
  private static async guessMainFile(request: ProjectRequest, file: vscode.Uri): Promise<vscode.Uri | undefined> {
    const [cls] = await LaTeXProject.get_class_option_from_main(request, file);
    if (cls) { return file; }
    let directory = vscode.Uri.file(path.dirname(file.fsPath));
    // すべての親ディレクトリを調べる．文書クラスを持ち，現在ファイルを再帰的に読み込むものだけを候補として採用する．
    while (true) {
      const main = await LaTeXProject.findMainInDirectory(request, directory, file);
      if (main) { return main; }
      const parent = vscode.Uri.file(path.dirname(directory.fsPath));
      if (Workspace.uriKey(parent) === Workspace.uriKey(directory)) { break; }
      directory = parent;
    }
    return undefined;
  }

  /**
   * ディレクトリ内のTeXファイルから対象ファイルを含むメイン候補を探す．
   * @param request 今回の探索の有効世代，読み取り設定，および依存先の記録．
   * @param directory 処理の基準となるディレクトリ．
   * @param target 処理または表示の対象．
   * @returns 対象を参照するメイン候補のURI．なければundefined．Promiseで返す．
   */
  private static async findMainInDirectory(request: ProjectRequest, directory: vscode.Uri, target: vscode.Uri): Promise<vscode.Uri | undefined> {
    // このディレクトリ直下の文書だけを候補とし，各候補からの再帰的な読み込みはcollectProjectFilesで確認する．
    try {
      LaTeXProject.checkRequest(request);
      const key = Workspace.uriKey(directory);
      if (!request.directories.has(key)) {
        request.directories.add(key);
        request.options.onDirectory?.(directory);
      }
      const files = await vscode.workspace.fs.readDirectory(directory);
      LaTeXProject.checkRequest(request);
      for (const file of files) {
        if (file[1] === vscode.FileType.Directory) { continue; }
        if (path.extname(file[0]).toLowerCase() !== ".tex") { continue; }
        const filepath = vscode.Uri.joinPath(directory, file[0]);
        try {
          const [cls] = await LaTeXProject.get_class_option_from_main(request, filepath);
          if (!cls) { continue; }
          const projectFiles = await LaTeXProject.collectProjectFiles(request, filepath);
          if (projectFiles.some((projectFile) => Workspace.uriKey(projectFile) === Workspace.uriKey(target))) {
            return filepath;
          }
        } catch (error) {
          if (error instanceof vscode.CancellationError) { throw error; }
          continue;
        }
      }
      return undefined;

    }
    catch (error) {
      if (error instanceof vscode.CancellationError) { throw error; }
      return undefined;
    }
  }

  /**
   * 入力・読み込み宣言をたどり，関連ファイルを探索順に収集する．
   * @param request 今回の探索の有効世代，読み取り設定，および依存先の記録．
   * @param main ビルドの起点となるメインTeXファイルのURI．
   * @returns 重複を除いた関連URI，参照種別，および存在確認結果の配列．Promiseで返す．
   */
  private static async collectProjectEntries(request: ProjectRequest, main: vscode.Uri): Promise<ProjectFileEntry[]> {
    const entries: ProjectFileEntry[] = [];
    const listed = new Set<string>();
    const ancestors = new Set<string>();
    const macros = new MacroState();
    const directory = vscode.Uri.file(path.dirname(main.fsPath));
    let visits = 0;
    const visit = async (entry: IncludedFile, knownExists?: boolean): Promise<void> => {
      LaTeXProject.checkRequest(request);
      const key = Workspace.uriKey(entry.uri);
      LaTeXProject.dependency(request, entry.uri);
      const exists = knownExists ?? await LaTeXProject.fileExists(request, entry.uri);
      if (!listed.has(key)) {
        listed.add(key);
        entries.push({ ...entry, exists });
      }
      if (!exists || ancestors.has(key)) { return; }
      if (++visits > 10000 || ancestors.size >= 256) { throw new Error('Too many nested LaTeX inputs'); }
      let parsed: ProjectSource;
      try {
        parsed = await LaTeXProject.readSource(request, entry.uri);
      } catch (error) {
        if (error instanceof vscode.CancellationError) { throw error; }
        return;
      }
      ancestors.add(key);
      try {
        const syntax = parsed.syntax;
        const scanner = syntax.sourceScanner;
        const definitions = new Map(syntax.definitionParser.definitions.map(definition => [definition.start, definition]));
        const hidden = syntax.definitionParser.consumedRanges;
        let hiddenIndex = 0;
        let cursor = 0;
        for (const command of scanner.commands) {
          if (command.start < cursor) { continue; }
          // 通常のグループ内のローカル定義は，ファイルの読み込みをまたいでも引き継ぐ．
          for (let offset = cursor; offset < command.start; offset++) {
            if (scanner.maskedSource[offset] === '{') { macros.pushScope(); }
            else if (scanner.maskedSource[offset] === '}') { macros.popScope(); }
          }
          cursor = command.end;
          while (hiddenIndex < hidden.length && hidden[hiddenIndex].end <= command.start) { hiddenIndex++; }
          const definition = definitions.get(command.start);
          if (definition) {
            macros.apply(syntax, definition);
            cursor = Math.max(cursor, definition.consumedEnd);
            continue;
          }
          if (hidden[hiddenIndex]?.start <= command.start && command.start < hidden[hiddenIndex].end) {
            cursor = Math.max(cursor, hidden[hiddenIndex].end);
            continue;
          }
          if (command.name === 'begingroup' || command.name === 'bgroup') { macros.pushScope(); }
          else if (command.name === 'endgroup' || command.name === 'egroup') { macros.popScope(); }
          else if (command.name === 'begin' || command.name === 'end') {
            const argument = syntax.argumentScanner.readArgument(command.end);
            if (argument?.complete) {
              cursor = argument.end;
              if (command.name === 'begin') { macros.pushScope(); }
              else { macros.popScope(); }
            }
          } else if (command.name === 'input' || command.name === 'include') {
            let resolved = await resolveInputFile(syntax, command as InputToken, directory, name => macros.lookup(name));
            LaTeXProject.checkRequest(request);
            const fresh = resolved.checkedCandidates.filter(candidate => LaTeXProject.dependency(request, candidate.uri));
            // 依存先の通知を受けた側は，最初の存在確認後に監視を登録する場合がある．その呼び出しだけは監視開始までの隙間を再確認し，通常の読み取りでは確認を繰り返さない．
            if (request.options.onDependency && (await Promise.all(fresh.map(async candidate =>
              (await LaTeXProject.fileExists(request, candidate.uri)) !== candidate.exists))).some(Boolean)) {
              resolved = await resolveInputFile(syntax, command as InputToken, directory, name => macros.lookup(name));
              LaTeXProject.checkRequest(request);
              const added = resolved.checkedCandidates.filter(candidate => LaTeXProject.dependency(request, candidate.uri));
              const unstable = await Promise.all(added.map(async candidate =>
                (await LaTeXProject.fileExists(request, candidate.uri)) !== candidate.exists));
              // 存在状態の再確認には回数の上限を設ける．監視の登録中に別の候補が変わった場合は，監視側が次の要求を予約できる．
              if (unstable.some(Boolean)) { throw new vscode.CancellationError(); }
            }
            LaTeXProject.checkRequest(request);
            cursor = Math.max(cursor, resolved.consumedEnd);
            const target = resolved.status === 'resolved' ? resolved.uri
              : resolved.status === 'missing' ? resolved.checkedCandidates[0]?.uri : undefined;
            if (target) {
              await visit({ uri: target, type: command.name === 'input'
                ? LaTeXProject.LaTeXFileType.input : LaTeXProject.LaTeXFileType.include }, resolved.status === 'resolved');
            }
          }
        }
        for (let offset = cursor; offset < syntax.source.length; offset++) {
          if (scanner.maskedSource[offset] === '{') { macros.pushScope(); }
          else if (scanner.maskedSource[offset] === '}') { macros.popScope(); }
        }
      } finally {
        ancestors.delete(key);
      }
    };
    await visit({ uri: main, type: LaTeXProject.LaTeXFileType.main });
    return entries;
  }

  /**
   * 関連ファイルの探索結果から存在するファイルを取り出す．
   * @param request 今回の探索の有効世代，読み取り設定，および依存先の記録．
   * @param main ビルドの起点となるメインTeXファイルのURI．
   * @returns 存在する関連ファイルのURIの配列．Promiseで返す．
   */
  private static async collectProjectFiles(request: ProjectRequest, main: vscode.Uri): Promise<vscode.Uri[]> {
    const entries = await LaTeXProject.collectProjectEntries(request, main);
    return entries.filter(entry => entry.exists).map(entry => entry.uri);
  }

  /**
   * ソース先頭付近の%#指示を読み取る．
   * @param source 読み取りと範囲の基準となる共有LaTeXソース．
   * @returns 指示のキーから本文への対応表．
   */
  private static parse_percent_sharp_doc(source: string | LaTeXParser.LaTeXSource): {
    /** %#指示のキーから指示本文への対応． */
    [key: string]: string
  } {
    // リテラルを除き，元の文書の行全体のコメントを読む．引用符・内部の空白・%は利用側で意味を持つため，そのまま保持する．前後のスペースとタブだけを除去する．
    const txt = typeof source === 'string' ? source : source.source;
    if (!txt.includes('%#')) { return {}; }
    const scanner = (typeof source === 'string' ? new LaTeXParser.LaTeXSource(source) : source).sourceScanner;
    const directives = new Map<string, string>();
    const directive = /^%#(!|[^ \t\r\n]+)([^\r\n]*)$/;
    for (const range of scanner.ignoredRanges) {
      if (range.kind !== 'comment' || !txt.startsWith('%#', range.start)) { continue; }
      let prefixStart = range.start;
      while (prefixStart > 0 && (txt[prefixStart - 1] === ' ' || txt[prefixStart - 1] === '\t')) {
        prefixStart--;
      }
      // 行頭の字下げは許可する．BOMはファイルの先頭だけで許可する．
      if (prefixStart > 0 && txt[prefixStart - 1] !== '\r' && txt[prefixStart - 1] !== '\n'
        && !(prefixStart === 1 && txt[0] === '\uFEFF')) { continue; }
      const match = directive.exec(txt.slice(range.start, range.end));
      if (!match) { continue; }
      const value = match[2];
      let valueStart = 0;
      let valueEnd = value.length;
      while (valueStart < valueEnd && (value[valueStart] === ' ' || value[valueStart] === '\t')) {
        valueStart++;
      }
      while (valueEnd > valueStart && (value[valueEnd - 1] === ' ' || value[valueEnd - 1] === '\t')) {
        valueEnd--;
      }
      // !は接頭辞なので，%#!engine argsと%#! engine argsは同じ指示として扱う．
      directives.set(match[1].toLowerCase(), value.slice(valueStart, valueEnd));
    }
    // オブジェクトのプロパティ名と一致するものも含め，不明なキーを保持する．同じキーは最後の値を採用する．
    return Object.fromEntries(directives);
  }

}
