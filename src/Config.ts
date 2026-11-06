import * as vscode from 'vscode';
import { DEFAULT_ALLOWED_PROGRAMS } from './compile/BuildSecurity';

export interface LaTeXEngineRule {
  /** 一致対象の文書クラス名．省略時はすべてのクラスを対象とする． */
  classes?: string[];
  /** 一致条件としてすべて必要な文書クラスオプション．省略時は条件を設けない． */
  options?: string[];
  /** 条件に一致した場合に使用するLaTeXエンジン名． */
  engine: string;
}

export type CompileProgram = 'bibtex' | 'makeindex' | 'dvipdf';

export interface CompileProgramSettings {
  /** 起動する実行ファイル名またはパス． */
  command: string;
  /** 実行ファイルへ個別に渡す追加引数．シェル用の引用符は加えない． */
  args: string[];
}

export interface LaTeXEngineSettings extends CompileProgramSettings {
  /** PDF変換の判断に使う出力形式．未指定なら今回の生成物から判定する．エンジン引数は変更しない． */
  output?: 'pdf' | 'dvi';
}

/** vscode-fortex設定への型付きのアクセスを集約する． */
export default class Config {
  /** VS Code設定の共通の名前空間． */
  static readonly config_name = "vscode-fortex";
  /**
   * 指定した拡張機能設定を取得する．
   * @param key 拡張機能の名前空間内の設定キー．
   * @param default_value 設定が存在しない場合の既定値．
   * @returns 設定された値．未設定なら指定された既定値．
   */
  private static get<T>(key: string, default_value: T) : T {
    // 既定値をここで保持し，package.jsonの設定が利用者のプロファイルに反映される前でもコマンドを動かせるようにする．
    return vscode.workspace.getConfiguration(Config.config_name).get<T>(key, default_value);
  }

  /**
   * メインファイルを判定する方法の優先順を取得する．
   * 引数はない．
   * @returns magic（%#main），guess（参照元の探索），current（現在ファイル）を試す設定順．
   */
  public static mainFileOrder(){
    return Config.get<string[]>("mainFileOrder", ["magic", "guess", "current"]);
  }

  /**
   * 補完候補を現在文書から集めるかプロジェクト全体から集めるかを取得する．
   * @param kind 処理対象の種別．
   * @param uri 対象ファイルのURI．
   * @returns documentは現在文書，projectはプロジェクト全体．
   */
  public static completionScope(
    kind: 'label' | 'command' | 'environment',
    uri: vscode.Uri
  ): 'document' | 'project' {
    return vscode.workspace.getConfiguration(Config.config_name, uri)
      .get<string>('completion.' + kind + '.scope', 'document') === 'project' ? 'project' : 'document';
  }

  /**
   * 自動ビルドの実行契機を取得する．
   * 引数はない．
   * @returns onSaveなど，自動ビルドの契機を表す設定値の配列．
   */
  public static compileTrigger(){
    return Config.get<string[]>("compileTrigger", ["onSave"]);
  }

  /**
   * ソース指示からの実行を許可するプログラム名を取得する．
   * 引数はない．
   * @returns 許可された名前の配列．単独の*はすべてのプログラムを許可する．
   */
  public static allowedPrograms(): string[] {
    return Config.get<string[]>('compile.allowedPrograms', [...DEFAULT_ALLOWED_PROGRAMS]);
  }

  /**
   * PDFを開くビューアの設定を取得する．
   * 引数はない．
   * @returns internalは内部ビューア，sumatraはSumatraPDF．
   */
  public static pdfViewer(): "internal" | "sumatra" {
    return Config.get<"internal" | "sumatra">("pdfViewer", "internal");
  }

  /**
   * ビルド後にPDFを自動表示するかを取得する．
   * 引数はない．
   * @returns ビルド後にPDFを開く場合はtrue．
   */
  public static openPdfAfterBuild(): boolean {
    return Config.get<boolean>("openPdfAfterBuild", false);
  }

  /**
   * SumatraPDFの実行ファイル設定を取得する．
   * 引数はない．
   * @returns 指定されたパス．空文字列なら既定の場所を探索する．
   */
  public static sumatraPDFPath(): string {
    return Config.get<string>("sumatraPDF.path", "");
  }

  /**
   * SumatraPDFへ渡す追加引数を取得する．
   * 引数はない．
   * @returns 起動引数の配列．
   */
  public static sumatraPDFArgs(): string[] {
    return Config.get<string[]>("sumatraPDF.args", ["-reuse-instance"]);
  }

