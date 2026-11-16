import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import LaTeXProject from '../../project/LaTeXProject';
import Log from '../../log';
import Process from '../Process';
import Config, { CompileProgram, CompileProgramSettings, LaTeXEngineSettings } from '../../Config';
import { singleProgramFromDirective } from '../BuildSecurity';
import * as Workspace from '../../workspace';
import { SourceScanner, splitclist } from '../../latex-parser';
import KpsewhichResolver, { programName } from '../../project/KpsewhichResolver';
import { XMLParser } from 'fast-xml-parser';
import analyzeLaTeXLog from './LaTeXLogAnalyzer';

type XMLValue = string | {
  /** XMLの子要素名から，その内容への対応． */
  [name: string]: XMLValue
} | XMLValue[];
type PipelineDiagnostics = [vscode.Uri, vscode.Diagnostic[]][];
type AuxiliaryTool = 'bibliography' | 'index';

interface IndexFiles {
  /** 索引の出力ファイルのパス． */
  readonly output: string;
  /** 使用する文献スタイルまたは索引スタイルの参照． */
  readonly styles: readonly string[];
  /** 索引処理で使用する辞書ファイルの参照． */
  readonly dictionaries: readonly string[];
}

interface BibliographyInfo {
  /** auxファイルに現れた引用キー． */
  readonly citations: string[];
  /** auxファイルのbibcite宣言で定義済みとなっている引用キーの集合． */
  readonly entries: Set<string>;
  /** auxファイルに現れた文献データベース名． */
  readonly databases: string[];
  /** 使用する文献スタイルまたは索引スタイルの参照． */
  readonly styles: string[];
  /** 文献処理の再実行判定に使用する入力の識別文字列． */
  readonly signature: string;
}

/** 1つの段階で読み取った補助ファイル．取得後は内容や比較基準を書き換えない． */
interface AuxiliaryFiles {
  /** LaTeXの再実行判定に使う，ファイルパスと本文の対応．欠落はnull． */
  readonly latex: ReadonlyMap<string, string | null>;
  /** AUXから収集した引用・文献DB・スタイルの宣言． */
  readonly bibliography: BibliographyInfo;
  /** Biberが参照するBCFのパス． */
  readonly bcfPath: string;
  /** BCF本文．欠落または読み取り失敗はnull． */
  readonly bcfText: string | null;
  /** BCFの更新状態．取得できなければundefined． */
  readonly bcfStamp: string | undefined;
  /** run.xmlの本文．欠落または読み取り失敗はnull． */
  readonly runXMLText: string | null;
  /** run.xmlの更新状態．取得できなければundefined． */
  readonly runXMLStamp: string | undefined;
  /** 選択された文献処理のBBL出力情報．欠落はundefined． */
  readonly bbl: fs.BigIntStats | undefined;
  /** IDXのバイト列．欠落または読み取り失敗はnull． */
  readonly idx: Buffer | null;
  /** 選択された索引出力の情報．欠落はundefined． */
  readonly ind: fs.BigIntStats | undefined;
}

/** LaTeXCompileが渡すビルド処理専用の入力．ビルド管理側からは直接渡さない． */
export interface TeXToPDFOptions {
  /** 処理のキャンセル状態を確認するトークン． */
  readonly token?: vscode.CancellationToken;
  /**
   * 現在の処理段階を通知する．
   * @param message 表示する進捗メッセージ．
   * @returns なし．
   */
  onProgress?(message: string): void;
}

/** LaTeXCompileだけが内容を解釈するビルド処理の結果と生成PDF． */
export interface TeXToPDFResult {
  /** succeededは成功，failedは失敗，cancelledは中止を表す． */
  readonly outcome: 'succeeded' | 'failed' | 'cancelled';
  /** infoは情報，warningは警告，errorは失敗を表す． */
  readonly severity: 'info' | 'warning' | 'error';
  /** 利用者へ表示するメッセージ． */
  readonly message: string;
  /** Problemsへ公開する診断情報． */
  readonly diagnostics?: [vscode.Uri, vscode.Diagnostic[]][];
  /** 今回の実行で生成したPDFのURI． */
  readonly pdfs?: vscode.Uri[];
}

/**
 * 補助ファイルが安定するまでTeX・文献・索引・PDF変換を実行する．補助ファイルの以前の本文を比較用に保存し，再実行する段階を判定する．
 */
export default class TeXToPDF {
  /** 診断，SyncTeX，および非対話実行のために必ず加えるLaTeX引数． */
  private static readonly requiredLaTeXArgs = [
    '-interaction=nonstopmode', '-halt-on-error', '-synctex=1', '-file-line-error'
  ];
  /** ビルド対象のメインファイルと関連ファイルの情報． */
  LaTeXProject: LaTeXProject;
  /** メインと読み込み先のTeXファイルのパス．対応する補助ファイルの比較に使用する． */
  file_list: string[] = [];
  /** 再実行の判定に使用する補助ファイルの拡張子． */
  readonly extensions = [".aux", ".toc", ".lot", ".lof"];
  /** TeXToPDFのオプション名から指定値への対応表． */
  options: {
    /** TeXToPDFオプションの名前から指定された文字列値への対応． */
    [key: string]: string
  } = {};

