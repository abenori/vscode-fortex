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
  options: { [key: string] : string } = {};
  mainfile: string = "";

  constructor(proj: LaTeXProject, ooption: string){ 
    this.LaTeXProject = proj;
  }
      
  public init (option: string | undefined) {
    if(option !== undefined && option !== ""){
      let opt = option.split(";");
      for(const s of opt){
        let r = s.indexOf("=");
        if(r === -1) { this.options[s] = ""; }
        else { this.options[s.substring(0,r)] = s.substring(r + 1); } 
      }
    }
    if(this.LaTeXProject.mainfile){
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
    if(ps){
      ps = ps.trimStart();
      if(ps.indexOf(" ") < 0) { cmd = ps; }
    }else{
      switch(cls){
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
          cmd = (clsopt.indexOf("uplatex") >= 0 ? "uplatex" : "platex");
          break;
        case "ltjsarticle":
        case "ltjsbook":
        case "ltjsreport":
          cmd = "lualatex";
          break;
        case "jlreq":
          cmd = "uplatex";
          if(clsopt.indexOf("platex") >= 0) { cmd = "platex"; }
          else if(clsopt.indexOf("lualatex") >= 0) { cmd = "lualatex"; }
          break;
        default:
          cmd = "pdflatex";
      }
    }
    Log.debug_log("class file = " + cls + ", class option = " + clsopt + ", guessed command: " + cmd);
    return [cmd, ["-interaction=nonstopmode","-halt-on-error", "-synctex=1"]];
  }

  private make_bibtex_command(): [string, string[]] {
    let prog = this.LaTeXProject.percent_sharp("bibtex") ?? "upbibtex";
    return [prog, []];
  }
  
  private make_makeindex_command(): [string, string[]] {
    let prog = this.LaTeXProject.percent_sharp("makeindex") ?? "upmendex";
    return [prog, []];
  }
  
  private make_dvipdfm_command() : [string, string[]] {
    let prog = this.LaTeXProject.percent_sharp("dvipdfm") ?? "dvipdfmx";
    return [prog, []];
  }
  
  async build() : Promise<boolean> {
    let runCount = 1;
    this.read_status();
    let latex_cmd  = this.make_latex_command();
    let output_pdf = false;
    if(latex_cmd[0].indexOf("Lua") >= 0){
      for(let i = 0 ; i < latex_cmd[1].length ; ++i){
        if(latex_cmd[1][i] === "-output-format=dvi"){
          output_pdf = false;
          break;
        }
      }
    }else if(latex_cmd[0].indexOf("pdf") >= 0 || latex_cmd[0] === "context"){
      output_pdf = true;
    }
    let dir = path.dirname(this.LaTeXProject.mainfile.fsPath);
    let base = path.basename(this.LaTeXProject.mainfile.fsPath);
    Log.log(`(${runCount}) Executing: ${latex_cmd[0]} ${latex_cmd[1].join(" ")} ${TeXToPDF.change_extension(base,".tex")}${dir ? `\n   in directory ${dir}` : ''}`);
    try{
      let result = await Process.execute(latex_cmd[0], [...latex_cmd[1], TeXToPDF.change_extension(base,".tex")], dir, false);
      if(result !== 0){
        return false;
      }
    }
    catch(e){
      Log.error(`Error running ${latex_cmd[0]}:`, e);
      return false;
    }
    while(true){
      runCount++;
      let cmd: [string, string[]] = ["", []];
      let target = "";
      let ignore_error = false;
    
      if(this.latex_check()){
        cmd = this.make_latex_command();
        target = TeXToPDF.change_extension(base,".tex");
      } else if(!this.bibtex && this.bibtex_check()) {
        cmd = this.make_bibtex_command();
        target = TeXToPDF.remove_extension(base);
        ignore_error = true;
        this.bibtex = true;
        this.forcelatex = true;
      } else if(!this.makeindex && this.makeindex_check()) {
        cmd = this.make_makeindex_command();
        target = TeXToPDF.remove_extension(base);
        this.makeindex = true;
        ignore_error = true;
        this.forcelatex = true;
      } else { break; }
      Log.log(`(${runCount}) Executing: ${cmd[0]} ${cmd[1].join(" ")}${dir ? `\n   in directory ${dir}` : ''}`);
      try{
        let result = await Process.execute(cmd[0], [...cmd[1], target], dir, false);
        if (result === null || result !== 0) {
          if(ignore_error) {
            Log.log(`Warning: ${cmd[0]} ${cmd[1].join(" ")} failed with exit code ${result}. Continuing...`);
          } else {
            return false;
          }
        }
      }
      catch(e){
        if(ignore_error) {
          Log.process_message(`Warning: ${cmd[0]} ${cmd[1].join(" ")} failed with error ${e}. Continuing...`);
        } else {
          return false;
        }
      }
    }

    if(!output_pdf){
      let dvipdfm = this.make_dvipdfm_command();
      Log.log(`Generating PDF using ${dvipdfm[0]} ${dvipdfm[1].join(" ")}`);
      try{
        let result = await Process.execute(dvipdfm[0], [...dvipdfm[1], TeXToPDF.change_extension(base,".dvi")],dir, false);
        if(result === null || result !== 0){
          return false;
        }
      }
      catch(e){
        Log.error(`Error generating PDF with ${dvipdfm[0]}:`, e);
        return false;
      }
    }
    return true;
  }

  private read_status() : void{
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
    if(this.forcelatex){
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
    if(this.makeindex) { return false; }
    let bibs = new Set<string>();
    let cits = new Set<string>();
    const bibdatareg = /\\bibcite\{(.*?)\}/g;
    const citereg = /\\citation\{(.*?)\}/g;
    // \bibdata{...} と \citation{...} の中身を集合として一致していなければBibTeXを実行する
    for (const file of this.file_list){
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
    if (TeXToPDF.eqSet(bibs, cits)){
      this.forcelatex = true;
      this.bibtex = true;
      return false;
    } else { return true; }
  }

  private makeindex_check(): boolean {
    let f = TeXToPDF.change_extension(this.LaTeXProject.mainfile.fsPath, ".idx");
    if(fs.existsSync(f)){
      this.makeindex = true;
      this.forcelatex = true;
      return true;
    }else { return false; }
  }


  private static change_extension(file: string, ext: string): string {
    return path.join(path.dirname(file), path.basename(file, path.extname(file)) + ext);
  }

  private static remove_extension(file: string): string {
    return path.join(path.dirname(file), path.basename(file, path.extname(file)));
  }

  private static async analyze_errors(logfile: string, dir: string): Promise<[vscode.Range, string][]> {
    let txt = await fs.readFileSync(logfile, "utf8");
    let lines = txt.split(/\r?\n/);
    let errors: [vscode.Range, string][] = [];
    const error_line_reg = /^([^:]*)?:(\d+):\s?(.*)$/;
    const next_error_line_reg = /l\.(\d+)\s(.*)/; 
    for(let i = 0 ; i < lines.length; ++i){ 
      let m = error_line_reg.exec(lines[i]);
      if(m){
        let line = Number(m[1]);
        if(isNaN(line)) { continue; }
        let error_file = m[2];
        if(!path.isAbsolute(error_file)){
          error_file = path.join(dir, error_file);
        }
        let editor = vscode.window.activeTextEditor;
        if(m[3] === "Undefined control sequence."){
          if(i + 1 >= lines.length) { continue; }
          let mm = next_error_line_reg.exec(lines[i + 1]);
          if(!mm) { continue; }
          var error_string = mm[2];
          if(error_string.substring(0,3) === "..."){
            error_string = error_string.substring(3);
          }
          
          if(editor && fs.realpathSync(editor.document.fileName) === fs.realpathSync(error_file)){
            let target_line_txt = editor.document.lineAt(line - 1).text;

            
          }

        }

      }


    }
    return [];
  }
 
  private static eqSet<T>(a: Set<T>, b: Set<T>): boolean {
    if (a.size !== b.size) { return false; }
    for (const i of a) {
      if (!b.has(i)) { return false; }
    }
    return true;
  }

}