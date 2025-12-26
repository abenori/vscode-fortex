import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import Log from '../log';


type LaTeXFileType = typeof LaTeXProject.LaTeXFileType[keyof typeof LaTeXProject.LaTeXFileType];

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

  // [main,class,option,percent_sharps]
  public static async generate_project(f: vscode.Uri | null, guess_parent: boolean): Promise<[vscode.Uri | null,vscode.Uri, string, string, { [key: string]: string }]> {
    let main_from_percent_sharp: string | null = null;
    // 指定されたファイル or 現在開いているファイル
    let file = f ?? (() => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        return editor.document.uri;
      } else {
        throw new Error("Cannot get the current file");
      }
    })();
    // percent_sharpによるmain指定を読む．
    if (f === null) {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        let per = LaTeXProject.parse_percent_sharp_doc(editor.document.getText());
        main_from_percent_sharp = per["main"];
      }
    } else {
      let per = LaTeXProject.parse_percent_sharp_doc(
        Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8')
      );
      main_from_percent_sharp = per["main"];
    }
    if (main_from_percent_sharp) {
      main_from_percent_sharp = main_from_percent_sharp.trim();
      let mainfile = path.isAbsolute(main_from_percent_sharp) ?
        vscode.Uri.file(main_from_percent_sharp) :
        vscode.Uri.file(path.join(path.dirname(file.fsPath), main_from_percent_sharp));
      try {
        await vscode.workspace.fs.stat(mainfile); // 存在確認のため
      } catch (e) {
        throw new Error("The main file specified in %# main directive does not exist: " + mainfile.fsPath);
      }

      // メインファイルからクラス名とオプションを読む．
      // 現在開いているファイルと一致している場合はそっちの方から読む．
      let editor = vscode.window.activeTextEditor;
      let [cls, clsopt] = await (async (main: vscode.Uri) => {
        if (editor && (await LaTeXProject.isthesamefile(main, editor.document.uri))) {
          return LaTeXProject.get_classfile(editor.document.getText());
        } else {
          return LaTeXProject.get_classfile(Buffer.from(await vscode.workspace.fs.readFile(main)).toString('utf8'));
        }
      })(mainfile);
      let ps = await LaTeXProject.parse_percent_sharp(mainfile);
      return [f, mainfile, cls, clsopt, ps];
    } else {
      let mainfile: vscode.Uri | null = null;
      if (file === null) {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          file = editor.document.uri;
        } else {
          throw new Error("Cannot get the current file");
        }
      }
      if (guess_parent) {
        let res = await LaTeXProject.guess_mainfile(file);
        if (res) {
          let ps = await LaTeXProject.parse_percent_sharp(res[0]);
          return [f, ...res, ps];
        }
      }
      if (!mainfile) {
        // どうしても見つからない場合は最初に指定されたファイルをメインとする
        mainfile = file;
      }
      let editor = vscode.window.activeTextEditor;
      let [cls, clsopt] = await (async (file: vscode.Uri) => {
        if (editor && (await LaTeXProject.isthesamefile(file, editor.document.uri))) {
          return LaTeXProject.get_classfile(editor.document.getText());
        } else {
          return LaTeXProject.get_classfile(Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8'));
        }
      })(mainfile);
      let ps = await LaTeXProject.parse_percent_sharp(mainfile);
      return [f, mainfile, cls, clsopt, ps];
    }
  }



  // file1とfile2が同じファイルかどうかを調べる
  private static async isthesamefile(file1: vscode.Uri, file2: vscode.Uri): Promise<boolean> {
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
    const re = /\\documentclass(\[.*\])?\{(.*?)\}/g;
    let m = re.exec(txt);
    if (m) {
      let opt = m[1] === undefined ? "" : m[1];
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
    if (path.extname(file) !== ".tex") { return f + ".tex"; }
    else { return f; }
  }

  // mainfile, classfile, optionを推測する
  private static async guess_mainfile(file: vscode.Uri): Promise<[vscode.Uri, string, string] | null> {
    Log.debug_log("guess main file from " + file);
    let editor = vscode.window.activeTextEditor;
    if (editor) {
      if (await LaTeXProject.isthesamefile(file, editor.document.uri)) {
        let cls = LaTeXProject.get_classfile(editor.document.getText());
        if (cls[0] !== "") {
          Log.debug_log("found main file from editor: " + editor.document.fileName);
          return [file, cls[0], cls[1]];
        }
      }
    }
    let dir = vscode.Uri.file(path.dirname(file.fsPath));
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
    let txt = "";
    let dir = vscode.Uri.file(path.dirname(file.fsPath));
    try {
      txt = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
    }
    catch (e) {
      return [[], "", ""];
    }
    const reg = /\\(input|include)(\[[^\]]*\])?\{([^\}]+)\}/g;
    let ms = txt.matchAll(reg);
    let files: [vscode.Uri, LaTeXFileType][] = [];
    Log.debug_log("search included files in " + file);
    for (const m of ms) {
      Log.debug_log("found " + m[0] + " in " + file);
      let f = m[3];
      if (path.extname(f) !== ".tex") { f = f + ".tex"; }
      if (m[1] === "input") {
        files.push([vscode.Uri.joinPath(dir, f), LaTeXProject.LaTeXFileType.input]);
      } else {
        files.push([vscode.Uri.joinPath(dir, f), LaTeXProject.LaTeXFileType.include]);
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
    try {
      const files = await vscode.workspace.fs.readDirectory(dir);
      // results[file] = fileを\includeしているファイルたち
      let results: { [key: string]: [vscode.Uri, string, string][] } = {};
      Log.debug_log("search the file which includes " + target.fsPath + " from the drectory " + dir);
      for (const file of files) {
        if (file[1] === vscode.FileType.Directory) { continue; }
        if (path.extname(file[0]) !== ".tex") { continue; }
        let filepath = vscode.Uri.joinPath(dir, file[0]);
        let [incfiles, cls, opt] = await this.included_files(filepath);
        for (const [incfile, t] of incfiles) {
          if (results[path.normalize(incfile.fsPath).toLowerCase()]) {
            results[path.normalize(incfile.fsPath).toLowerCase()].push([filepath, cls, opt]);
          } else {
            results[path.normalize(incfile.fsPath).toLowerCase()] = [[filepath, cls, opt]];
          }
        }
        let a = results[path.normalize(target.fsPath).toLowerCase()];
        if (a) {
          for (const b of a) {
            if (b[1] !== "") { return b; }
          }
        }
      }
      let currenttarget = path.normalize(target.fsPath).toLowerCase();
      let resolvedtarget = [];
      while (true) {
        let a = results[currenttarget];
        if (a) {
          for (const b of a) {
            if (b[1] !== "") { 
              return b; 
            }
          }
          resolvedtarget.push(currenttarget);
          currenttarget = path.normalize(a[0][0].fsPath).toLowerCase();
          if (resolvedtarget.includes(currenttarget)) {
            break;
          }
        } else { break; }
      }
      return null;

    }
    catch (e) { return null; }
  }
  private make_filelist() {
    this.filelist_ = [[this.mainfile_, LaTeXProject.LaTeXFileType.main]];
    this.make_filelist_from_file(this.mainfile_);
  }
  private async make_filelist_from_file(file: vscode.Uri) {
    let [incfiles, a, b] = await LaTeXProject.included_files(file);
    for (const incfile of incfiles) {
      if (this.filelist.includes(incfile)) { continue; }
      this.filelist.push(incfile);
      this.make_filelist_from_file(incfile[0]);
    }
  }

  private static parse_percent_sharp_doc(txt: string): { [key: string]: string } {
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

  private static async parse_percent_sharp(main: vscode.Uri): Promise<{ [key: string]: string }> {
    let rv: { [key: string]: string } = {};
    if (vscode.window.activeTextEditor) {
      rv = LaTeXProject.parse_percent_sharp_doc(vscode.window.activeTextEditor.document.getText());
    }
    if ((vscode.window.activeTextEditor) && ((vscode.window.activeTextEditor.document) &&
        (await LaTeXProject.isthesamefile(main, vscode.window.activeTextEditor.document.uri))
      )) {
      rv = { ...LaTeXProject.parse_percent_sharp_doc(Buffer.from(await vscode.workspace.fs.readFile(main)).toString("utf8")), ...rv };
    }
    for (const a of Object.keys(rv)) {
      Log.debug_log("Parsed %# directive: " + a + " => " + rv[a]);
    }
    return rv;
  }

}