  /**
   * プロジェクトと指定オプションから，要求内だけで使用するパイプラインを構築する．
   * @param proj ビルド対象のメインファイルと関連ファイルの情報．
   * @param option セミコロン区切りのTeXToPDFオプション．未指定なら空の設定．
   * @returns 新しいTeXToPDFインスタンス．外部プログラムはまだ実行しない．
   */
  constructor(proj: LaTeXProject, option: string | undefined) {
    this.LaTeXProject = proj;
    if (option !== undefined && option !== "") {
      let opt = option.split(";");
      for (const s of opt) {
        let r = s.indexOf("=");
        if (r === -1) { this.options[s] = ""; }
        else { this.options[s.substring(0, r)] = s.substring(r + 1); }
      }
    }
    this.file_list.push(this.LaTeXProject.mainfile.fsPath);
    for (const file of this.LaTeXProject.filelist) {
      if (file.type === LaTeXProject.LaTeXFileType.include) {
        this.file_list.push(file.uri.fsPath);
      }
    }
  }

  /**
   * クラス名・クラスオプションと設定からLaTeXエンジンを選ぶ．引数はない．
   * @returns 最初に一致した規則のエンジン名，または設定された既定値．
   */
  private select_latex_engine(): string {
    if (Config.latexEngineSelection() === 'source') {
      const scanner = new SourceScanner(this.LaTeXProject.classoption);
      const options = new Set(splitclist(scanner).map(range =>
        scanner.textWithoutComments(range.start, range.end)?.trim() ?? ''));
      for (const rule of Config.latexEngineRules()) {
        if ((!rule.classes || rule.classes.includes(this.LaTeXProject.classfile))
          && (rule.options ?? []).every(option => options.has(option))) {
          return rule.engine;
        }
      }
    }
    return Config.latexEngine();
  }

  /**
   * 設定とソース指示をまとめ，必須引数を含むLaTeXコマンドを作る．引数はない．
   * @returns 実行ファイル，引数，および任意の出力形式設定．未指定時の変換要否は生成物から判定する．
   */
  private make_latex_command(): LaTeXEngineSettings {
    const directive = this.LaTeXProject.percent_sharp('!')?.trim();
    const explicitProgram = directive ? singleProgramFromDirective(directive) : undefined;
    const engine = explicitProgram ?? this.select_latex_engine();
    // ソース指示の実行ファイル名はそのまま使用する．BuildSecurityで検証済みのプログラムを設定によって別のものへ差し替えない．
    const settings = Config.latexEngineSettings(engine, explicitProgram);
    const directiveArgs = (this.LaTeXProject.percent_sharp('t2dopt') ?? '').split(' ').filter(s => s.length > 0);
    const args = [...TeXToPDF.requiredLaTeXArgs, ...settings.args, ...directiveArgs];
    return { ...settings, args };
  }

  /**
   * 補助プログラムの設定に，ソース指示による実行ファイルの指定を反映する．
   * @param key 文献処理・索引処理・PDF変換の設定キー．
   * @returns 実行ファイルと追加引数．
   */
  private make_program_command(key: CompileProgram): CompileProgramSettings {
    return Config.programSettings(key, this.LaTeXProject.percent_sharp(key)?.trim());
  }

