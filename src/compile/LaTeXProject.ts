import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import Log from '../log';
import Config from "../Config";

type LaTeXFileType = typeof LaTeXProject.LaTeXFileType[keyof typeof LaTeXProject.LaTeXFileType];

/**
 * Describes the active LaTeX project and locates its main document.
 *
 * Main-file detection applies the user-configured strategies in order: `%#main`,
 * recursive parent discovery, and finally treating the current file as main.
 */
export default class LaTeXProject {
  static readonly LaTeXFileType = {
    main: 0,
    include: 1,
    input: 2,
  } as const;
  private file_: vscode.Uri | null = null;
  get file(): vscode.Uri | null { return this.file_; }
  private mainfile_: vscode.Uri;
  get mainfile(): vscode.Uri { return this.mainfile_; }
  private classfile_: string = "";
  get classfile(): string { return this.classfile_; }
  private classoption_: string = "";
  get classoption(): string { return this.classoption_; }
  private filelist_: [vscode.Uri, LaTeXFileType][] = [];
  get filelist(): [vscode.Uri, LaTeXFileType][] { return this.filelist_; }
  private percent_sharp_: { [key: string]: string } = {};
  public percent_sharp(key: string): string | undefined {
    return this.percent_sharp_[key];
  }

  // こんな感じで使うつもり．
  // proj = new LaTeXProject(LaTeXProject.generate_project(...))
  constructor(a: [vscode.Uri | null, vscode.Uri, string, string, { [key: string]: string }]) {
    this.file_ = a[0];
    this.mainfile_ = a[1];
    this.classfile_ = a[2];
    this.classoption_ = a[3];
    this.percent_sharp_ = a[4];
    this.make_filelist();
  }

