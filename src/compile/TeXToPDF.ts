import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import LaTeXProject from './LaTeXProject';
import Log from '../log';
import Process from './Process';

export default class TeXToPDF {
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
  mainfile: string = "";

  constructor(proj: LaTeXProject, ooption: string) {
    this.LaTeXProject = proj;
  }

  public init(option: string | undefined) {
    if (option !== undefined && option !== "") {
      let opt = option.split(";");
      for (const s of opt) {
        let r = s.indexOf("=");
        if (r === -1) { this.options[s] = ""; }
        else { this.options[s.substring(0, r)] = s.substring(r + 1); }
      }
    }
    if (this.LaTeXProject.mainfile) {
      this.file_list.push(this.LaTeXProject.mainfile.fsPath);
      for (const file of this.LaTeXProject.filelist) {
        if (file[1] === LaTeXProject.LaTeXFileType.include) {
          this.file_list.push(file[0].fsPath);
        }
      }
    }
  }
  private make_latex_command(): [string, string[]] {
    let cls = this.LaTeXProject.classfile;
    let clsopt = this.LaTeXProject.classoption;
    let cmd = "";
    let ps = this.LaTeXProject.percent_sharp("!");
    if (ps) {
      ps = ps.trimStart();
      if (ps.indexOf(" ") < 0) { cmd = ps; }
    } else {
      switch (cls) {
        case "article":
        case "report":
        case "book":
          cmd = "pdflatex";
          break;
        case "jarticle":
        case "jreport":
        case "jbook":
          cmd = "platex";
          break;
        case "ujarticle":
        case "ujreport":
        case "ujbook":
          cmd = "uplatex";
          break;
        case "jsarticle":
        case "jsbook":
        case "jsreport":
          cmd = (/,\s*uplatex\s*,/.test("," + clsopt + ",")) ? "uplatex" : "platex";
          break;
        case "ltjsarticle":
        case "ltjsbook":
        case "ltjsreport":
          cmd = "lualatex";
          break;
        case "jlreq":
          cmd = "uplatex";
          if (/,\s*platex\s*,/.test("," + clsopt + ",")) { cmd = "platex"; }
          else if (/,\s*lualatex\s*,/.test("," + clsopt + ",")) { cmd = "lualatex"; }
          break;
        default:
          cmd = "pdflatex";
      }
    }
    Log.debug_log("class file = " + cls + ", class option = " + clsopt + ", guessed command: " + cmd);
    let opt = this.LaTeXProject.percent_sharp("t2dopt") ?? "";
    let opts = opt.split(" ").filter((s) => s.length > 0);
    return [cmd, ["-interaction=nonstopmode", "-halt-on-error", "-synctex=1", "-file-line-error",...opts]];
  }

  private make_bibtex_command(): [string, string[]] {
    let prog = this.LaTeXProject.percent_sharp("bibtex") ?? "upbibtex";
    return [prog, []];
  }

  private make_makeindex_command(): [string, string[]] {
    let prog = this.LaTeXProject.percent_sharp("makeindex") ?? "upmendex";
    return [prog, []];
  }

  private make_dvipdfm_command(): [string, string[]] {
    let prog = this.LaTeXProject.percent_sharp("dvipdf") ?? "dvipdfmx";
    return [prog, []];
  }

