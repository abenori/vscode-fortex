import * as spawn from 'cross-spawn';
import Log from '../log';
import ChildProcess from 'child_process';

export default class Process{
  private static child_processes = new Set<ChildProcess.ChildProcess>();
  public static killAll(){
    for(let child of Process.child_processes){
      try{
        child.kill();
      }catch(e){}
    }
    Process.child_processes.clear();
  }
  public static execute(cmd: string, options: string[], dir : string | null, shell: boolean) : Promise<number | null>{
    Log.debug_log("Executing process: " + cmd + " " + options.join(" ") + (dir ? (" in directory " + dir) : ""));
    return new Promise<number | null>((resolve, rejects) => {
      let child = spawn.spawn(cmd,options,{
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: shell,
        cwd: dir || undefined
      });
      Process.child_processes.add(child);
      child.stdout?.on('data', (data: string | Buffer) => {
        Log.process_message(data.toString());
      });
      child.stderr?.on('data', (data: string | Buffer) => {
        Log.process_message(data.toString());
      });

      child.on('error', (err) => {
        Log.error(`Error executing ${cmd}:`, err);
        Process.child_processes.delete(child);
        rejects(err);
        return;
      });
      child.on('close', (code) => {
        if (code !== 0) {
          Log.error(`Process exited with code ${code}`);
        }
        Log.process_message("\n");
        Log.scroll_to_last_process_message();
        Process.child_processes.delete(child);  
        resolve(code);
      });
    });
  }

}