  /**
   * 補助ファイルが安定するまで各段階を実行し，要求内の結果をまとめる．
   * 文献処理を優先し，文献・索引処理の後には必ずLaTeXを実行する．
   * 比較基準は要求内で保持し，各プログラムの実行後に実行前のスナップショットで更新する．
   * PDF変換は出力形式の設定を優先し，未指定時はビルド開始時からのPDF・DVIの更新で判定する．
   * @param options キャンセルトークンと進捗通知先．省略時は通知・外部キャンセルを使わない．
   * @returns 成否，警告，診断情報，および今回生成したPDFを含む結果のPromise．
   */
  async build(options?: TeXToPDFOptions): Promise<TeXToPDFResult> {
    const helperDiagnostics: PipelineDiagnostics = [];
    const logPath = TeXToPDF.change_extension(this.LaTeXProject.mainfile.fsPath, '.log');
    const previousLogStamp = this.fileStamp(logPath);
    let started = false;
    try {
      const warnings: string[] = [];
      const pdf = vscode.Uri.file(TeXToPDF.change_extension(this.LaTeXProject.mainfile.fsPath, '.pdf'));
      const previousPDFStamp = this.fileStamp(pdf.fsPath);
      const dvi = TeXToPDF.change_extension(this.LaTeXProject.mainfile.fsPath, '.dvi');
      this.checkCancellation(options);
      options?.onProgress?.('Preparing build…');
      // 設定は要求ごとに一度だけ取得する．途中の設定変更は次の要求へ反映する．
      const latex = this.make_latex_command();
      const previousDVIStamp = latex.output === undefined ? this.fileStamp(dvi) : undefined;
      const bibliography = this.make_program_command('bibtex');
      const index = this.make_program_command('makeindex');
      const converter = this.make_program_command('dvipdf');
      const directory = path.dirname(this.LaTeXProject.mainfile.fsPath);
      const base = path.basename(this.LaTeXProject.mainfile.fsPath);
      const maximum = Config.maxLaTeXRuns();
      const start = this.read_auxiliary_files(bibliography, index);
      let previousLaTeX = start;
      let previousBib: AuxiliaryFiles | undefined;
      let previousIndex: AuxiliaryFiles | undefined;
      let current = start;
      let latexRuns = 0;
      let forcelatex = true;
      let bibFailed = false;
      let indexFailed = false;

      /**
       * 次のLaTeXと，その前提となる補助処理を開始できるか確認する．引数はない．
       * @returns なし．キャンセル時または実行回数上限に達した場合は例外．
       */
      const checkLaTeXLimit = (): void => {
        this.checkCancellation(options);
        if (maximum > 0 && latexRuns >= maximum) {
          throw new Error(`Maximum number of LaTeX runs (${maximum}) exceeded.`);
        }
      };

      while (true) {
        this.checkCancellation(options);
        started = true;
        if (!forcelatex && !bibFailed && await this.bib_check(bibliography, start, previousBib, current, options)) {
          checkLaTeXLimit();
          bibFailed = !await this.runOptionalTool(bibliography, TeXToPDF.remove_extension(base), directory,
            'bibliography', warnings, helperDiagnostics, options);
          previousBib = current;
          forcelatex = true;
        } else if (forcelatex || this.latex_check(previousLaTeX, current)) {
          checkLaTeXLimit();
          await this.runTool(latex, TeXToPDF.change_extension(base, '.tex'), directory,
            `Running LaTeX (pass ${++latexRuns})…`, options);
          previousLaTeX = current;
          forcelatex = false;
        } else if (!indexFailed && await this.makeindex_check(index, start, previousIndex, current, options)) {
          checkLaTeXLimit();
          indexFailed = !await this.runOptionalTool(index, TeXToPDF.remove_extension(base), directory,
            'index', warnings, helperDiagnostics, options);
          previousIndex = current;
          forcelatex = true;
        } else { break; }
        current = this.read_auxiliary_files(bibliography, index);
      }
      // 明示設定を優先し，未指定時だけ今回更新された生成物から変換の要否を判定する．
      let convertDVI = latex.output === 'dvi';
      if (latex.output === undefined) {
        const PDFStamp = this.fileStamp(pdf.fsPath);
        const DVIStamp = this.fileStamp(dvi);
        const pdfUpdated = PDFStamp !== undefined && PDFStamp !== previousPDFStamp;
        const dviUpdated = DVIStamp !== undefined && DVIStamp !== previousDVIStamp;
        convertDVI = !pdfUpdated && dviUpdated;
      }
      if (convertDVI) {
        await this.runTool(converter, TeXToPDF.change_extension(base, '.dvi'), directory,
          'Creating PDF…', options);
      }
      this.checkCancellation(options);
      const currentPDFStamp = this.fileStamp(pdf.fsPath);
      const producedPDF = currentPDFStamp !== undefined && currentPDFStamp !== previousPDFStamp;
      if (!producedPDF) { warnings.push('No new PDF was produced.'); }
      if (this.fileStamp(logPath) !== previousLogStamp) {
        try {
          const latexDiagnostics = await TeXToPDF.analyze_errors(this.LaTeXProject.mainfile);
          helperDiagnostics.push(...latexDiagnostics);
          if (latexDiagnostics.some(([, entries]) => entries.some(entry => entry.severity === vscode.DiagnosticSeverity.Warning))) {
            warnings.push('LaTeX reported warnings.');
          }
        } catch (analysisError) { Log.log(`Unable to read build diagnostics: ${String(analysisError)}`); }
      }
      this.checkCancellation(options);
      return {
        outcome: 'succeeded', severity: warnings.length ? 'warning' : 'info',
        message: warnings.length ? `Build succeeded with warnings: ${warnings.join(' ')}` : 'Build succeeded.',
        diagnostics: helperDiagnostics, pdfs: producedPDF ? [pdf] : []
      };
    } catch (error) {
      if (options?.token?.isCancellationRequested || error instanceof vscode.CancellationError) {
        return { outcome: 'cancelled', severity: 'info', message: 'Build cancelled.' };
      }
      const message = error instanceof Error ? error.message : String(error);
      Log.error(message);
      let diagnostics: PipelineDiagnostics | undefined = helperDiagnostics.length ? [...helperDiagnostics] : undefined;
      // 内容が変わっていないログは以前のビルドのもので，今回の起動失敗のログではない．
      if (started && this.fileStamp(logPath) !== previousLogStamp) {
        try {
          const latexDiagnostics = await TeXToPDF.analyze_errors(this.LaTeXProject.mainfile);
          diagnostics = [...helperDiagnostics, ...latexDiagnostics];
        } catch (analysisError) { Log.log(`Unable to read build diagnostics: ${String(analysisError)}`); }
      }
      if (options?.token?.isCancellationRequested) {
        return { outcome: 'cancelled', severity: 'info', message: 'Build cancelled.' };
      }
      return { outcome: 'failed', severity: 'error', message, diagnostics };
    }
  }