  static async get_class_option_from_main(main: vscode.Uri): Promise<[string, string]> {
    let [cls, clsopt] = LaTeXProject.get_classfile(await LaTeXProject.read_file_text(main));
    return [cls, clsopt];
  }
  static async exist_file(f: vscode.Uri, dir: vscode.Uri) : Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(f); // 存在確認のため
    } catch (e) {
      return false;
    }
    return true;
  }
  // [main,class,option,percent_sharps]
  static async get_main_from_percent_sharp(f: vscode.Uri, percent_sharp: { [key: string]: string }): Promise<[vscode.Uri, string, string, { [key: string]: string }] | undefined> {
    let main_from_percent_sharp: string | undefined = undefined;
    main_from_percent_sharp = percent_sharp["main"];
    if(!main_from_percent_sharp) {return undefined; }
    main_from_percent_sharp = main_from_percent_sharp.trim();
    let main = path.isAbsolute(main_from_percent_sharp) ?
      vscode.Uri.file(main_from_percent_sharp) :
      vscode.Uri.file(path.join(path.dirname(f.fsPath), main_from_percent_sharp));
    if(!await LaTeXProject.exist_file(main, vscode.Uri.file(path.dirname(f.fsPath)))) { return undefined; }
    let [cls, clsopt] = await LaTeXProject.get_class_option_from_main(main);
    return [main, cls, clsopt, percent_sharp];
  }
  static async guess_main_file(f: vscode.Uri, percent_sharp: { [key: string]: string }): Promise<[vscode.Uri, string, string, { [key: string]: string }] | undefined> {
    let res = await LaTeXProject.guess_mainfile(f);
    if (res) {
      return [...res, percent_sharp];
    }else {
      return undefined;
    }
  }

  static async main_from_current_file(f: vscode.Uri, percent_sharp: { [key: string]: string }): Promise<[vscode.Uri, string, string, { [key: string]: string }] | undefined> {
    let [cls,clsopt] = await LaTeXProject.get_class_option_from_main(f);
    return [f, cls, clsopt, percent_sharp];
  }

  public static async generate_project(f: vscode.Uri | null, guess_parent: boolean): Promise<[vscode.Uri | null,vscode.Uri, string, string, { [key: string]: string }]> {
    // Strategies are data-driven so changing `mainFileOrder` does not duplicate
    // the validation and result assembly below.
    const guess_tactics: Array<(file: vscode.Uri, directives: { [key: string]: string }) => Promise<[vscode.Uri, string, string, { [key: string]: string }] | undefined>> = [];
    let main_order = Config.mainFileOrder();
    for(let i = 0 ; i < main_order.length ; ++i){
      switch(main_order[i]){
        case "magic":
          guess_tactics.push(LaTeXProject.get_main_from_percent_sharp);
          break;
        case "guess":
          guess_tactics.push(LaTeXProject.guess_main_file);
          break;
        case "current":
          guess_tactics.push(LaTeXProject.main_from_current_file);
          break;
      }
    }

    let file = f ?? (() => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        return editor.document.uri;
      } else {
        throw new Error("Cannot get the current file");
      }
    })();
    // %#は最初に指定されたファイル（基本的にエディタで開いているファイル）のみ読む．メインファイルは読まない．
    let percent_sharp = await LaTeXProject.parse_percent_sharp(file);
    let dir = vscode.Uri.file(path.dirname(file.fsPath));

    for (const tactic of guess_tactics){
      let res = await tactic(file,percent_sharp);
      if(res) {
        let m = res[0];
        if(await LaTeXProject.exist_file(m, dir)){ return [f, ...res]; }
      }
    }
    throw new Error("The main cannot be found.");
  }

  // file1とfile2が同じファイルかどうかを調べる
  private static async isthesamefile(file1: vscode.Uri, file2: vscode.Uri): Promise<boolean> {
    // Windows paths are case-insensitive. URI normalization also lets the upward
    // directory walk recognize when it has reached the filesystem root.
    try {
      let f1 = await vscode.workspace.fs.stat(file1);
      let f2 = await vscode.workspace.fs.stat(file2);
      if (
        (f1.type === vscode.FileType.File || f1.type === vscode.FileType.Directory) &&
        f1.type === f2.type &&
        file1.scheme === file2.scheme
      ) {
        if (process.platform === 'win32') {
          return path.normalize(file1.fsPath).toLowerCase() === path.normalize(file2.fsPath).toLowerCase();
        } else {
          return path.normalize(file1.fsPath) === path.normalize(file2.fsPath);
        }
      } else { return false; }
    }
    catch (e) {
      return false;
    }
  }

  // [class,option]を返す
  private static get_classfile(txt: string): [string, string] {
    // Comments are masked first so a documented-out `\documentclass` does not
    // make a subfile look like a project root.
    txt = LaTeXProject.strip_comments(txt);
    const re = /\\documentclass(\[.*\])?\{(.*?)\}/g;
    let m = re.exec(txt);
    if (m) {
      let opt = m[1] === undefined ? "" : m[1].slice(1,-1);
      let cls = m[2] === undefined ? "" : m[2];
      return [cls, opt];
    }
    return ["", ""];
  }

  // 絶対パスに変換，.texがなければ.texを付ける
  private to_resalfilename(file: string, dir: string): string {
    let f = path.normalize(file);
    if (!path.isAbsolute(f)) {
      f = path.normalize(path.join(dir, f));
    }
    if (path.extname(file).toLowerCase() !== ".tex") { return f + ".tex"; }
    else { return f; }
  }

  // mainfile, classfile, optionを推測する
  private static async guess_mainfile(file: vscode.Uri): Promise<[vscode.Uri, string, string] | null> {
    //Log.debug_log("guess main file from " + file);
    let cls = LaTeXProject.get_classfile(await LaTeXProject.read_file_text(file));
    if (cls[0] !== "") {
      //Log.debug_log("found main file from editor: " + file.fsPath);
      return [file, cls[0], cls[1]];
    }
    let dir = vscode.Uri.file(path.dirname(file.fsPath));
    // Search every ancestor. A candidate is accepted only when it has a
    // document class and recursively includes the active file.
    // 階層をあがっていってfileがincludeされているファイルを探す
    while (true) {
      let res = await LaTeXProject.find_included(dir, file);
      if(res){ return res; }
      let parent = vscode.Uri.file(path.dirname(dir.fsPath));
      if (await LaTeXProject.isthesamefile(parent, dir)) { break; }
      dir = parent;
    }
    return null;
  }

  // (includeされているファイル一覧，クラスファイル名,option)を返す
  private static async included_files(file: vscode.Uri): Promise<[[vscode.Uri, LaTeXFileType][], string, string]> {
    // This intentionally parses only literal paths. Macro-generated inputs cannot
    // be resolved reliably without executing TeX.
    let txt = "";
    let dir = vscode.Uri.file(path.dirname(file.fsPath));
    try {
      txt = await LaTeXProject.read_file_text(file);
    }
    catch (e) {
      return [[], "", ""];
    }
    const reg = /\\(input|include)(\[[^\]]*\])?\{([^\}]+)\}/g;
    let ms = LaTeXProject.strip_comments(txt).matchAll(reg);
    let files: [vscode.Uri, LaTeXFileType][] = [];
    //Log.debug_log("search included files in " + file);
    for (const m of ms) {
      //Log.debug_log("found " + m[0] + " in " + file);
      let f = m[3].trim();
      if (!f || f.includes('\\')) { continue; }
      if (path.extname(f).toLowerCase() !== ".tex") { f = f + ".tex"; }
      const uri = vscode.Uri.file(path.resolve(dir.fsPath, f));
      if (m[1] === "input") {
        files.push([uri, LaTeXProject.LaTeXFileType.input]);
      } else {
        files.push([uri, LaTeXProject.LaTeXFileType.include]);
      }
    }
    if (files.length === 0) {
      return [[], "", ""];
    }
    let cls = LaTeXProject.get_classfile(txt);
    return [files, cls[0], cls[1]];
  }

  // ディレクトリdir内からtargetがinclude/inputされているファイルを探す．
  // 戻り値は[親ファイル名,クラスファイル名,option]（\documentclassがない場合はクラスファイルは空文字列）
  private static async find_included(dir: vscode.Uri, target: vscode.Uri): Promise<[vscode.Uri, string, string] | null> {
    // Only top-level documents in this directory are candidates; recursive
    // inclusion is checked by collectProjectFiles for each candidate.
    try {
      const files = await vscode.workspace.fs.readDirectory(dir);
      // results[file] = fileを\includeしているファイルたち
      //Log.debug_log("search the file which includes " + target.fsPath + " from the drectory " + dir);
      for (const file of files) {
        if (file[1] === vscode.FileType.Directory) { continue; }
        if (path.extname(file[0]).toLowerCase() !== ".tex") { continue; }
        let filepath = vscode.Uri.joinPath(dir, file[0]);
        try {
          const [cls, opt] = LaTeXProject.get_classfile(await LaTeXProject.read_file_text(filepath));
          if (!cls) { continue; }
          const projectFiles = await LaTeXProject.collectProjectFiles(filepath);
          if (projectFiles.some((projectFile) => LaTeXProject.uri_key(projectFile) === LaTeXProject.uri_key(target))) {
            return [filepath, cls, opt];
          }
        } catch {
          continue;
        }
      }
      return null;

    }
    catch (e) { return null; }
  }

  public static async collectProjectFiles(main: vscode.Uri): Promise<vscode.Uri[]> {
    // The visited set prevents cycles such as A inputting B and B inputting A.
    const files: vscode.Uri[] = [];
    const visited = new Set<string>();
    const visit = async (file: vscode.Uri): Promise<void> => {
      const key = LaTeXProject.uri_key(file);
      if (visited.has(key)) { return; }
      visited.add(key);
      try {
        await vscode.workspace.fs.stat(file);
      } catch {
        return;
      }
      files.push(file);
      const [included] = await LaTeXProject.included_files(file);
      for (const [child] of included) {
        await visit(child);
      }
    };
    await visit(main);
    return files;
  }

  private make_filelist() {
    this.filelist_ = [[this.mainfile_, LaTeXProject.LaTeXFileType.main]];
    void this.make_filelist_from_file(this.mainfile_);
  }
  private async make_filelist_from_file(file: vscode.Uri) {
    let [incfiles, a, b] = await LaTeXProject.included_files(file);
    for (const incfile of incfiles) {
      if (this.filelist.some(([listed]) => LaTeXProject.uri_key(listed) === LaTeXProject.uri_key(incfile[0]))) { continue; }
      this.filelist.push(incfile);
      await this.make_filelist_from_file(incfile[0]);
    }
  }

  private static parse_percent_sharp_doc(txt: string): { [key: string]: string } {
    // `%#key value` directives are intentionally line-oriented and are read only
    // from the originally active document during project detection.
    const reg = /^%#([^ \r\n]*)( ?[^\r\n]*?)$/gm;
    let rv: { [key: string]: string } = {};
    let mm = txt.matchAll(reg);
    for (const m of mm) {
      if (m[2] && m[2].toString().length > 0) {
        rv[m[1].toString().toLowerCase()] = m[2].toString();
      } else {
        if (m[1].toString().startsWith("!")) {
          rv["!"] = m[1].toString().substring(1);
        } else {
          rv[m[1].toString().toLowerCase()] = "";
        }
      }
    }
    return rv;

  }

  private static async parse_percent_sharp(file: vscode.Uri): Promise<{ [key: string]: string }> {
    const rv = LaTeXProject.parse_percent_sharp_doc(await LaTeXProject.read_file_text(file));
    /*
    for (const a of Object.keys(rv)) {
      Log.debug_log("Parsed %# directive: " + a + " => " + rv[a]);
    }*/
    return rv;
  }

  private static async read_file_text(file: vscode.Uri): Promise<string> {
    // Prefer unsaved editor contents so project and completion behavior matches
    // what the user currently sees rather than the last saved version.
    const openDocument = vscode.workspace.textDocuments.find((document) => LaTeXProject.uri_key(document.uri) === LaTeXProject.uri_key(file));
    return openDocument?.getText() ?? Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
  }

  private static uri_key(uri: vscode.Uri): string {
    const value = uri.scheme === 'file' ? path.normalize(uri.fsPath) : uri.toString();
    return process.platform === 'win32' ? value.toLocaleLowerCase() : value;
  }

  private static strip_comments(source: string): string {
    // Preserve string length and newlines: callers can safely use match offsets
    // against the original source after comments have been hidden.
    let result = '';
    let inComment = false;
    let slashCount = 0;
    for (const char of source) {
      if (inComment) {
        if (char === '\r' || char === '\n') {
          inComment = false;
          result += char;
        } else {
          result += ' ';
        }
        continue;
      }
      if (char === '%' && slashCount % 2 === 0) {
        inComment = true;
        result += ' ';
        slashCount = 0;
        continue;
      }
      result += char;
      slashCount = char === '\\' ? slashCount + 1 : 0;
    }
    return result;
  }

}
