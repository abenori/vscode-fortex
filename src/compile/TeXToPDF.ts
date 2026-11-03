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
  // MakeIndexと文献処理は一度しか実行しない．
  // 既に実行されたかのフラグ
  makeindex = false;
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

  private make_program_command(key: CompileProgram): CompileProgramSettings {
    return Config.programSettings(key, this.LaTeXProject.percent_sharp(key)?.trim());
  }

  /** Owns tool sequencing and interprets failures, warnings, diagnostics and outputs. */
  async build(options?: TeXToPDFOptions): Promise<TeXToPDFResult> {
    const warnings: string[] = [];
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
            'Processing bibliography…', warnings, options);
        } else if (!this.makeindex && this.makeindex_check()) {
          this.makeindex = true;
          this.forcelatex = true;
          await this.runOptionalTool(index, TeXToPDF.remove_extension(base), directory,
            'Processing index…', warnings, options);
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
        diagnostics: [], pdfs: producedPDF ? [pdf] : []
      };
    } catch (error) {
      if (options?.token?.isCancellationRequested || error instanceof vscode.CancellationError) {
        return { outcome: 'cancelled', severity: 'info', message: 'Build cancelled.' };
      }
      const message = error instanceof Error ? error.message : String(error);
      Log.error(message);
      let diagnostics: [vscode.Uri, vscode.Diagnostic[]][] | undefined;
      // An unchanged log belongs to an earlier build, not this launch failure.
      if (started && this.fileStamp(logPath) !== previousLog) {
        try {
          diagnostics = (await TeXToPDF.analyze_errors(this.LaTeXProject.mainfile)).map(([uri, range, text]) =>
            [uri, [new vscode.Diagnostic(range, text, vscode.DiagnosticSeverity.Error)]]);
        } catch (analysisError) { Log.log(`Unable to read build diagnostics: ${String(analysisError)}`); }
      }
      if (options?.token?.isCancellationRequested) {
        return { outcome: 'cancelled', severity: 'info', message: 'Build cancelled.' };
      }
      return { outcome: 'failed', severity: 'error', message, diagnostics };
    }
  }

  /** Runs a stage and keeps cancellation distinct from an executable failure. */
  private async runTool(command: CompileProgramSettings, target: string, directory: string,
    message: string, options?: TeXToPDFOptions): Promise<void> {
    this.checkCancellation(options);
    options?.onProgress?.(message);
    Log.log(`Executing: ${command.command} ${[...command.args, target].join(' ')}\n   in directory ${directory}`);
    const code = await new Process(command.command, [...command.args, target], directory).execute(options?.token);
    this.checkCancellation(options);
    if (code !== 0) { throw new Error(`${command.command} exited with code ${code}.`); }
  }

  /** Accumulates recoverable helper failures without swallowing cancellation. */
  private async runOptionalTool(command: CompileProgramSettings, target: string, directory: string,
    message: string, warnings: string[], options?: TeXToPDFOptions): Promise<void> {
    try { await this.runTool(command, target, directory, message, options); }
    catch (error) {
      this.checkCancellation(options);
      if (error instanceof vscode.CancellationError) { throw error; }
      const warning = error instanceof Error ? error.message : String(error);
      warnings.push(warning);
      Log.log(`Warning: ${warning} Continuing…`);
    }
  }

  /** Prevents a cancelled build from entering another stage. */
  private checkCancellation(options?: TeXToPDFOptions): void {
    if (options?.token?.isCancellationRequested) { throw new vscode.CancellationError(); }
  }

  /** Distinguishes newly written outputs from artifacts left by a previous run. */
  private fileStamp(filename: string): string | undefined {
    try {
      const stat = fs.statSync(filename, { bigint: true });
      return `${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
    } catch { return undefined; }
  }

  /** Captures pass snapshots and independent pre-build bibliography inputs. */
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
  }

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

  /** Selects only the detection algorithm; build() owns execution and the once-only flag. */
  private async bib_check(command: CompileProgramSettings, options?: TeXToPDFOptions): Promise<boolean> {
    this.checkCancellation(options);
    const needed = programName(command.command) === 'biber'
      ? await this.biber_check(command) : await this.bibtex_check(command);
    this.checkCancellation(options);
    return needed;
  }

  /** Reads bibliography directives from current auxiliary snapshots without reading TeX sources. */
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

  /** Checks classic bibliography inputs against the BBL and the pre-build auxiliary declarations. */
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
    return this.inputs_newer_than_bbl(resolved.map(uri => uri?.fsPath), bbl);
  }

  /** Reads a helper option in either --name=value or --name value form. */
  private command_option(command: CompileProgramSettings, name: string): string | undefined {
    const index = command.args.findIndex(arg => arg === name || arg.startsWith(`${name}=`));
    if (index < 0) { return undefined; }
    return command.args[index] === name ? command.args[index + 1] : command.args[index].slice(name.length + 1);
  }

  /** Locates Biber's control input using the existing job name and configured input/output directory. */
  private biber_control_file(command: CompileProgramSettings): string {
    const directory = path.dirname(this.LaTeXProject.mainfile.fsPath);
    const input = this.command_option(command, '--input-directory') ?? this.command_option(command, '--output-directory');
    const name = path.basename(TeXToPDF.change_extension(this.LaTeXProject.mainfile.fsPath, '.bcf'));
    const candidates = [...new Set([path.resolve(directory, input ?? '.', name), path.join(directory, name)])];
    return candidates.find(filename => fs.existsSync(filename)) ?? candidates[0];
  }

  /** Returns null for an absent/unreadable optional pipeline input. */
  private read_optional(filename: string): string | null {
    try { return fs.readFileSync(filename, 'utf8'); } catch { return null; }
  }

  /** Parses generated XML with namespace-independent names and preserved attribute/text values. */
  private parse_xml(text: string): XMLValue {
    return new XMLParser({ ignoreAttributes: false, removeNSPrefix: true,
      parseTagValue: false, parseAttributeValue: false }).parse(text, true) as XMLValue;
  }

  /** Collects named XML elements at any nesting depth, including repeated refsections. */
  private xml_elements(value: XMLValue, name: string): XMLValue[] {
    if (typeof value === 'string') { return []; }
    if (Array.isArray(value)) { return value.flatMap(child => this.xml_elements(child, name)); }
    return Object.entries(value).flatMap(([key, child]) => key === name
      ? (Array.isArray(child) ? child : [child]) : this.xml_elements(child, name));
  }

  /** Extracts element text while allowing attributes on that element. */
  private xml_text(value: XMLValue | undefined): string {
    if (typeof value === 'string') { return value.trim(); }
    return value && !Array.isArray(value) ? this.xml_text(value['#text']) : '';
  }

  /** Reads only current-build Biber requests, never executing commands described by logreq. */
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

  /** Checks Biber control content, explicit requests and datasource timestamps independently of BibTeX. */
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
    return this.inputs_newer_than_bbl(paths, bbl);
  }

  /** Treats newer or unresolvable inputs as requiring one helper run. */
  private inputs_newer_than_bbl(inputs: readonly (string | undefined)[], bbl: string): boolean {
    try {
      const outputTime = fs.statSync(bbl, { bigint: true }).mtimeNs;
      return inputs.some(filename => !filename || fs.statSync(filename, { bigint: true }).mtimeNs > outputTime);
    } catch { return true; }
  }

  private makeindex_check(): boolean {
    // An index file is enough to schedule makeindex once, followed by another TeX
    // pass to incorporate the generated index.
    let f = TeXToPDF.change_extension(this.LaTeXProject.mainfile.fsPath, ".idx");
    if (fs.existsSync(f)) {
      this.makeindex = true;
      this.forcelatex = true;
      return true;
    } else { return false; }
  }


  private static change_extension(file: string, ext: string): string {
    return path.join(path.dirname(file), path.basename(file, path.extname(file)) + ext);
  }

  private static remove_extension(file: string): string {
    return path.join(path.dirname(file), path.basename(file, path.extname(file)));
  }

  private static escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /** Prefer an exact buffer URI, then accept an existing local path alias. */
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
