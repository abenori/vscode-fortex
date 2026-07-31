import * as path from 'path';
import Process from './Process';
import LaTeXProject from './LaTeXProject';
import TeXToPDF from './TeXToPDF';
import Log from '../log';
import ErrorManager from './ErrorManager';
import Config from '../Config';
import {
  assertProgramAllowed,
  findCommandSeparator,
  parseCommandLine,
  singleProgramFromDirective
} from './BuildSecurity';

/** Marker base class for parsed `%#!` build actions. */
class Action{}
/** Invokes one of Fortex's built-in build stages. */
class CommandAction extends Action{
  action = "";
  option = "";
  public constructor(cmd: string, option: string){
    super();
    this.action = cmd;
    this.option = option;
  }
}
/** Executes one parsed `%#!` command directly, without a shell. */
class ExecuteAction extends Action{
  executable: string;
  args: string[];
  public constructor(cmd : string){
    super();
    const parsed = parseCommandLine(cmd.trim());
    this.executable = parsed.executable;
    this.args = parsed.args;
  }
}

/** Coordinates a complete build and converts TeX log errors into diagnostics. */
export default class LaTeXCompile {
  public static working = false;
  private LaTeXProject: LaTeXProject;
  
  constructor(proj: LaTeXProject) {
    this.LaTeXProject = proj;
  }


  public async build() : Promise<boolean>{
    // Build requests can arrive from both save events and explicit commands. The
    // shared flag prevents two tool chains from writing the same auxiliary files.
    if(LaTeXCompile.working){ return false; }
    try{
      ErrorManager.clear();
      LaTeXCompile.working = true;
      Log.clear_process_message();
      //Log.debug_log("Current directory: " + path.dirname(this.LaTeXProject.mainfile.fsPath));
      let actions : Action[] = [];
      let ps = this.LaTeXProject.percent_sharp("!");
      actions = [new CommandAction("TeXToPDF", "")];
      // A `%#!` directive may replace the default pipeline with built-in actions
      // and arbitrary commands separated by semicolons.
      if(ps){
        ps = ps.trim();
        if(singleProgramFromDirective(ps) === undefined) {
          actions = LaTeXCompile.parse_action(ps);
        }
      }
      // Validate every executable named by a source directive before starting
      // even the first process. A later, unused disallowed directive therefore
      // cannot hide behind an earlier successful TeX pass.
      this.validate_percent_sharp_programs(actions);
      for(let i = 0 ; i < actions.length ; ++i){
        //Log.debug_log("Executing action: " + JSON.stringify(actions[i]));
        let result = await this.execute_action(actions[i]);
        if(!result){
          LaTeXCompile.working = false;
          return false;
        }
        //Log.debug_log("action done");
      }
      Log.log("LaTeX compile done");
      //Log.debug_log("LaTeX compile done");
      Log.scroll_to_last_process_message();
    }
    catch(e){
      Log.error("Exception during LaTeX compilation: " + e);
      LaTeXCompile.working = false;
      return false;
    }
    LaTeXCompile.working = false;
    return true;
  }

  private async execute_action(action: Action) : Promise<boolean>{
    if (action instanceof CommandAction) {
      if(action.action.toLowerCase() === "textopdf"){
        let textopdf = new TeXToPDF(this.LaTeXProject, action.option);
        let result = await textopdf.build();
        if(!result){
          let errors = await TeXToPDF.analyze_errors(this.LaTeXProject.mainfile);
          for(let i = 0 ; i < errors.length ; i++){
            ErrorManager.adderror(errors[i][0], errors[i][1], errors[i][2]);
          }
          return false;
        }
      }else{
        Log.error("Unknown action command: " + action.action);
        return false;
      }
    } else if (action instanceof ExecuteAction){
      const executable = this.expand_placeholders(action.executable);
      const args = action.args.map((arg) => this.expand_placeholders(arg));
      Log.process_message(`Executing command: %s\n`, LaTeXCompile.format_command(executable, args));
      let process = new Process();
      const result = await process.execute(
        executable,
        args,
        path.dirname(this.LaTeXProject.mainfile.fsPath),
        false
      );
      if (result !== 0) {
        return false;
      }
    }
    return true;
  }

