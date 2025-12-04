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
  private mainfile_: string;
  get mainfile(): string { return this.mainfile_; }
  private classfile_: string;
  get classfile(): string { return this.classfile_; }
  private classoption_: string;
  get classoption(): string { return this.classoption_; }
  private filelist_: [string, LaTeXFileType][] = [];
  get filelist(): [string, LaTeXFileType][] { return this.filelist_; }
  private percent_sharp_: { [key : string] : string } = {};
  public percent_sharp(key: string) : string | undefined {
    return this.percent_sharp_[key];
  }
  private valid_ = true;
  get valid(): boolean { return this.valid_; }

  constructor(file: string, guess_parent: boolean) {
    let main_from_percent_sharp: string | null = null;
    if(file === null){
      const editor = vscode.window.activeTextEditor;
      if(editor){
        file = editor.document.fileName;
        let per = this.parse_percent_sharp_doc(editor.document.getText());
        main_from_percent_sharp = per["main"];
      }
    } else {
      let per = this.parse_percent_sharp_doc(fs.readFileSync(file, 'utf8'));
      main_from_percent_sharp = per["main"];
    }
    this.filelist_ = [];
    if(main_from_percent_sharp){
      this.mainfile_ = this.to_resalfilename(main_from_percent_sharp, path.dirname(file));
      let editor = vscode.window.activeTextEditor;
      let cls = (editor && this.isthesamefile(this.mainfile_, editor.document.fileName)) ? 
        this.get_classfile(editor.document.getText()) : this.get_classfile(fs.readFileSync(this.mainfile_, 'utf8'));
      this.classfile_ = cls[0];
      this.classoption_ = cls[1];
    } else {
      if(file === null) { 
        const editor = vscode.window.activeTextEditor;
        if(editor){
          file = editor.document.fileName;
        }else {
          Log.debug_log("Cannot get main file");
          this.valid_ = false;
          this.classfile_ = "";
          this.classoption_ = "";
          this.mainfile_ = "";
          return;
        }
      }
      if (guess_parent) {
        [this.mainfile_, this.classfile_, this.classoption_] = this.guess_mainfile(file);
      } else {
        this.mainfile_ = file;
        let editor = vscode.window.activeTextEditor;
        let cls = (editor && this.isthesamefile(file, editor.document.fileName)) ? 
          this.get_classfile(editor.document.getText()) : this.get_classfile(fs.readFileSync(file, 'utf8'));
        this.classfile_ = cls[0];
        this.classoption_ = cls[1];
      }
    }
    this.make_filelist();
    this.percent_sharp_ = this.parse_percent_sharp();
  }
  
  // file1とfile2が同じファイルかどうかを調べる
  private isthesamefile(file1: string, file2: string): boolean {
    let f1 = fs.realpathSync(file1);
    let f2 = fs.realpathSync(file2);
    return f1 === f2;
  }
  
  // [class,option]を返す
  private get_classfile(txt: string): [string, string] {
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
  
  private guess_mainfile(file: string): [string, string, string] {
    Log.debug_log("guess main file from " + file);
    let editor = vscode.window.activeTextEditor;
    if (editor) {
      if (this.isthesamefile(file, editor.document.fileName)) {
        let cls = this.get_classfile(editor.document.getText());
        if (cls[0] !== "") {
          Log.debug_log("found main file from editor: " + editor.document.fileName);
          return [file, cls[0], cls[1]];
        }
      }
    }
    let dir = path.dirname(file);
    while (true) {
      let res = this.find_included(dir, file);
      if (res[0] !== "") { return res; }
      let parent = path.dirname(dir);
      if (parent === dir) { break; }
      dir = parent;
    }
    return ["", "", ""];
  }
  
  // (includeされているファイル一覧，クラスファイル名,option)を返す
  private included_files(file: string): [[string,LaTeXFileType][], string, string] {
    let txt = "";
    let dir = path.dirname(file);
    try{
      txt = fs.readFileSync(file, 'utf8');
    }
    catch(e){
      return [[], "", ""];
    }
    const reg = /\\(input|include)(\[[^\]]*\])?\{([^\}]+)\}/g;
    let ms = txt.matchAll(reg);
    let files: [string, LaTeXFileType][] = [];
    Log.debug_log("search included files in " + file);
    for (const m of ms) {
      Log.debug_log("found " + m[0] + " in " + file);
      let f = m[3];
      if(path.extname(f) !== ".tex") { f = f + ".tex"; }
      if(m[1] === "input") {
        files.push([path.join(dir,f), LaTeXProject.LaTeXFileType.input]);
      }else {
        files.push([path.join(dir,f), LaTeXProject.LaTeXFileType.include]);
      }
    }
    if (files.length === 0) {
      return [[], "", ""];
    }
    let cls = this.get_classfile(txt);
    return [files, cls[0], cls[1]];
  }
  
  // ディレクトリdir内からtargetがinclude/inputされているファイルを探す．
  // 戻り値は[親ファイル名,クラスファイル名,option]（\documentclassがない場合はクラスファイルは空文字列）
  find_included(dir: string, target: string): [string, string, string] {
    try {
      const files = fs.readdirSync(dir);
      // results[file] = fileを\includeしているファイルたち
      let results: { [key: string]: [string, string, string][] } = {};
      Log.debug_log("search the file which includes " + target + " from the drectory " + dir);
      for (const file of files) {
        if(path.extname(file) !== ".tex") { continue; }
        let filepath = path.join(dir, file);
        let [incfiles, cls, opt] = this.included_files(filepath);
        for (const [incfile,t] of incfiles) {
          let f = this.to_resalfilename(incfile, dir);
          if (results[f]) {
            results[f].push([filepath, cls, opt]);
          } else {
            results[f] = [[filepath, cls, opt]];
          }
        }
        let a = results[path.normalize(target)];
        if (a) {
          for (const b of a) {
            if (b[1] !== "") { return b; }
          }
        }
      }
      let currenttarget = path.normalize(target);
      let resolvedtarget = [];
      while (true) {
        let a = results[currenttarget];
        if (a) {
          for (const b of a) {
            if (b[1] !== "") { return b; }
          }
          resolvedtarget.push(currenttarget);
          currenttarget = a[0][0];
          if (resolvedtarget.includes(currenttarget)) {
            break;
          }
      } else { break; }
      }
      return ["", "", ""];
      
    }
    catch (e) { return ["", "", ""]; }
    
  }
  private make_filelist() {
    this.filelist_ = [[this.mainfile, LaTeXProject.LaTeXFileType.main]];
    this.make_filelist_from_file(this.mainfile);
  }
  private make_filelist_from_file(file: string) {
    let [incfiles,a,b] = this.included_files(file);
    for(const incfile of incfiles) {
      if(this.filelist.includes(incfile)) { continue; }
      this.filelist.push(incfile);
      this.make_filelist_from_file(incfile[0]);
    }
  }
  
  private parse_percent_sharp_doc(txt: string): { [key : string] : string } {
    const reg = /^%#([^ \r\n]*)( ?[^\r\n]*?)$/gm;
    let rv : { [key : string] : string } = {};
    let mm = txt.matchAll(reg);
    for(const m of mm){
      if(m[2] && m[2].toString().length > 0){
        rv[m[1].toString().toLowerCase()] = m[2].toString();
      }else{
        if(m[1].toString().startsWith("!")){
          rv["!"] = m[1].toString().substring(1);
        }else{
          rv[m[1].toString().toLowerCase()] = "";
        }
      }
    }
    return rv;
    
  }
  
    private parse_percent_sharp() : { [key : string] : string } {
    let rv : { [key : string] : string } = {};
    if(vscode.window.activeTextEditor){
      rv = this.parse_percent_sharp_doc(vscode.window.activeTextEditor.document.getText());
    }
    if(this.mainfile !== "" && 
      (vscode.window.activeTextEditor) && ((vscode.window.activeTextEditor.document) && 
      (vscode.window.activeTextEditor.document.fileName !== this.mainfile)
    )){
      rv = { ...this.parse_percent_sharp_doc(fs.readFileSync(this.mainfile, 'utf8')) , ...rv};
    }
    for(const a of Object.keys(rv)){
      Log.debug_log("Parsed %# directive: " + a + " => " + rv[a]);
    }
    return rv;
  }

}