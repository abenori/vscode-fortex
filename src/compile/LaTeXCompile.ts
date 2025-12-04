import * as path from 'path';
import Process from './Process';
import LaTeXProject from './LaTeXProject';
import TeXToPDF from './TeXToPDF';
import Log from '../log';

class Action{}
class CommandAction extends Action{
  action = "";
  option = "";
  public constructor(cmd: string, option: string){
    super();
    this.action = cmd;
    this.option = option;
  }
}
class ExecuteAction extends Action{
  commands : string[] = [];
  public constructor(cmd : string){
    super();
    // 安直に;で分割
    this.commands = cmd.split(";");
  }
}

export default class LaTeXCompile {
  public static working = false;
  private LaTeXProject: LaTeXProject;
  
  constructor(proj: LaTeXProject) {
    this.LaTeXProject = proj;
  }


  public async build() : Promise<boolean>{
    if(LaTeXCompile.working){ return false; }
    LaTeXCompile.working = true;
    Log.clear_process_message();
    Log.debug_log("Current directory: " + path.dirname(this.LaTeXProject.mainfile));
    let actions : Action[] = [];
    if(this.LaTeXProject.percent_sharp("!") && this.LaTeXProject.percent_sharp("!")!.startsWith(" ")){
      actions = LaTeXCompile.parse_action(this.LaTeXProject.percent_sharp("!")!.trimStart());
    }else{
      actions = [new CommandAction("TeXToPDF", "")];
    }
    for(let i = 0 ; i < actions.length ; ++i){
      Log.debug_log("Executing action: " + JSON.stringify(actions[i]));
      let result = await this.execute_action(actions[i]);
      if(!result){
        LaTeXCompile.working = false;
        return false;
      }
      Log.debug_log("action done");
    }
    Log.log("LaTeX compile done");
    Log.debug_log("LaTeX compile done");
    Log.scroll_to_last_process_message();
    LaTeXCompile.working = false;
    return true;
  }

  private async execute_action(action: Action) : Promise<boolean>{
    if (action instanceof CommandAction) {
      if(action.action.toLowerCase() === "textopdf"){
        let textopdf = new TeXToPDF(this.LaTeXProject, action.option);
        let result = await textopdf.build(this.LaTeXProject.mainfile);
        if(!result){
          return false;
        }
      }else{
        Log.error("Unknown action command: " + action.action);
        return false;
      }
    } else if (action instanceof ExecuteAction){
      for(let j = 0 ; j < action.commands.length ; ++j){
        let res = await Process.execute(action.commands[j], [], path.dirname(this.LaTeXProject.mainfile), true);  
      }
    }
    return true;
  }

  private static parse_action(action: string): Action[] {
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
              Log.error("Error parsing action: " + action);
              return [];
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
            Log.error("Unknown action command: " + cmd);
            return [];
          }
        }
        while(action.substring(parse_top,parse_top + 1) === " "){
          parse_top = parse_top + 1;
        }
        if(action.substring(parse_top,parse_top + 1) === ";"){
          parse_top = parse_top + 1;
        }
      } else {
        let r = action.indexOf(";", parse_top);
        if(r === -1){
          rv.push(new ExecuteAction(action.substring(parse_top)));
          break;
        }else{
          rv.push(new ExecuteAction(action.substring(parse_top, r)));
          parse_top = r + 1;
        }
        parse_top = r + 1;
      }
    }
    return rv;
  }


}