  /**
   * SumatraPDFからの逆検索を有効にするかを取得する．
   * 引数はない．
   * @returns 逆検索コマンドを設定する場合はtrue．
   */
  public static sumatraPDFInverseSearchEnabled(): boolean {
    return Config.get<boolean>("sumatraPDF.inverseSearch.enabled", true);
  }

  /**
   * 逆検索で起動するVS Codeの実行ファイル設定を取得する．
   * 引数はない．
   * @returns VS Codeの実行ファイルのパス．
   */
  public static sumatraPDFInverseSearchVSCodePath(): string {
    return Config.get<string>("sumatraPDF.inverseSearch.vscodePath", "");
  }

  /**
   * SyncTeXの実行ファイル設定を取得する．
   * 引数はない．
   * @returns SyncTeXコマンド名または実行ファイルのパス．
   */
  public static syncTeXPath(): string {
    return Config.get<string>("synctex.path", "synctex");
  }

  /**
   * 順検索後にフォーカスを置く場所を取得する．
   * 引数はない．
   * @returns editorはエディタ，viewerはPDFビューア．
   */
  public static syncTeXForwardSearchFocus(): "editor" | "viewer" {
    return Config.get<"editor" | "viewer">("synctex.forwardSearch.focus", "editor");
  }

  /**
   * Kpathsea検索に使用する実行ファイル設定を取得する．
   * 引数はない．
   * @returns kpsewhichのコマンド名または実行ファイルのパス．
   */
  public static kpsewhichPath(): string {
    return Config.get<string>("kpsewhich.path", "kpsewhich");
  }

  /**
   * TeX文書検索に使用する実行ファイル設定を取得する．
   * 引数はない．
   * @returns texdocのコマンド名または実行ファイルのパス．
   */
  public static texdocPath(): string {
    return Config.get<string>("texdoc.path", "texdoc");
  }

  /**
   * 環境本文を追加で字下げするかを取得する．
   * 引数はない．
   * @returns 本文を1段深く字下げする場合はtrue．
   */
  public static environmentIndentContent(): boolean {
    return Config.get<boolean>("environment.indentContent", true);
  }

  /**
   * 補助ファイルを安定させるためのLaTeX実行回数の上限を取得する．
   * 引数はない．
   * @returns 1回のビルドで許可するLaTeX実行回数．
   */
  public static maxLaTeXRuns(): number {
    return Config.get<number>("compile.maxLaTeXRuns", 7);
  }

  /**
   * LaTeXエンジンの選択方法を取得する．
   * 引数はない．
   * @returns sourceはクラス情報による選択，fixedは設定されたエンジンを使用する．
   */
  public static latexEngineSelection(): 'source' | 'fixed' {
    const key = 'compile.latex.engineSelection';
    const selection = Config.get<unknown>(key, 'source');
    if (selection !== 'source' && selection !== 'fixed') {
      return Config.settingError(key, '"source" or "fixed"');
    }
    return selection;
  }

  /**
   * 既定のLaTeXエンジンを取得する．
   * 引数はない．
   * @returns エンジン名または実行ファイルのパス．
   */
  public static latexEngine(): string {
    const key = 'compile.latex.engine';
    return Config.settingString(Config.get<unknown>(key, 'pdflatex'), key);
  }

  /**
   * クラス名とオプションによるエンジン選択規則を設定順に読み取る．
   * 引数はない．
   * @returns 条件と使用するエンジン名を持つ規則を順に列挙するIterable．
   */
  public static *latexEngineRules(): Iterable<LaTeXEngineRule> {
    const key = 'compile.latex.engineRules';
    const rules = Config.get<unknown>(key, [
      { classes: ['article', 'report', 'book'], engine: 'pdflatex' },
      { classes: ['jarticle', 'jreport', 'jbook'], engine: 'platex' },
      { classes: ['ujarticle', 'ujreport', 'ujbook'], engine: 'uplatex' },
      { classes: ['jsarticle', 'jsbook', 'jsreport'], options: ['uplatex'], engine: 'uplatex' },
      { classes: ['jsarticle', 'jsbook', 'jsreport'], engine: 'platex' },
      { classes: ['ltjsarticle', 'ltjsbook', 'ltjsreport'], engine: 'lualatex' },
      { classes: ['jlreq'], options: ['platex'], engine: 'platex' },
      { classes: ['jlreq'], options: ['lualatex'], engine: 'lualatex' },
      { classes: ['jlreq'], engine: 'uplatex' }
    ]);
    if (!Array.isArray(rules)) { return Config.settingError(key, 'an array of rules'); }
    // 規則は使用する時点で検証する．最初の一致より後の規則は使用しない．
    for (const [index, value] of rules.entries()) {
      const ruleKey = `${key}[${index}]`;
      const rule = Config.settingObject(value, ruleKey);
      yield {
        engine: Config.settingString(rule.engine, `${ruleKey}.engine`),
        classes: rule.classes === undefined ? undefined : Config.settingArgs(rule.classes, `${ruleKey}.classes`),
        options: rule.options === undefined ? undefined : Config.settingArgs(rule.options, `${ruleKey}.options`)
      };
    }
  }