  async build(): Promise<boolean> {
    let runCount = 1;
    this.read_status();
    let latex_cmd = this.make_latex_command();
    let output_pdf = false;
    if (latex_cmd[0].indexOf("Lua") >= 0) {
      for (let i = 0; i < latex_cmd[1].length; ++i) {
        if (latex_cmd[1][i] === "-output-format=dvi") {
          output_pdf = false;
          break;
        }
      }
    } else if (latex_cmd[0].indexOf("pdf") >= 0 || latex_cmd[0] === "context") {
      output_pdf = true;
    }
    let dir = path.dirname(this.LaTeXProject.mainfile.fsPath);
    let base = path.basename(this.LaTeXProject.mainfile.fsPath);
    Log.log(`(${runCount}) Executing: ${latex_cmd[0]} ${latex_cmd[1].join(" ")} ${TeXToPDF.change_extension(base, ".tex")}${dir ? `\n   in directory ${dir}` : ''}`);
    try {
      let result = await Process.execute(latex_cmd[0], [...latex_cmd[1], TeXToPDF.change_extension(base, ".tex")], dir, false);
      if (result !== 0) {
        return false;
      }
    }
    catch (e) {
      Log.error(`Error running ${latex_cmd[0]}:`, e);
      return false;
    }
    while (true) {
      runCount++;
      let cmd: [string, string[]] = ["", []];
      let target = "";
      let ignore_error = false;

      if (this.latex_check()) {
        cmd = this.make_latex_command();
        target = TeXToPDF.change_extension(base, ".tex");
      } else if (!this.bibtex && this.bibtex_check()) {
        cmd = this.make_bibtex_command();
        target = TeXToPDF.remove_extension(base);
        ignore_error = true;
        this.bibtex = true;
        this.forcelatex = true;
      } else if (!this.makeindex && this.makeindex_check()) {
        cmd = this.make_makeindex_command();
        target = TeXToPDF.remove_extension(base);
        this.makeindex = true;
        ignore_error = true;
        this.forcelatex = true;
      } else { break; }
      Log.log(`(${runCount}) Executing: ${cmd[0]} ${cmd[1].join(" ")}${dir ? `\n   in directory ${dir}` : ''}`);
      try {
        let result = await Process.execute(cmd[0], [...cmd[1], target], dir, false);
        if (result === null || result !== 0) {
          if (ignore_error) {
            Log.log(`Warning: ${cmd[0]} ${cmd[1].join(" ")} failed with exit code ${result}. Continuing...`);
          } else {
            return false;
          }
        }
      }
      catch (e) {
        if (ignore_error) {
          Log.process_message(`Warning: ${cmd[0]} ${cmd[1].join(" ")} failed with error ${e}. Continuing...`);
        } else {
          return false;
        }
      }
    }

    if (!output_pdf) {
      let dvipdfm = this.make_dvipdfm_command();
      Log.log(`Generating PDF using ${dvipdfm[0]} ${dvipdfm[1].join(" ")}`);
      try {
        let result = await Process.execute(dvipdfm[0], [...dvipdfm[1], TeXToPDF.change_extension(base, ".dvi")], dir, false);
        if (result === null || result !== 0) {
          return false;
        }
      }
      catch (e) {
        Log.error(`Error generating PDF with ${dvipdfm[0]}:`, e);
        return false;
      }
    }
    return true;
  }

  private read_status(): void {
    Log.debug_log("Reading current latex file statuses");
    for (const file of this.file_list) {
      if (this.status[file] === undefined) {
        this.status[file] = {};
      }
      for (const ext of this.extensions) {
        let f = TeXToPDF.change_extension(file, ext);
        try {
          this.status[file][ext] = fs.readFileSync(f, "utf8");
          Log.debug_log(`Read status for ${f} \r\n` + this.status[file][ext]);
        }
        catch (e) {
          this.status[file][ext] = null;
          Log.debug_log(`Status for ${f} does not exist`);
        }
      }
    }
  }