  /**
   * 外部プログラムを実行し，起動失敗・異常終了・キャンセルを呼び出し側へ伝える．
   * @param command 実行ファイルと追加引数．
   * @param target 引数の末尾へ追加する対象ファイル名またはジョブ名．
   * @param directory プログラムの作業ディレクトリ．
   * @param message 実行開始時に通知する進捗メッセージ．
   * @param options キャンセルトークンと進捗通知先．
   * @returns 正常終了時に完了するPromise．異常終了やキャンセルでは拒否される．
   */
  private async runTool(command: CompileProgramSettings, target: string, directory: string,
    message: string, options?: TeXToPDFOptions): Promise<void> {
    this.checkCancellation(options);
    options?.onProgress?.(message);
    Log.log(`Executing: ${command.command} ${[...command.args, target].join(' ')}\n   in directory ${directory}`);
    const code = await new Process(command.command, [...command.args, target], directory).execute(options?.token);
    this.checkCancellation(options);
    if (code !== 0) { throw new Error(`${command.command} exited with code ${code}.`); }
  }

  /**
   * 補助プログラムを実行し，失敗を警告とProblems用の診断へ変換する．
   * @param command 実行ファイルと追加引数．
   * @param target 引数の末尾へ追加する対象ファイル名またはジョブ名．
   * @param directory プログラムの作業ディレクトリ．
   * @param kind 文献処理か索引処理かを表す種別．
   * @param warnings 失敗時の警告文を追記する配列．
   * @param diagnostics 失敗時のエラー診断を追記する配列．
   * @param options キャンセルトークンと進捗通知先．
   * @returns 成功ならtrue，継続可能な失敗ならfalseとなるPromise．キャンセルは例外として伝える．
   */
  private async runOptionalTool(command: CompileProgramSettings, target: string, directory: string,
    kind: AuxiliaryTool, warnings: string[], diagnostics: PipelineDiagnostics, options?: TeXToPDFOptions): Promise<boolean> {
    const message = kind === 'index' ? 'Processing index…' : 'Processing bibliography…';
    try { await this.runTool(command, target, directory, message, options); return true; }
    catch (error) {
      this.checkCancellation(options);
      if (error instanceof vscode.CancellationError) { throw error; }
      this.record_tool_failure(kind, command, error, warnings, diagnostics);
      return false;
    }
  }