  /**
   * エンジンの実行ファイル，引数，および出力形式を取得する．
   * @param engine LaTeXエンジンの名前またはパス．
   * @param commandOverride 設定より優先する実行ファイル名．省略可能．
   * @returns 実行ファイル，追加引数，および任意の出力形式．未登録エンジンは名前を実行ファイルに使い，追加引数は空配列．出力形式の未指定時は生成物から変換要否を判定する．
   */
  public static latexEngineSettings(engine: string, commandOverride?: string): LaTeXEngineSettings {
    const key = 'compile.latex.engines';
    const engines = Config.settingObject(Config.get<unknown>(key, {}), key);
    const engineKey = `${key}.${engine}`;
    const settings = Object.hasOwn(engines, engine) ? Config.settingObject(engines[engine], engineKey) : {};
    const command = commandOverride ?? (settings.command === undefined ? engine
      : Config.settingString(settings.command, `${engineKey}.command`));
    const args = settings.args === undefined ? [] : Config.settingArgs(settings.args, `${engineKey}.args`);
    const output = settings.output;
    if (output !== undefined && output !== 'pdf' && output !== 'dvi') {
      return Config.settingError(`${engineKey}.output`, '"pdf" or "dvi"');
    }
    return { command, args, output };
  }

  /**
   * 文献・索引・PDF変換プログラムの設定を取得する．
   * @param program 補助プログラムの種類または実行名．
   * @param commandOverride 設定より優先する実行ファイル名．省略可能．
   * @returns 検証済みの実行ファイル名と追加引数．
   */
  public static programSettings(program: CompileProgram, commandOverride?: string): CompileProgramSettings {
    const key = `compile.${program}`;
    const defaults: Record<CompileProgram, string> = {
      bibtex: 'upbibtex', makeindex: 'upmendex', dvipdf: 'dvipdfmx'
    };
    const settings = Config.settingObject(Config.get<unknown>(key, {}), key);
    const command = commandOverride ?? (settings.command === undefined ? defaults[program]
      : Config.settingString(settings.command, `${key}.command`));
    const args = settings.args === undefined ? [] : Config.settingArgs(settings.args, `${key}.args`);
    return { command, args };
  }

  /**
   * 不正な設定値について設定名と期待する形式を示す例外を送出する．
   * @param key 拡張機能の名前空間内の設定キー．
   * @param expected 検証時に期待する形式．
   * @returns 正常には戻らない．
   */
  private static settingError(key: string, expected: string): never {
    throw new Error(`Invalid ${Config.config_name}.${key}: expected ${expected}.`);
  }

  /**
   * 設定値がオブジェクトであることを検証する．
   * @param value 変換または検証する値．
   * @param key 拡張機能の名前空間内の設定キー．
   * @returns 検証済みの設定オブジェクト．不正な値なら例外を送出する．
   */
  private static settingObject(value: unknown, key: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return Config.settingError(key, 'an object');
    }
    return value as Record<string, unknown>;
  }

  /**
   * 設定値が空でない文字列であることを検証する．
   * @param value 変換または検証する値．
   * @param key 拡張機能の名前空間内の設定キー．
   * @returns 検証済みの文字列．不正な値なら例外を送出する．
   */
  private static settingString(value: unknown, key: string): string {
    if (typeof value !== 'string' || !value.trim()) {
      return Config.settingError(key, 'a non-empty string');
    }
    return value;
  }

  /**
   * 設定値が文字列の配列であることを検証する．
   * @param value 変換または検証する値．
   * @param key 拡張機能の名前空間内の設定キー．
   * @returns 検証済みの追加引数．不正な値なら例外を送出する．
   */
  private static settingArgs(value: unknown, key: string): string[] {
    if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
      return Config.settingError(key, 'an array of strings');
    }
    return [...value];
  }
}