  private latex_check(): boolean {
    let rv: boolean = false;
    if (this.forcelatex) {
      rv = true;
      this.forcelatex = false;
    }
    Log.debug_log("Checking LaTeX files for changes");
    for (const file of this.file_list) {
      for (const ext of this.extensions) {
        let f = TeXToPDF.change_extension(file, ext);
        Log.debug_log("Checking file: " + f + "; ext = " + ext);
        try {
          let txt = fs.readFileSync(f, "utf8");
          if (!rv) {
            if (this.status[file][ext] !== txt) { rv = true; }
          }
          //Log.debug_log(`Checking file ${f}, old content: \n${this.status[file][ext]}\ncurrent content: \n${txt}`);
          this.status[file][ext] = txt;
        }
        catch (e) {
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
    if (this.makeindex) { return false; }
    let bibs = new Set<string>();
    let cits = new Set<string>();
    const bibdatareg = /\\bibcite\{(.*?)\}/g;
    const citereg = /\\citation\{(.*?)\}/g;
    // \bibdata{...} と \citation{...} の中身を集合として一致していなければBibTeXを実行する
    for (const file of this.file_list) {
      let txt = this.status[file][".aux"];
      Log.debug_log("BibTeX check for file " + file + ": \n" + txt);
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
    Log.debug_log("BibTeX check: bibs = " + Array.from(bibs).join(", ") + ", cits = " + Array.from(cits).join(", "));
    if (TeXToPDF.eqSet(bibs, cits)) {
      this.forcelatex = true;
      this.bibtex = true;
      return false;
    } else { return true; }
  }

  private makeindex_check(): boolean {
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

  private static undef_double_subsup_errors(logline: number, lines: string[], errline: number, errmsg: string, error_file: string): [vscode.Uri, vscode.Range, string][] {
    const next_error_line_reg = /l\.(\d+)\s(.*)/;
    if (logline + 1 >= lines.length) { return [[
          vscode.Uri.file(error_file),
          new vscode.Range(new vscode.Position(errline - 1, 0),
            new vscode.Position(errline - 1, Number.MAX_SAFE_INTEGER)),
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
    let doc: vscode.TextDocument | undefined = undefined;
    let editor = vscode.window.activeTextEditor;
    if (!editor || fs.realpathSync(editor.document.fileName) !== fs.realpathSync(error_file)) {
      for(const dc of vscode.workspace.textDocuments){
        if(fs.realpathSync(dc.fileName) === fs.realpathSync(error_file)){
          doc = dc;
          break;
        }
      }
    }else {
      doc = editor.document;
    }
    if(doc) {
      let target_line_txt = doc.lineAt(errline - 1).text;
      let regstr = TeXToPDF.escapeRegExp(error_string) + `\\s*` + `(` + TeXToPDF.escapeRegExp(cs) + `)\\s*` + TeXToPDF.escapeRegExp(next_line.trim());
      Log.debug_log("RegExp for error: " + regstr);
      let reg = new RegExp(regstr, 'd');
      let m = reg.exec(target_line_txt);
      if (m) {
        let strat = new vscode.Position(errline - 1,
          m.indices ? m.indices[1][0] : 0);
        let end = new vscode.Position(errline - 1,
          m.indices ? m.indices[1][1] : target_line_txt.length);
        return [[
          vscode.Uri.file(error_file),
          new vscode.Range(strat, end),
          errmsg + (errmsg.startsWith("Undefined control sequence") ? `: \\${cs}` : "")]];
      }else{
        if(errmsg.startsWith("Undefined control sequence")){
          for(let i = errline  ; i > 0 ; --i){
            m = reg.exec(doc.lineAt(i - 1).text);
            if(m){
              let strat = new vscode.Position(i - 1,
                m.indices ? m.indices[1][0] : 0);
              let end = new vscode.Position(i - 1,
                m.indices ? m.indices[1][1] : doc.lineAt(i - 1).text.length);
              return [[
                vscode.Uri.file(error_file),
                new vscode.Range(strat, end),
                errmsg + `: \\${cs}`]];
            }
          }
        }

        return [[
          vscode.Uri.file(error_file),
          new vscode.Range(new vscode.Position(errline - 1, 0),
            new vscode.Position(errline - 1, target_line_txt.length)),
          errmsg
        ]];
      }
    }else {
      return [[
        vscode.Uri.file(error_file),
        new vscode.Range(new vscode.Position(errline - 1, 0),
          new vscode.Position(errline - 1, Number.MAX_SAFE_INTEGER)),
        errmsg
      ]];
    }
  }

  static async analyze_errors(main: vscode.Uri): Promise<[vscode.Uri, vscode.Range, string][]> {
    let dir = path.dirname(main.fsPath);
    let logfile = vscode.Uri.file(TeXToPDF.change_extension(main.fsPath, ".log"));
    let txt = Buffer.from(await vscode.workspace.fs.readFile(logfile)).toString("utf8");
    let lines = txt.split(/\r?\n/);
    let errors: [vscode.Uri, vscode.Range, string][] = [];
    // <ファイル名>:<行番号>: エラーメッセージ
    const error_line_reg = /^([^:]*):(\d+):\s?(.*)$/;
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
        if (
          errmsg.startsWith("Undefined control sequence") ||
          errmsg.startsWith("Double subscript") ||
          errmsg.startsWith("Double superscript")
        ) {
          errors.push(...TeXToPDF.undef_double_subsup_errors(i, lines, line, errmsg, error_file)); 
        } else if (errmsg.startsWith(" ==> Fatal error occurred, no output PDF file produced!")) {
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