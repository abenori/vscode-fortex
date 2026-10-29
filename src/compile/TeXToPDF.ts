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
  // MakeIndexとBibTeXは一度しか実行しない．
  // 既に実行されたかのフラグ
  makeindex = false;
  bibtex = false;
  // status["file"][".aux"]に.auxファイルの中身を保存
  status: { [key: string]: { [key: string]: string | null } } = {};
  file_list: string[] = [];
  readonly extensions = [".aux", ".toc", ".lot", ".lof"];
  options: { [key: string]: string } = {};

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

  async build(): Promise<boolean> {
    // The first LaTeX pass creates dependency files. Subsequent passes are driven
    // by changes in those files, with a finite loop inside this method preventing
    // permanently unstable documents from compiling forever.
    let runCount = 1;
    let LaTeXrunCount = 1;
    this.read_status();
    // Resolve all commands once so settings changes take effect on the next build.
    const latex_cmd = this.make_latex_command();
    const bibtex_cmd = this.make_program_command('bibtex');
    const makeindex_cmd = this.make_program_command('makeindex');
    const dvipdf_cmd = this.make_program_command('dvipdf');
    let dir = path.dirname(this.LaTeXProject.mainfile.fsPath);
    let base = path.basename(this.LaTeXProject.mainfile.fsPath);
    Log.log(`(${runCount}) Executing: ${latex_cmd.command} ${latex_cmd.args.join(" ")} ${TeXToPDF.change_extension(base, ".tex")}${dir ? `\n   in directory ${dir}` : ''}`);
    try {
      let process = new Process();
      let result = await process.execute(latex_cmd.command, [...latex_cmd.args, TeXToPDF.change_extension(base, ".tex")], dir, false);
      if (result !== 0) {
        return false;
      }
    }
    catch (e) {
      Log.error(`Error running ${latex_cmd.command}:`, e);
      return false;
    }
    while (true) {
      runCount++;
      if(Config.maxLaTeXRuns() > 0 && LaTeXrunCount > Config.maxLaTeXRuns()){
        Log.error(`Maximum number of LaTeX runs (${Config.maxLaTeXRuns()}) exceeded. Stopping compilation.`);
        return false;
      }

      let cmd: CompileProgramSettings;
      let target = "";
      let ignore_error = false;

      if (this.latex_check()) {
        cmd = latex_cmd;
        target = TeXToPDF.change_extension(base, ".tex");
        LaTeXrunCount++;
      } else if (!this.bibtex && this.bibtex_check()) {
        cmd = bibtex_cmd;
        target = TeXToPDF.remove_extension(base);
        ignore_error = true;
        this.bibtex = true;
        this.forcelatex = true;
      } else if (!this.makeindex && this.makeindex_check()) {
        cmd = makeindex_cmd;
        target = TeXToPDF.remove_extension(base);
        this.makeindex = true;
        ignore_error = true;
        this.forcelatex = true;
      } else { break; }
      Log.log(`(${runCount}) Executing: ${cmd.command} ${cmd.args.join(" ")}${dir ? `\n   in directory ${dir}` : ''}`);
      try {
        let process = new Process();
        let result = await process.execute(cmd.command, [...cmd.args, target], dir, false);
        if (result === null || result !== 0) {
          if (ignore_error) {
            Log.log(`Warning: ${cmd.command} ${cmd.args.join(" ")} failed with exit code ${result}. Continuing...`);
          } else {
            return false;
          }
        }
      }
      catch (e) {
        if (ignore_error) {
          Log.process_message(`Warning: ${cmd.command} ${cmd.args.join(" ")} failed with error ${e}. Continuing...`);
        } else {
          return false;
        }
      }
    }

    if (latex_cmd.output === 'dvi') {
      Log.log(`Generating PDF using ${dvipdf_cmd.command} ${dvipdf_cmd.args.join(" ")}`);
      try {
        let process = new Process();
        let result = await process.execute(dvipdf_cmd.command, [...dvipdf_cmd.args, TeXToPDF.change_extension(base, ".dvi")], dir, false);
        if (result === null || result !== 0) {
          return false;
        }
      }
      catch (e) {
        Log.error(`Error generating PDF with ${dvipdf_cmd.command}:`, e);
        return false;
      }
    }
    return true;
  }

  private read_status(): void {
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

  //status の.auxは最新と仮定して処理する．
  private bibtex_check(): boolean {
    // BibTeX is needed while the citations requested in .aux differ from the
    // bibliography entries already written there. It runs at most once per build.
    if (this.makeindex) { return false; }
    let bibs = new Set<string>();
    let cits = new Set<string>();
    const bibdatareg = /\\bibcite\{(.*?)\}/g;
    const citereg = /\\citation\{(.*?)\}/g;
    // \bibdata{...} と \citation{...} の中身を集合として一致していなければBibTeXを実行する
    for (const file of this.file_list) {
      let txt = this.status[file][".aux"];
      //Log.debug_log("BibTeX check for file " + file + ": \n" + txt);
      if (txt) {
        let ms = txt.matchAll(bibdatareg);
        for (const m of ms) {
          bibs.add(m[1]);
        }
        ms = txt.matchAll(citereg);
        for (const m of ms) {
          cits.add(m[1]);
        }
      }
    }
    //Log.debug_log("BibTeX check: bibs = " + Array.from(bibs).join(", ") + ", cits = " + Array.from(cits).join(", "));
    if (TeXToPDF.eqSet(bibs, cits)) {
      this.forcelatex = true;
      this.bibtex = true;
      return false;
    } else { return true; }
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

  private static eqSet<T>(a: Set<T>, b: Set<T>): boolean {
    if (a.size !== b.size) { return false; }
    for (const i of a) {
      if (!b.has(i)) { return false; }
    }
    return true;
  }

}
