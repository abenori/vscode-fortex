import * as spawn from 'cross-spawn';
import Log from '../log';

export default class Process{
  public static execute(cmd: string, options: string[], dir : string | null, shell: boolean) : Promise<number | null>{
    Log.debug_log("Executing process: " + cmd + " " + options.join(" ") + (dir ? (" in directory " + dir) : ""));
    return new Promise<number | null>((resolve, rejects) => {
      let child = spawn.spawn(cmd,options,{
        stdio: 'pipe',
        shell: shell,
        cwd: dir || undefined
      });
      child.stdout?.on('data', (data: string | Buffer) => {
        Log.process_message(data.toString());
      });
      child.stderr?.on('data', (data: string | Buffer) => {
        Log.process_message(data.toString());
      });

      child.on('error', (err) => {
        Log.error(`Error executing ${cmd}:`, err);
        rejects(err);
        return;
      });
      child.on('close', (code) => {
        if (code !== 0) {
          Log.error(`Process exited with code ${code}`);
        }
        Log.process_message("\n");
        Log.scroll_to_last_process_message();
        resolve(code);
      });
    });
  }

}