  private validate_percent_sharp_programs(actions: Action[]): void {
    const allowedPrograms = Config.allowedPrograms();
    const buildDirective = this.LaTeXProject.percent_sharp('!')?.trim();
    if (buildDirective) {
      const engine = singleProgramFromDirective(buildDirective);
      if (engine !== undefined) {
        assertProgramAllowed(this.expand_placeholders(engine), allowedPrograms, '%#!');
      }
    }

    // These directives select helper executables inside the standard pipeline.
    // Validate all of them now, even if this particular build would not need the
    // corresponding bibliography, index, or DVI conversion stage.
    for (const [key, label] of [
      ['bibtex', '%#bibtex'],
      ['makeindex', '%#makeindex'],
      ['dvipdf', '%#dvipdf']
    ] as const) {
      const program = this.LaTeXProject.percent_sharp(key)?.trim();
      if (program) {
        assertProgramAllowed(this.expand_placeholders(program), allowedPrograms, label);
      }
    }

    for (const action of actions) {
      if (action instanceof ExecuteAction) {
        assertProgramAllowed(
          this.expand_placeholders(action.executable),
          allowedPrograms,
          '%#!'
        );
      }
    }
  }

  private expand_placeholders(value: string): string {
    // Lowercase placeholders describe the active source file; uppercase ones
    // always describe the detected project main file. Expansion happens after
    // tokenization, so a path containing spaces remains a single argument.
    if(this.LaTeXProject.file){
      value = value.replaceAll("%f", this.LaTeXProject.file.fsPath)
        .replaceAll("%d", path.dirname(this.LaTeXProject.file.fsPath))
        .replaceAll("%b", path.basename(this.LaTeXProject.file.fsPath, path.extname(this.LaTeXProject.file.fsPath)))
        .replaceAll("%k", path.extname(this.LaTeXProject.file.fsPath));
    }
    return value.replaceAll("%F", this.LaTeXProject.mainfile.fsPath)
      .replaceAll("%D", path.dirname(this.LaTeXProject.mainfile.fsPath))
      .replaceAll("%B", path.basename(this.LaTeXProject.mainfile.fsPath, path.extname(this.LaTeXProject.mainfile.fsPath)))
      .replaceAll("%K", path.extname(this.LaTeXProject.mainfile.fsPath));
  }

  private static format_command(executable: string, args: string[]): string {
    return [executable, ...args].map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(' ');
  }

  private static parse_action(action: string): Action[] {
    // Built-in actions use `$(C:name:option)`. Parenthesis depth is tracked so
    // options can themselves contain parenthesized fragments.
    action = action.trim();
    let parse_top = 0;
    let rv : Action[] = [];
    while(true){
      while(action.substring(parse_top,parse_top + 1) === " "){
        parse_top = parse_top + 1;
      }
      let c = action.substring(parse_top,parse_top + 1);
      if(c === "") { break; }
      else if(c === "$"){
        c = action.substring(parse_top+1,parse_top + 2);
        if(c === "("){
          let r = action.indexOf(":", parse_top + 2);
          if (r === -1) {
            throw new Error("Built-in action is missing ':' in %#! directive: " + action);
          }
          let cmd = action.substring(parse_top + 2, r);
          r = r + 1;
          parse_top = r;
          let nest = 1;
          while(true){
            c = action.substring(r, r + 1);
            if(c === "("){
              nest = nest + 1;
            }else if(c === ")"){
              nest = nest - 1;
              if (nest === 0) { break; }
            }else if(c === "") {
              throw new Error("Unclosed built-in action in %#! directive: " + action);
            }
            r = r + 1;
          }
          let naiyo = action.substring(parse_top, r);
          parse_top = r + 1;
          if(cmd === "C"){
            r = naiyo.indexOf(":");
            if(r === -1){
              rv.push(new CommandAction(naiyo, ""));
            }else{
              rv.push(new CommandAction(naiyo.substring(0,r),naiyo.substring(r + 1)));
            }
          }else{
            throw new Error("Unknown built-in action in %#! directive: " + cmd);
          }
        } else {
          throw new Error("Invalid action in %#! directive near: " + action.substring(parse_top));
        }
        while(action.substring(parse_top,parse_top + 1) === " "){
          parse_top = parse_top + 1;
        }
        if(action.substring(parse_top,parse_top + 1) === ";"){
          parse_top = parse_top + 1;
        }
      } else {
        let r = findCommandSeparator(action, parse_top);
        if(r === -1){
          rv.push(new ExecuteAction(action.substring(parse_top)));
          break;
        }else{
          rv.push(new ExecuteAction(action.substring(parse_top, r)));
          parse_top = r + 1;
        }
      }
    }
    return rv;
  }


}
