import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import LaTeXProject from '../project/LaTeXProject';
import Log from '../log';
import Process from './Process';
import Config, { CompileProgram, CompileProgramSettings } from '../Config';
import { singleProgramFromDirective } from './BuildSecurity';
import * as Workspace from '../workspace';
import { SourceScanner, splitclist } from '../latex-parser';
import KpsewhichResolver, { programName } from '../project/KpsewhichResolver';
import { XMLParser } from 'fast-xml-parser';

type XMLValue = string | { [name: string]: XMLValue } | XMLValue[];
type PipelineDiagnostics = [vscode.Uri, vscode.Diagnostic[]][];
type AuxiliaryTool = 'bibliography' | 'index';

interface IndexFiles {
  readonly output: string;
  readonly styles: readonly string[];
  readonly dictionaries: readonly string[];
}

interface BibliographyInfo {
  readonly citations: string[];
  readonly entries: Set<string>;
  readonly databases: string[];
  readonly styles: string[];
  readonly signature: string;
}

/** Private pipeline inputs supplied by LaTeXCompile, never by the build manager. */
export interface TeXToPDFOptions {
  readonly token?: vscode.CancellationToken;
  /**
   * 現在の処理段階を通知する。
   * @param message 表示する進捗メッセージ。
   * @returns なし。
   */
  onProgress?(message: string): void;
}

/** Pipeline conclusions and PDFs interpreted only by LaTeXCompile. */
export interface TeXToPDFResult {
  readonly outcome: 'succeeded' | 'failed' | 'cancelled';
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
  readonly diagnostics?: [vscode.Uri, vscode.Diagnostic[]][];
  readonly pdfs?: vscode.Uri[];
}

interface LaTeXCommand extends CompileProgramSettings {
  output: 'pdf' | 'dvi';
}

/**
 * Runs the TeX/BibTeX/index/PDF pipeline until auxiliary files stabilize.
 * The previous contents of auxiliary files are snapshots used to decide which
 * stage must run again.
 */
export default class TeXToPDF {
  private static readonly requiredLaTeXArgs = [
    '-interaction=nonstopmode', '-halt-on-error', '-synctex=1', '-file-line-error'
  ];
  LaTeXProject: LaTeXProject;
  // 現在状態によらず必ずLaTeXを実行するフラグ
  forcelatex = false;
  // 文献処理は要求ごとに一度だけ実行する．
  bib = false;
  // status["file"][".aux"]に.auxファイルの中身を保存
  status: { [key: string]: { [key: string]: string | null } } = {};
  file_list: string[] = [];
  readonly extensions = [".aux", ".toc", ".lot", ".lof"];
  options: { [key: string]: string } = {};
  private previousBibliography = '';
  private previousBCF: string | null = null;
  private previousBCFStamp?: string;
  private previousRunXMLStamp?: string;
  private indexInput: Buffer | null = null;
  private indexState: 'pending' | 'succeeded' | 'failed' = 'pending';

  /**
   * プロジェクトと指定オプションから、要求内だけで使用するパイプラインを構築する。
   * @param proj ビルド対象のメインファイルと関連ファイルの情報。
   * @param option セミコロン区切りのTeXToPDFオプション。未指定なら空の設定。
   * @returns 新しいTeXToPDFインスタンス。外部プログラムはまだ実行しない。
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
   * クラス名・クラスオプションと設定からLaTeXエンジンを選ぶ。引数はない。
   * @returns 最初に一致した規則のエンジン名、または設定された既定値。
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
   * 設定とソース指示をまとめ、必須引数を含むLaTeXコマンドを作る。引数はない。
   * @returns 実行ファイル、引数、およびPDF/DVIの出力形式。
   */
  private make_latex_command(): LaTeXCommand {
    const directive = this.LaTeXProject.percent_sharp('!')?.trim();
    const explicitProgram = directive ? singleProgramFromDirective(directive) : undefined;
    const engine = explicitProgram ?? this.select_latex_engine();
    // A source directive always names the executable literally; a configured
    // command must not redirect a program already checked by BuildSecurity.
    const settings = Config.latexEngineSettings(engine, explicitProgram);
    const directiveArgs = (this.LaTeXProject.percent_sharp('t2dopt') ?? '').split(' ').filter(s => s.length > 0);
    const args = [...TeXToPDF.requiredLaTeXArgs, ...settings.args, ...directiveArgs];
    const command = settings.command;
    const output = settings.output ?? (command.startsWith('lua') || command.startsWith('pdf')
      || command.startsWith('xe') || command === 'context' ? 'pdf' : 'dvi');
    return { command, args, output: args.includes('-output-format=dvi') ? 'dvi' : output };
  }