  /**
   * 位置未特定の補助処理失敗を，警告とメインファイルの代表診断として記録する．
   * @param kind 文献処理か索引処理かを表す種別．
   * @param command 失敗した実行ファイルと引数．
   * @param error 失敗理由を表す例外または値．
   * @param warnings 警告文を追記する配列．
   * @param diagnostics Problemsに返すエラー診断を追記する配列．
   * @returns なし．配列と出力欄へ記録する．
   */
  private record_tool_failure(kind: AuxiliaryTool, command: CompileProgramSettings, error: unknown,
    warnings: string[], diagnostics: PipelineDiagnostics): void {
    const label = kind === 'index' ? 'Index processing' : 'Bibliography processing';
    const reason = error instanceof Error ? error.message : String(error);
    const warning = `${label} failed (${command.command}): ${reason}`;
    warnings.push(warning);
    const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0),
      `${warning} Source location unknown; this entry represents the whole build. See build output for details.`,
      vscode.DiagnosticSeverity.Error);
    diagnostic.code = `${kind}-failed`;
    diagnostics.push([this.LaTeXProject.mainfile, [diagnostic]]);
    Log.log(`Warning: ${warning} Continuing…`);
  }

  /**
   * 要求がキャンセルされていれば，後続処理を止める例外を送出する．
   * @param options 確認対象のキャンセルトークンを含むオプション．
   * @returns なし．未キャンセルならそのまま戻る．
   */
  private checkCancellation(options?: TeXToPDFOptions): void {
    if (options?.token?.isCancellationRequested) { throw new vscode.CancellationError(); }
  }

  /**
   * ファイルの更新・置き換えを識別する更新情報を取得する．
   * @param filename 確認するファイルのパス．
   * @returns 更新時刻・変更時刻・サイズを結合した文字列．取得できなければundefined．
   */
  private fileStamp(filename: string): string | undefined {
    try {
      const stat = fs.statSync(filename, { bigint: true });
      return `${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
    } catch { return undefined; }
  }

  /**
   * 現在の補助ファイルを新しいスナップショットへ読み取る．比較基準や失敗状態は変更しない．
   * @param bibliography BCFの入力先とBBLの出力先を選ぶ文献処理コマンド．
   * @param index INDの出力先を選ぶ索引処理コマンド．
   * @returns 現在の本文・バイト列・出力情報．以前のスナップショットとは共有して書き換えない．
   */
  private read_auxiliary_files(bibliography: CompileProgramSettings, index: CompileProgramSettings): AuxiliaryFiles {
    const latex = new Map<string, string | null>();
    for (const file of this.file_list) {
      for (const extension of this.extensions) {
        const filename = TeXToPDF.change_extension(file, extension);
        if (!latex.has(filename)) { latex.set(filename, this.read_optional(filename)); }
      }
    }
    const main = this.LaTeXProject.mainfile.fsPath;
    const directory = path.dirname(main);
    const biber = programName(bibliography.command) === 'biber';
    let bcfPath = TeXToPDF.change_extension(main, '.bcf');
    if (biber) {
      // BCFは指定ディレクトリ，メインファイルのディレクトリの順に探す．
      const input = this.command_option(bibliography, '--input-directory')
        ?? this.command_option(bibliography, '--output-directory');
      const name = path.basename(bcfPath);
      const candidates = [...new Set([path.resolve(directory, input ?? '.', name), path.join(directory, name)])];
      bcfPath = candidates.find(filename => fs.existsSync(filename)) ?? candidates[0];
    }
    const runXMLPath = TeXToPDF.change_extension(main, '.run.xml');
    const output = biber ? path.resolve(directory, this.command_option(bibliography, '--output-directory') ?? '.') : directory;
    // IDXは文字コード変換せずバイト列として読み，欠落・読み取り失敗はnullにする．
    let idx: Buffer | null;
    try { idx = fs.readFileSync(TeXToPDF.change_extension(main, '.idx')); }
    catch { idx = null; }
    return {
      latex, bibliography: this.bibliography_info(latex), bcfPath,
      bcfText: biber ? this.read_optional(bcfPath) : null,
      bcfStamp: biber ? this.fileStamp(bcfPath) : undefined,
      runXMLText: biber ? this.read_optional(runXMLPath) : null,
      runXMLStamp: biber ? this.fileStamp(runXMLPath) : undefined,
      bbl: this.read_file_info(path.join(output, path.basename(TeXToPDF.change_extension(main, '.bbl')))),
      idx, ind: this.read_file_info(this.index_files(index).output)
    };
  }

  /**
   * ローカルファイルの更新時刻とサイズなどを取得する．
   * @param filename 情報を取得するファイルのパス．
   * @returns ファイルの情報．欠落・読み取り失敗・ディレクトリならundefined．
   */
  private read_file_info(filename: string): fs.BigIntStats | undefined {
    try {
      const info = fs.statSync(filename, { bigint: true });
      return info.isFile() ? info : undefined;
    } catch { return undefined; }
  }

  /**
   * 直前のLaTeX実行前と現在の補助ファイルを，本文で比較する．
   * @param previous 直前のLaTeX実行へ渡したスナップショット．初回実行前は要求開始時の情報．
   * @param current 現在の段階で読み取ったスナップショット．
   * @returns 本文または存在状態に変化があればtrue．比較基準は変更しない．
   */
  private latex_check(previous: AuxiliaryFiles, current: AuxiliaryFiles): boolean {
    return previous.latex.size !== current.latex.size
      || [...current.latex].some(([filename, text]) => previous.latex.get(filename) !== text);
  }

  /**
   * 実行ファイル名に応じてBibTeX系またはBiberのチェックへ振り分ける．
   * @param command 今回使用する文献処理コマンド．
   * @param start 最初のLaTeX実行前のスナップショット．
   * @param previous 前回の文献処理へ渡したスナップショット．未実行ならundefined．
   * @param current 現在の段階で読み取ったスナップショット．
   * @param options 判定の前後に確認するキャンセルトークンを含むオプション．
   * @returns 選択したバックエンドの必要性判定のPromise．
   */
  private bib_check(command: CompileProgramSettings, start: AuxiliaryFiles, previous: AuxiliaryFiles | undefined,
    current: AuxiliaryFiles, options?: TeXToPDFOptions): Promise<boolean> {
    return programName(command.command) === 'biber'
      ? this.biber_check(command, start, previous, current, options)
      : this.bibtex_check(command, start, previous, current, options);
  }

  /**
   * 読み取り済みAUXから，引用と文献・スタイル指定を収集する．
   * @param files LaTeX補助ファイルのパスと本文の対応．
   * @returns 引用キー，解決済みキー，文献名，スタイル名，指定内容の比較用文字列．
   */
  private bibliography_info(files: ReadonlyMap<string, string | null>): BibliographyInfo {
    const citations: string[] = [], databases: string[] = [], styles: string[] = [];
    const entries = new Set<string>();
    const directives: string[] = [];
    for (const file of this.file_list) {
      const text = files.get(TeXToPDF.change_extension(file, '.aux')) ?? '';
      for (const match of text.matchAll(/\\(citation|bibdata|bibstyle)\{([^}]*)\}/g)) {
        const values = match[2].split(',').map(value => value.trim()).filter(Boolean);
        directives.push(JSON.stringify([file, match[1], values]));
        if (match[1] === 'citation') { citations.push(...values); }
        else if (match[1] === 'bibdata') { databases.push(...values); }
        else { styles.push(...values); }
      }
      for (const match of text.matchAll(/\\bibcite\{([^}]*)\}/g)) { entries.add(match[1]); }
    }
    return { citations, entries, databases, styles, signature: JSON.stringify(directives) };
  }

  /**
   * BibTeX系の実行前は鮮度も確認し，実行後は前回実行へ渡した宣言と比較する．
   * @param command BibTeX系の実行ファイルと引数．検索時のプログラム名にも使用する．
   * @param start 最初のLaTeX実行前のスナップショット．
   * @param previous 前回の文献処理へ渡したスナップショット．未実行ならundefined．
   * @param current 現在の段階で読み取ったスナップショット．
   * @param options 依存ファイルの検索前後に確認するキャンセルトークンを含むオプション．
   * @returns 実行が必要ならtrueとなるPromise．比較基準は変更しない．
   */
  private async bibtex_check(command: CompileProgramSettings, start: AuxiliaryFiles, previous: AuxiliaryFiles | undefined,
    current: AuxiliaryFiles, options?: TeXToPDFOptions): Promise<boolean> {
    this.checkCancellation(options);
    const info = current.bibliography;
    let needed = false;
    if (info.databases.length) {
      if (previous !== undefined) {
        needed = info.signature !== previous.bibliography.signature;
      } else {
        needed = !current.bbl || info.signature !== start.bibliography.signature
          || (!info.citations.includes('*') && info.citations.some(key => !info.entries.has(key)));
        if (!needed) {
          const references = [...new Set([
            ...info.databases.map(name => /\.bib$/i.test(name) ? name : `${name}.bib`),
            ...info.styles.map(name => /\.bst$/i.test(name) ? name : `${name}.bst`)
          ])];
          const resolved = await KpsewhichResolver.resolve(this.LaTeXProject.mainfile, references, command.command);
          needed = this.inputs_newer_than_output(resolved.map(uri => uri?.fsPath), current.bbl);
        }
      }
    }
    this.checkCancellation(options);
    return needed;
  }

  /**
   * --name=value形式または--name value形式の補助プログラム引数を読む．
   * @param command 調べる引数を持つコマンド．
   * @param name --input-directoryなど，先頭のハイフンを含むオプション名．
   * @returns 最初に一致した指定の値．指定や値がなければundefined．
   */
  private command_option(command: CompileProgramSettings, name: string): string | undefined {
    const index = command.args.findIndex(arg => arg === name || arg.startsWith(`${name}=`));
    if (index < 0) { return undefined; }
    return command.args[index] === name ? command.args[index + 1] : command.args[index].slice(name.length + 1);
  }

  /**
   * 任意の補助ファイルをUTF-8で読み取る．
   * @param filename 読み取るファイルのパス．
   * @returns ファイルの内容．存在しない場合や読み取れない場合はnull．
   */
  private read_optional(filename: string): string | null {
    try { return fs.readFileSync(filename, 'utf8'); } catch { return null; }
  }

  /**
   * 名前空間に依存しない要素名で，生成されたXMLを検証・解析する．
   * @param text 解析するXML文字列．
   * @returns 属性と文字列の値を保持した解析結果．不正なXMLでは例外を送出する．
   */
  private parse_xml(text: string): XMLValue {
    return new XMLParser({ ignoreAttributes: false, removeNSPrefix: true,
      parseTagValue: false, parseAttributeValue: false }).parse(text, true) as XMLValue;
  }

  /**
   * 解析済みXMLから，指定名の要素を深さにかかわらず収集する．
   * @param value 探索するXML値．
   * @param name 名前空間の接頭辞を除いた要素名．
   * @returns 一致した要素の値の配列．繰り返し要素も展開する．
   */
  private xml_elements(value: XMLValue, name: string): XMLValue[] {
    if (typeof value === 'string') { return []; }
    if (Array.isArray(value)) { return value.flatMap(child => this.xml_elements(child, name)); }
    return Object.entries(value).flatMap(([key, child]) => key === name
      ? (Array.isArray(child) ? child : [child]) : this.xml_elements(child, name));
  }

  /**
   * 属性の有無にかかわらず，XML要素のテキストを取得する．
   * @param value 文字列，テキストを持つXML要素，またはundefined．
   * @returns 前後の空白を除いたテキスト．テキストがなければ空文字列．
   */
  private xml_text(value: XMLValue | undefined): string {
    if (typeof value === 'string') { return value.trim(); }
    return value && !Array.isArray(value) ? this.xml_text(value['#text']) : '';
  }

  /**
   * 今回更新されたrun.xmlから，有効なBiber実行要求を確認する．
   * @param start 要求開始時に読み取った補助ファイル．
   * @param current 現在の補助ファイル．
   * @returns Biberのactive=1の要求があればtrue．未更新・欠落・解析失敗ならfalse．
   */
  private biber_requested(start: AuxiliaryFiles, current: AuxiliaryFiles): boolean {
    if (current.runXMLStamp === start.runXMLStamp) { return false; }
    const text = current.runXMLText;
    if (text === null) { return false; }
    try {
      return this.xml_elements(this.parse_xml(text), 'external').some(element => typeof element !== 'string'
        && !Array.isArray(element) && element['@_active'] === '1' && this.xml_text(element.generic) === 'biber');
    } catch { return false; }
  }

  /**
   * Biber実行前は実行要求と鮮度を確認し，実行後は前回実行へ渡したBCF本文と比較する．
   * @param command 入出力ディレクトリや設定ファイルの指定を含むBiberコマンド．
   * @param start 要求開始時に読み取った補助ファイル．
   * @param previous 前回の文献処理へ渡したスナップショット．未実行ならundefined．
   * @param current 現在の補助ファイル．
   * @param options キャンセルトークンを含むオプション．
   * @returns 文献生成が必要ならtrueとなるPromise．比較基準は変更しない．
   */
  private async biber_check(command: CompileProgramSettings, start: AuxiliaryFiles, previous: AuxiliaryFiles | undefined,
    current: AuxiliaryFiles, options?: TeXToPDFOptions): Promise<boolean> {
    this.checkCancellation(options);
    const input = current.bcfText;
    const requested = this.biber_requested(start, current);
    let needed = false;
    if (input !== null || requested) {
      if (previous !== undefined) {
        needed = input !== previous.bcfText;
      } else if (requested || current.bcfStamp !== start.bcfStamp) {
        // biblatexを使用しなくなった後に残った，未更新のBCFは無視する．
        needed = requested || !current.bbl || input !== start.bcfText;
        if (!needed && input !== null) { needed = await this.biber_inputs_newer(command, current); }
      }
    }
    this.checkCancellation(options);
    return needed;
  }

  /**
   * BCFのデータソースと明示された設定ファイルの鮮度を確認する．
   * @param command 入力先や設定ファイルの指定を含むBiberコマンド．
   * @param current BCF本文と文献出力の更新情報を含む現在の補助ファイル．
   * @returns 新しい入力，未解決の入力，または安全に判定できない入力があればtrueとなるPromise．
   */
  private async biber_inputs_newer(command: CompileProgramSettings, current: AuxiliaryFiles): Promise<boolean> {
    const directory = path.dirname(this.LaTeXProject.mainfile.fsPath);
    let xml: XMLValue;
    try { xml = this.parse_xml(current.bcfText ?? ''); } catch { return true; }
    const names: string[] = [];
    for (const source of this.xml_elements(xml, 'datasource')) {
      const name = this.xml_text(source);
      if (!name || /^[a-z][a-z\d+.-]*:\/\//i.test(name)
        || (typeof source !== 'string' && !Array.isArray(source)
          && ['1', 'true'].includes(this.xml_text(source['@_glob'])))) { return true; }
      names.push(name);
    }
    const input = this.command_option(command, '--input-directory') ?? this.command_option(command, '--output-directory');
    const directories = [...new Set([...(input ? [path.resolve(directory, input)] : []), directory,
      path.dirname(current.bcfPath)])];
    const paths = names.map(name => {
      const candidates = path.isAbsolute(name) ? [name] : directories.map(dir => path.resolve(dir, name));
      return candidates.find(candidate => { try { return fs.statSync(candidate).isFile(); } catch { return false; } });
    });
    const missing = names.filter((_name, index) => !paths[index]);
    if (missing.length) {
      const results = await KpsewhichResolver.resolve(this.LaTeXProject.mainfile, missing, 'kpsewhich');
      let index = 0;
      paths.forEach((filename, position) => { if (!filename) { paths[position] = results[index++]?.fsPath; } });
    }
    const config = this.command_option(command, '--configfile') ?? this.command_option(command, '-g');
    if (config) { paths.push(path.resolve(directory, config)); }
    return this.inputs_newer_than_output(paths, current.bbl);
  }

  /**
   * 入力の更新時刻を，文献または索引の出力と比較する．
   * @param inputs 解決済みの入力パス．未解決の入力はundefinedで表す．
   * @param output 読み込み済みの出力ファイル情報．欠落・読み取り失敗時はundefined．
   * @returns 新しい入力，未解決の入力，または取得できない更新情報があればtrue．
   */
  private inputs_newer_than_output(inputs: readonly (string | undefined)[], output: fs.BigIntStats | undefined): boolean {
    if (!output) { return true; }
    try {
      return inputs.some(filename => !filename || fs.statSync(filename, { bigint: true }).mtimeNs > output.mtimeNs);
    } catch { return true; }
  }

  /**
   * makeindex形式の短いオプションを，連結指定や繰り返し指定を含めて読む．
   * @param command 調べる実行引数を持つ索引コマンド．
   * @param option ハイフンを除いた1文字のオプション名．
   * @returns 指定順の値の配列．指定がなければ空配列．
   */
  private index_option_values(command: CompileProgramSettings, option: string): string[] {
    const values: string[] = [];
    for (let index = 0; index < command.args.length; index++) {
      const argument = command.args[index];
      if (argument === '--') { break; }
      if (!argument.startsWith('-') || argument.startsWith('--')) { continue; }
      for (let offset = 1; offset < argument.length; offset++) {
        const flag = argument[offset];
        if (!'sdotp'.includes(flag)) { continue; }
        const value = argument.slice(offset + 1) || command.args[++index];
        if (flag === option && value !== undefined) { values.push(value); }
        break;
      }
    }
    return values;
  }

  /**
   * 索引処理の出力先と，明示または既定のスタイル・辞書を取得する．
   * @param command 索引プログラムとその引数．
   * @returns 選択された出力パス，および参照するスタイル名・辞書名．
   */
  private index_files(command: CompileProgramSettings): IndexFiles {
    const main = this.LaTeXProject.mainfile.fsPath;
    const styles = this.index_option_values(command, 's');
    const dictionaries = this.index_option_values(command, 'd');
    const mendex = ['mendex', 'upmendex'].includes(programName(command.command));
    if (mendex && !styles.length && process.env.INDEXDEFAULTSTYLE) { styles.push(process.env.INDEXDEFAULTSTYLE); }
    if (mendex && process.env.INDEXDEFAULTDICTIONARY) { dictionaries.push(process.env.INDEXDEFAULTDICTIONARY); }
    return {
      output: path.resolve(path.dirname(main), this.index_option_values(command, 'o').at(-1)
        ?? TeXToPDF.change_extension(main, '.ind')),
      styles: styles.map(name => path.extname(name) ? name : `${name}.ist`),
      dictionaries
    };
  }

  /**
   * 索引実行前は要求開始時のIDXと出力の鮮度を確認し，実行後は前回実行へ渡したIDXと比較する．
   * @param command スタイル・辞書・出力先の取得に使用する索引コマンド．
   * @param start 要求開始時に読み取った補助ファイル．
   * @param previous 前回の索引処理へ渡したスナップショット．未実行ならundefined．
   * @param current 現在の補助ファイル．
   * @param options 検索後に確認するキャンセルトークンを含むオプション．
   * @returns 索引処理が必要ならtrueとなるPromise．比較基準は変更しない．
   */
  private async makeindex_check(command: CompileProgramSettings, start: AuxiliaryFiles, previous: AuxiliaryFiles | undefined,
    current: AuxiliaryFiles, options?: TeXToPDFOptions): Promise<boolean> {
    this.checkCancellation(options);
    const input = current.idx;
    let needed = false;
    if (input !== null) {
      if (previous !== undefined) {
        needed = previous.idx === null || !input.equals(previous.idx);
      } else {
        needed = start.idx === null || !input.equals(start.idx) || !current.ind;
        if (!needed) {
          // スペース・タブ・CR・LFだけのIDXは空の入力として扱う．
          if (input.every(byte => byte === 9 || byte === 10 || byte === 13 || byte === 32)) {
            needed = current.ind!.size > 0n;
          } else {
            const files = this.index_files(command);
            const styles = await KpsewhichResolver.resolve(this.LaTeXProject.mainfile, files.styles, command.command);
            const dictionaries = await KpsewhichResolver.resolve(this.LaTeXProject.mainfile, files.dictionaries,
              command.command, process.env.INDEXDICTIONARY ?? '$INDEXDICTIONARY');
            needed = this.inputs_newer_than_output([...styles, ...dictionaries].map(uri => uri?.fsPath), current.ind);
          }
        }
      }
    }
    this.checkCancellation(options);
    return needed;
  }


  /**
   * パスの親ディレクトリとベース名を保ち，最後の拡張子を変更する．
   * @param file 元のファイルパス．
   * @param ext ピリオドを含む新しい拡張子．
   * @returns 拡張子を置き換えたファイルパス．
   */
  private static change_extension(file: string, ext: string): string {
    return path.join(path.dirname(file), path.basename(file, path.extname(file)) + ext);
  }

  /**
   * パスの親ディレクトリを保ち，最後の拡張子を取り除く．
   * @param file 元のファイルパス．
   * @returns 最後の拡張子を除いたパス．
   */
  private static remove_extension(file: string): string {
    return path.join(path.dirname(file), path.basename(file, path.extname(file)));
  }

  /**
   * LaTeXログからエラー・警告を解析し，ソースまたはログ上の診断を生成する．
   * @param main ログの場所とLaTeXの実行ディレクトリを決めるメインTeXファイル．
   * @returns 対象URIごとの診断一覧を含むPromise．ログを読めない場合は拒否される．
   */
  static async analyze_errors(main: vscode.Uri): Promise<PipelineDiagnostics> {
    const logfile = vscode.Uri.file(TeXToPDF.change_extension(main.fsPath, '.log'));
    return analyzeLaTeXLog(main, logfile);
  }

}