  /**
   * 補助プログラムの設定に、ソース指示による実行ファイルの指定を反映する。
   * @param key 文献処理・索引処理・PDF変換の設定キー。
   * @returns 実行ファイルと追加引数。
   */
  private make_program_command(key: CompileProgram): CompileProgramSettings {
    return Config.programSettings(key, this.LaTeXProject.percent_sharp(key)?.trim());
  }

  /**
   * 補助ファイルが安定するまで各段階を実行し、要求内の結果をまとめる。
   * @param options キャンセルトークンと進捗通知先。省略時は通知・外部キャンセルを使わない。
   * @returns 成否、警告、診断情報、および今回生成したPDFを含む結果のPromise。
   */
  async build(options?: TeXToPDFOptions): Promise<TeXToPDFResult> {
    const warnings: string[] = [];
    const helperDiagnostics: PipelineDiagnostics = [];
    const pdf = vscode.Uri.file(TeXToPDF.change_extension(this.LaTeXProject.mainfile.fsPath, '.pdf'));
    const previousPDF = this.fileStamp(pdf.fsPath);
    const logPath = TeXToPDF.change_extension(this.LaTeXProject.mainfile.fsPath, '.log');
    const previousLog = this.fileStamp(logPath);
    let started = false;
    try {
      this.checkCancellation(options);
      options?.onProgress?.('Preparing build…');
      // Capture settings once; a later change belongs to the next request.
      const latex = this.make_latex_command();
      const bibliography = this.make_program_command('bibtex');
      const index = this.make_program_command('makeindex');
      const converter = this.make_program_command('dvipdf');
      this.read_status(bibliography);
      const directory = path.dirname(this.LaTeXProject.mainfile.fsPath);
      const base = path.basename(this.LaTeXProject.mainfile.fsPath);
      let latexRuns = 1;
      started = true;
      await this.runTool(latex, TeXToPDF.change_extension(base, '.tex'), directory,
        `Running LaTeX (pass ${latexRuns})…`, options);
      while (true) {
        this.checkCancellation(options);
        if (this.latex_check()) {
          const maximum = Config.maxLaTeXRuns();
          if (maximum > 0 && latexRuns >= maximum) {
            throw new Error(`Maximum number of LaTeX runs (${maximum}) exceeded.`);
          }
          latexRuns++;
          await this.runTool(latex, TeXToPDF.change_extension(base, '.tex'), directory,
            `Running LaTeX (pass ${latexRuns})…`, options);
        } else if (!this.bib && await this.bib_check(bibliography, options)) {
          this.bib = true;
          this.forcelatex = true;
          await this.runOptionalTool(bibliography, TeXToPDF.remove_extension(base), directory,
            'bibliography', warnings, helperDiagnostics, options);
        } else if (this.indexState !== 'failed' && await this.makeindex_check(index, options)) {
          const succeeded = await this.runOptionalTool(index, TeXToPDF.remove_extension(base), directory,
            'index', warnings, helperDiagnostics, options);
          this.indexState = succeeded ? 'succeeded' : 'failed';
          this.forcelatex = true;
        } else { break; }
      }
      if (latex.output === 'dvi') {
        await this.runTool(converter, TeXToPDF.change_extension(base, '.dvi'), directory,
          'Creating PDF…', options);
      }
      this.checkCancellation(options);
      const currentPDF = this.fileStamp(pdf.fsPath);
      const producedPDF = currentPDF !== undefined && currentPDF !== previousPDF;
      if (!producedPDF) { warnings.push('No new PDF was produced.'); }
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
      // An unchanged log belongs to an earlier build, not this launch failure.
      if (started && this.fileStamp(logPath) !== previousLog) {
        try {
          const latexDiagnostics: PipelineDiagnostics = (await TeXToPDF.analyze_errors(this.LaTeXProject.mainfile)).map(([uri, range, text]) =>
            [uri, [new vscode.Diagnostic(range, text, vscode.DiagnosticSeverity.Error)]]);
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
   * 外部プログラムを実行し、起動失敗・異常終了・キャンセルを呼び出し側へ伝える。
   * @param command 実行ファイルと追加引数。
   * @param target 引数の末尾へ追加する対象ファイル名またはジョブ名。
   * @param directory プログラムの作業ディレクトリ。
   * @param message 実行開始時に通知する進捗メッセージ。
   * @param options キャンセルトークンと進捗通知先。
   * @returns 正常終了時に完了するPromise。異常終了やキャンセルでは拒否される。
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
   * 補助プログラムを実行し、失敗を警告とProblems用の診断へ変換する。
   * @param command 実行ファイルと追加引数。
   * @param target 引数の末尾へ追加する対象ファイル名またはジョブ名。
   * @param directory プログラムの作業ディレクトリ。
   * @param kind 文献処理か索引処理かを表す種別。
   * @param warnings 失敗時の警告文を追記する配列。
   * @param diagnostics 失敗時のエラー診断を追記する配列。
   * @param options キャンセルトークンと進捗通知先。
   * @returns 成功ならtrue、継続可能な失敗ならfalseとなるPromise。キャンセルは例外として伝える。
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
   * 位置未特定の補助処理失敗を、警告とメインファイルの代表診断として記録する。
   * @param kind 文献処理か索引処理かを表す種別。
   * @param command 失敗した実行ファイルと引数。
   * @param error 失敗理由を表す例外または値。
   * @param warnings 警告文を追記する配列。
   * @param diagnostics Problemsに返すエラー診断を追記する配列。
   * @returns なし。配列と出力欄へ記録する。
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
   * 要求がキャンセルされていれば、後続処理を止める例外を送出する。
   * @param options 確認対象のキャンセルトークンを含むオプション。
   * @returns なし。未キャンセルならそのまま戻る。
   */
  private checkCancellation(options?: TeXToPDFOptions): void {
    if (options?.token?.isCancellationRequested) { throw new vscode.CancellationError(); }
  }

  /**
   * ファイルの更新・置き換えを識別する更新情報を取得する。
   * @param filename 確認するファイルのパス。
   * @returns 更新時刻・変更時刻・サイズを結合した文字列。取得できなければundefined。
   */
  private fileStamp(filename: string): string | undefined {
    try {
      const stat = fs.statSync(filename, { bigint: true });
      return `${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
    } catch { return undefined; }
  }

  /**
   * 最初のLaTeX実行前に、今回の要求で比較するauxファイルの内容を取得する。
   * @param bibliography 今回使用する文献処理コマンド。Biberの入力場所の取得にも使用する。
   * @returns なし。各比較用スナップショットと要求内の索引状態を初期化する。
   */
  private read_status(bibliography: CompileProgramSettings): void {
    // Snapshot auxiliary files before the first pass. Missing files are stored as
    // null so creating or deleting one also counts as a meaningful change.
    //Log.debug_log("Reading current latex file statuses");
    for (const file of this.file_list) {
      if (this.status[file] === undefined) {
        this.status[file] = {};
      }
      for (const ext of this.extensions) {
        let f = TeXToPDF.change_extension(file, ext);
        try {
          this.status[file][ext] = fs.readFileSync(f, "utf8");
          //Log.debug_log(`Read status for ${f} \r\n` + this.status[file][ext]);
        }
        catch {
          this.status[file][ext] = null;
          //Log.debug_log(`Status for ${f} does not exist`);
        }
      }
    }
    this.previousBibliography = this.bibliography_info().signature;
    const control = this.biber_control_file(bibliography);
    this.previousBCF = this.read_optional(control);
    this.previousBCFStamp = this.fileStamp(control);
    this.previousRunXMLStamp = this.fileStamp(TeXToPDF.change_extension(this.LaTeXProject.mainfile.fsPath, '.run.xml'));
    this.indexInput = this.read_index_input();
    this.indexState = 'pending';
  }

  /**
   * 直前のLaTeX実行による補助ファイルの変化と強制実行指定を確認する。引数はない。
   * @returns LaTeXの再実行が必要ならtrue。比較用スナップショットも現在の内容へ更新する。
   */
  private latex_check(): boolean {
    // Refresh snapshots while comparing them; the next call therefore compares
    // against the immediately preceding TeX pass.
    let rv: boolean = false;
    if (this.forcelatex) {
      rv = true;
      this.forcelatex = false;
    }
    //Log.debug_log("Checking LaTeX files for changes");
    for (const file of this.file_list) {
      for (const ext of this.extensions) {
        let f = TeXToPDF.change_extension(file, ext);
        //Log.debug_log("Checking file: " + f + "; ext = " + ext);
        try {
          let txt = fs.readFileSync(f, "utf8");
          if (!rv) {
            if (this.status[file][ext] !== txt) { rv = true; }
          }
          //Log.debug_log(`Checking file ${f}, old content: \n${this.status[file][ext]}\ncurrent content: \n${txt}`);
          this.status[file][ext] = txt;
        }
        catch {
          //Log.debug_log(`Checking file ${f}, old content: \n${this.status[file][ext]}\ncurrent content: \n null (file does not exist)`);
          if (this.status[file][ext] !== null) { rv = true; }
          this.status[file][ext] = null;
        }
      }
    }
    return rv;
  }

  /**
   * 実行ファイル名に応じてBibTeX系またはBiberの必要性を判定する。
   * @param command 今回使用する文献処理コマンド。
   * @param options 判定の前後に確認するキャンセルトークンを含むオプション。
   * @returns 文献処理が必要ならtrueとなるPromise。実行回数の管理は行わない。
   */
  private async bib_check(command: CompileProgramSettings, options?: TeXToPDFOptions): Promise<boolean> {
    this.checkCancellation(options);
    const needed = programName(command.command) === 'biber'
      ? await this.biber_check(command) : await this.bibtex_check(command);
    this.checkCancellation(options);
    return needed;
  }

  /**
   * 現在のAUXスナップショットから、引用と文献・スタイル指定を収集する。引数はない。
   * @returns 引用キー、解決済みキー、文献名、スタイル名、指定内容の比較用文字列。
   */
  private bibliography_info(): BibliographyInfo {
    const citations: string[] = [], databases: string[] = [], styles: string[] = [];
    const entries = new Set<string>();
    const directives: string[] = [];
    for (const file of this.file_list) {
      const text = this.status[file]?.['.aux'] ?? '';
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
   * BibTeX系について、要求開始時の指定と現在の入力・出力を比較する。
   * @param command BibTeX系の実行ファイルと引数。検索時のプログラム名にも使用する。
   * @returns 文献指定の変化、出力の欠落、未解決引用、新しい入力などがあればtrueとなるPromise。
   */
  private async bibtex_check(command: CompileProgramSettings): Promise<boolean> {
    const info = this.bibliography_info();
    if (!info.databases.length) { return false; }
    const bbl = TeXToPDF.change_extension(this.LaTeXProject.mainfile.fsPath, '.bbl');
    if (!fs.existsSync(bbl) || info.signature !== this.previousBibliography) { return true; }
    if (!info.citations.includes('*') && info.citations.some(key => !info.entries.has(key))) { return true; }
    const references = [...new Set([
      ...info.databases.map(name => /\.bib$/i.test(name) ? name : `${name}.bib`),
      ...info.styles.map(name => /\.bst$/i.test(name) ? name : `${name}.bst`)
    ])];
    const resolved = await KpsewhichResolver.resolve(this.LaTeXProject.mainfile, references, command.command);
    return this.inputs_newer_than_output(resolved.map(uri => uri?.fsPath), bbl);
  }

  /**
   * --name=value形式または--name value形式の補助プログラム引数を読む。
   * @param command 調べる引数を持つコマンド。
   * @param name --input-directoryなど、先頭のハイフンを含むオプション名。
   * @returns 最初に一致した指定の値。指定や値がなければundefined。
   */
  private command_option(command: CompileProgramSettings, name: string): string | undefined {
    const index = command.args.findIndex(arg => arg === name || arg.startsWith(`${name}=`));
    if (index < 0) { return undefined; }
    return command.args[index] === name ? command.args[index + 1] : command.args[index].slice(name.length + 1);
  }

  /**
   * Biberの指定ディレクトリと作業ディレクトリから制御ファイルの場所を求める。
   * @param command 入力・出力ディレクトリを指定する可能性のあるBiberコマンド。
   * @returns 存在するBCFのパス。見つからなければ最優先の候補パス。
   */
  private biber_control_file(command: CompileProgramSettings): string {
    const directory = path.dirname(this.LaTeXProject.mainfile.fsPath);
    const input = this.command_option(command, '--input-directory') ?? this.command_option(command, '--output-directory');
    const name = path.basename(TeXToPDF.change_extension(this.LaTeXProject.mainfile.fsPath, '.bcf'));
    const candidates = [...new Set([path.resolve(directory, input ?? '.', name), path.join(directory, name)])];
    return candidates.find(filename => fs.existsSync(filename)) ?? candidates[0];
  }

  /**
   * 任意の補助ファイルをUTF-8で読み取る。
   * @param filename 読み取るファイルのパス。
   * @returns ファイルの内容。存在しない場合や読み取れない場合はnull。
   */
  private read_optional(filename: string): string | null {
    try { return fs.readFileSync(filename, 'utf8'); } catch { return null; }
  }

  /**
   * 名前空間に依存しない要素名で、生成されたXMLを検証・解析する。
   * @param text 解析するXML文字列。
   * @returns 属性と文字列の値を保持した解析結果。不正なXMLでは例外を送出する。
   */
  private parse_xml(text: string): XMLValue {
    return new XMLParser({ ignoreAttributes: false, removeNSPrefix: true,
      parseTagValue: false, parseAttributeValue: false }).parse(text, true) as XMLValue;
  }

  /**
   * 解析済みXMLから、指定名の要素を深さにかかわらず収集する。
   * @param value 探索するXML値。
   * @param name 名前空間の接頭辞を除いた要素名。
   * @returns 一致した要素の値の配列。繰り返し要素も展開する。
   */
  private xml_elements(value: XMLValue, name: string): XMLValue[] {
    if (typeof value === 'string') { return []; }
    if (Array.isArray(value)) { return value.flatMap(child => this.xml_elements(child, name)); }
    return Object.entries(value).flatMap(([key, child]) => key === name
      ? (Array.isArray(child) ? child : [child]) : this.xml_elements(child, name));
  }

  /**
   * 属性の有無にかかわらず、XML要素のテキストを取得する。
   * @param value 文字列、テキストを持つXML要素、またはundefined。
   * @returns 前後の空白を除いたテキスト。テキストがなければ空文字列。
   */
  private xml_text(value: XMLValue | undefined): string {
    if (typeof value === 'string') { return value.trim(); }
    return value && !Array.isArray(value) ? this.xml_text(value['#text']) : '';
  }

  /**
   * 今回更新されたrun.xmlから、有効なBiber実行要求を確認する。引数はない。
   * @returns Biberのactive=1の要求があればtrue。未更新・欠落・解析失敗ならfalse。
   */
  private biber_requested(): boolean {
    const filename = TeXToPDF.change_extension(this.LaTeXProject.mainfile.fsPath, '.run.xml');
    if (this.fileStamp(filename) === this.previousRunXMLStamp) { return false; }
    const text = this.read_optional(filename);
    if (text === null) { return false; }
    try {
      return this.xml_elements(this.parse_xml(text), 'external').some(element => typeof element !== 'string'
        && !Array.isArray(element) && element['@_active'] === '1' && this.xml_text(element.generic) === 'biber');
    } catch { return false; }
  }

  /**
   * Biberの制御内容、実行要求、およびデータソースの更新を確認する。
   * @param command 入出力ディレクトリや設定ファイルの指定を含むBiberコマンド。
   * @returns Biberによる文献生成が必要ならtrueとなるPromise。
   */
  private async biber_check(command: CompileProgramSettings): Promise<boolean> {
    const control = this.biber_control_file(command);
    const requested = this.biber_requested();
    const text = this.read_optional(control);
    if (text === null) { return requested; }
    // Old control files left behind when biblatex is removed are not current inputs.
    if (!requested && this.fileStamp(control) === this.previousBCFStamp) { return false; }
    const directory = path.dirname(this.LaTeXProject.mainfile.fsPath);
    const output = path.resolve(directory, this.command_option(command, '--output-directory') ?? '.');
    const bbl = path.join(output, path.basename(TeXToPDF.change_extension(this.LaTeXProject.mainfile.fsPath, '.bbl')));
    if (requested || !fs.existsSync(bbl) || text !== this.previousBCF) { return true; }
    let xml: XMLValue;
    try { xml = this.parse_xml(text); } catch { return true; }
    const names: string[] = [];
    for (const source of this.xml_elements(xml, 'datasource')) {
      const name = this.xml_text(source);
      if (!name || /^[a-z][a-z\d+.-]*:\/\//i.test(name)
        || (typeof source !== 'string' && !Array.isArray(source)
          && ['1', 'true'].includes(this.xml_text(source['@_glob'])))) { return true; }
      names.push(name);
    }
    const input = this.command_option(command, '--input-directory') ?? this.command_option(command, '--output-directory');
    const directories = [...new Set([...(input ? [path.resolve(directory, input)] : []), directory, path.dirname(control)])];
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
    return this.inputs_newer_than_output(paths, bbl);
  }

  /**
   * 入力の更新時刻を、文献または索引の出力と比較する。
   * @param inputs 解決済みの入力パス。未解決の入力はundefinedで表す。
   * @param output 比較対象の出力ファイルのパス。
   * @returns 新しい入力、未解決の入力、または取得できない更新情報があればtrue。
   */
  private inputs_newer_than_output(inputs: readonly (string | undefined)[], output: string): boolean {
    try {
      const outputTime = fs.statSync(output, { bigint: true }).mtimeNs;
      return inputs.some(filename => !filename || fs.statSync(filename, { bigint: true }).mtimeNs > outputTime);
    } catch { return true; }
  }

  /**
   * makeindex形式の短いオプションを、連結指定や繰り返し指定を含めて読む。
   * @param command 調べる実行引数を持つ索引コマンド。
   * @param option ハイフンを除いた1文字のオプション名。
   * @returns 指定順の値の配列。指定がなければ空配列。
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
   * 索引処理の出力先と、明示または既定のスタイル・辞書を取得する。
   * @param command 索引プログラムとその引数。
   * @returns 選択された出力パス、および参照するスタイル名・辞書名。
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
   * 文字コードに依存した変換をせず、IDXをバイト列で読み取る。引数はない。
   * @returns 現在のIDXの内容。存在しない場合や読み取れない場合はnull。
   */
  private read_index_input(): Buffer | null {
    try { return fs.readFileSync(TeXToPDF.change_extension(this.LaTeXProject.mainfile.fsPath, '.idx')); }
    catch { return null; }
  }

  /**
   * 索引入力が空、またはASCIIの空白・改行・タブだけかを確認する。
   * @param input 調べるIDXのバイト列。
   * @returns 空の索引入力として扱える場合はtrue。
   */
  private empty_index(input: Buffer): boolean {
    return input.every(byte => byte === 9 || byte === 10 || byte === 13 || byte === 32);
  }

  /**
   * 要求開始時または前回実行を決めた時点のIDXと、現在の索引入力を比較する。
   * @param command スタイル・辞書・出力先の取得に使用する索引コマンド。
   * @param options 検索後に確認するキャンセルトークンを含むオプション。
   * @returns 索引処理が必要ならtrueとなるPromise。その場合、読んだIDXを次の比較基準として保存する。
   */
  private async makeindex_check(command: CompileProgramSettings, options?: TeXToPDFOptions): Promise<boolean> {
    const input = this.read_index_input();
    if (input === null) { return false; }
    const files = this.index_files(command);
    let needed = this.indexInput === null || !input.equals(this.indexInput);
    if (this.indexState === 'pending' && !needed) {
      if (!fs.existsSync(files.output)) { needed = true; }
      else if (this.empty_index(input)) {
        try { needed = fs.readFileSync(files.output).length > 0; } catch { needed = true; }
      } else {
        const styles = await KpsewhichResolver.resolve(this.LaTeXProject.mainfile, files.styles, command.command);
        const dictionaries = await KpsewhichResolver.resolve(this.LaTeXProject.mainfile, files.dictionaries,
          command.command, process.env.INDEXDICTIONARY ?? '$INDEXDICTIONARY');
        needed = this.inputs_newer_than_output([...styles, ...dictionaries].map(uri => uri?.fsPath), files.output);
      }
    }
    this.checkCancellation(options);
    if (needed) { this.indexInput = input; }
    return needed;
  }


  /**
   * パスの親ディレクトリとベース名を保ち、最後の拡張子を変更する。
   * @param file 元のファイルパス。
   * @param ext ピリオドを含む新しい拡張子。
   * @returns 拡張子を置き換えたファイルパス。
   */
  private static change_extension(file: string, ext: string): string {
    return path.join(path.dirname(file), path.basename(file, path.extname(file)) + ext);
  }

  /**
   * パスの親ディレクトリを保ち、最後の拡張子を取り除く。
   * @param file 元のファイルパス。
   * @returns 最後の拡張子を除いたパス。
   */
  private static remove_extension(file: string): string {
    return path.join(path.dirname(file), path.basename(file, path.extname(file)));
  }

  /**
   * 文字列を正規表現のリテラル部分として使用できるようにする。
   * @param s エスケープする文字列。
   * @returns 正規表現の特殊文字をエスケープした文字列。
   */
  private static escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * ログのファイルURIに対応する開いた文書を、実パスの別名も含めて探す。
   * @param uri エラーの対象となるファイルURI。
   * @returns 対応する開いた文書。見つからなければundefined。
   */
  private static findErrorDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
    const document = Workspace.findOpenDocument(uri);
    if (document || uri.scheme !== 'file') { return document; }
    let realPathKey: string;
    try {
      realPathKey = Workspace.uriKey(vscode.Uri.file(fs.realpathSync(uri.fsPath)));
    } catch {
      return undefined;
    }
    const active = vscode.window.activeTextEditor?.document;
    const candidates = active ? [active, ...vscode.workspace.textDocuments] : vscode.workspace.textDocuments;
    for (const candidate of candidates) {
      if (candidate.isClosed || candidate.uri.scheme !== 'file') { continue; }
      try {
        if (Workspace.uriKey(vscode.Uri.file(fs.realpathSync(candidate.uri.fsPath))) === realPathKey) {
          return candidate;
        }
      } catch {
        // An unrelated new or deleted buffer must not interrupt log analysis.
      }
    }
    return undefined;
  }

  /**
   * 未定義命令・二重添字のログ前後の情報から、可能な範囲で原因位置を特定する。
   * @param logline エラー見出しがあるログ内の0始まりの行位置。
   * @param lines ログ全体を行ごとに分割した配列。
   * @param errline ログが示すソース内の1始まりの行番号。
   * @param errmsg エラーの説明。
   * @param error_file エラー対象のファイルパス。
   * @returns ファイルURI、強調範囲、説明からなる診断候補の配列。
   */
  private static undef_double_subsup_errors(logline: number, lines: string[], errline: number, errmsg: string, error_file: string): [vscode.Uri, vscode.Range, string][] {
    const doc = TeXToPDF.findErrorDocument(vscode.Uri.file(error_file));
    const errorUri = doc?.uri ?? vscode.Uri.file(error_file);
    const lineIndex = Math.max(0, errline - 1);
    const next_error_line_reg = /l\.(\d+)\s(.*)/;
    if (logline + 1 >= lines.length) { return [[
          errorUri,
          new vscode.Range(new vscode.Position(lineIndex, 0),
            new vscode.Position(lineIndex, Number.MAX_SAFE_INTEGER)),
          errmsg
        ]];
    }
    let mm = next_error_line_reg.exec(lines[logline + 1]);
    let error_string = mm ? mm[2] : lines[logline + 1];
    if(error_string.trim().startsWith("<")){
      let rr = error_string.indexOf(">");
      if(rr >= 0){ error_string = error_string.slice(rr + 1); }
    }
    if (error_string.substring(0, 3) === "...") {
      error_string = error_string.substring(3);
    }
    let next_line = (logline + 2 >= lines.length) ? "" : lines[logline + 2];
    next_line = next_line.replace(/\u{FFFFF}/u, '').trim();
    if (next_line.slice(-3) === "...") {
      next_line = next_line.slice(0, -3);
    }
    error_string = error_string.trimEnd();
    let r = 0;
    let cs = "";
    if(errmsg.startsWith("Undefined control sequence")){
      r = error_string.lastIndexOf("\\");
      if(r !== -1){
        cs = error_string.substring(r);
        error_string = error_string.substring(0, r).trimEnd();
      }
    }else{
      r = error_string.lastIndexOf(" ");
      if(r !== -1){
        cs = error_string.substring(r + 1);
        error_string = error_string.substring(0, r).trimEnd();
      }
    }
    if(r === -1) {
      cs = error_string.trimEnd();
      error_string = "";
    }
    if(doc && errline >= 1 && errline <= doc.lineCount) {
      let target_line_txt = doc.lineAt(errline - 1).text;
      let regstr = TeXToPDF.escapeRegExp(error_string) + `\\s*` + `(` + TeXToPDF.escapeRegExp(cs) + `)\\s*` + TeXToPDF.escapeRegExp(next_line.trim());
      //Log.debug_log("RegExp for error: " + regstr);
      let reg = new RegExp(regstr, 'd');
      let m = reg.exec(target_line_txt);
      if (m) {
        let strat = new vscode.Position(errline - 1,
          (m.indices && m.indices[1]) ? m.indices[1][0] : 0);
        let end = new vscode.Position(errline - 1,
          (m.indices && m.indices[1]) ? m.indices[1][1] : target_line_txt.length);
        return [[
          errorUri,
          new vscode.Range(strat, end),
          errmsg + (errmsg.startsWith("Undefined control sequence") ? `: \\${cs}` : "")]];
      }else{
        if(errmsg.startsWith("Undefined control sequence")){
          for(let i = errline  ; i > 0 ; --i){
            m = reg.exec(doc.lineAt(i - 1).text);
            if(m){
              let strat = new vscode.Position(i - 1,
                (m.indices && m.indices[1]) ? m.indices[1][0] : 0);
              let end = new vscode.Position(i - 1,
                (m.indices && m.indices[1]) ? m.indices[1][1] : doc.lineAt(i - 1).text.length);
              return [[
                errorUri,
                new vscode.Range(strat, end),
                errmsg + `: \\${cs}`]];
            }
          }
        }

        return [[
          errorUri,
          new vscode.Range(new vscode.Position(errline - 1, 0),
            new vscode.Position(errline - 1, target_line_txt.length)),
          errmsg
        ]];
      }
    }else {
      return [[
        errorUri,
        new vscode.Range(new vscode.Position(lineIndex, 0),
          new vscode.Position(lineIndex, Number.MAX_SAFE_INTEGER)),
        errmsg
      ]];
    }
  }

  /**
   * LaTeXのログからファイル・行番号付きのエラーと関連する原因位置を収集する。
   * @param main ログの場所を決めるメインTeXファイルのURI。
   * @returns ファイルURI、範囲、エラー説明の組を格納した配列のPromise。
   */
  static async analyze_errors(main: vscode.Uri): Promise<[vscode.Uri, vscode.Range, string][]> {
    // `-file-line-error` produces file:line:message records. A few TeX errors put
    // the offending token on the next log line and need specialized ranges.
    let dir = path.dirname(main.fsPath);
    let logfile = vscode.Uri.file(TeXToPDF.change_extension(main.fsPath, ".log"));
    let txt = Buffer.from(await vscode.workspace.fs.readFile(logfile)).toString("utf8");
    let lines = txt.split(/\r?\n/);
    let errors: [vscode.Uri, vscode.Range, string][] = [];
    // <ファイル名>:<行番号>: エラーメッセージ
    const error_line_reg = /^(.*)?:(\d+):\s?(.*)$/;
    for (let i = 0; i < lines.length; ++i) {
      let m = error_line_reg.exec(lines[i]);
      if (m) {
        let line = Number(m[2]);
        if (isNaN(line)) { continue; }
        let error_file = m[1];
        if (!path.isAbsolute(error_file)) {
          error_file = path.join(dir, error_file);
        }
        let errmsg = m[3];
        if(lines[i].length >= 79){
          errmsg = errmsg + lines[i + 1];
        }
        if (
          errmsg.startsWith("Undefined control sequence") ||
          errmsg.startsWith("Double subscript") ||
          errmsg.startsWith("Double superscript")
        ) {
          errors.push(...TeXToPDF.undef_double_subsup_errors(i, lines, line, errmsg, error_file)); 
        } else if (errmsg.trimStart().startsWith("==> Fatal error occurred, no output PDF file produced!")) {
          errors.push([
            vscode.Uri.file(error_file),
            new vscode.Range(new vscode.Position(line - 1, Number.MAX_SAFE_INTEGER),
              new vscode.Position(line - 1, Number.MAX_SAFE_INTEGER)),
            errmsg]);
        } else {
          errors.push([
            vscode.Uri.file(error_file),
            new vscode.Range(new vscode.Position(line - 1, 0),
              new vscode.Position(line - 1, Number.MAX_SAFE_INTEGER)),
            errmsg]);
        }
      }
    }
    return errors;
  }

}
