import * as path from "path";
import * as spawn from "cross-spawn";
import Config from "../Config";

export type SyncTeXForwardResult = {
  page: number;
  x: number;
  y: number;
  h: number;
  v: number;
  width: number;
  height: number;
};

export type SyncTeXEditResult = {
  input: string;
  line: number;
  column: number;
};

type RecordValues = Record<string, string>;

export default class SyncTeX {
  public static async forward(
    pdfPath: string,
    inputPath: string,
    line: number,
    column: number
  ): Promise<SyncTeXForwardResult> {
    const output = await this.execute([
      "view",
      "-i",
      `${line}:${column}:${inputPath}`,
      "-o",
      pdfPath
    ], path.dirname(pdfPath));
    const record = this.records(output, "page")[0];
    if (!record) {
      throw new Error("No matching position was found in the SyncTeX data.");
    }

    return {
      page: this.number(record, "page"),
      x: this.number(record, "x"),
      y: this.number(record, "y"),
      h: this.number(record, "h"),
      v: this.number(record, "v"),
      width: this.number(record, "width"),
      height: Math.abs(this.number(record, "height"))
    };
  }

  public static async edit(pdfPath: string, page: number, x: number, y: number): Promise<SyncTeXEditResult> {
    const output = await this.execute([
      "edit",
      "-o",
      `${page}:${x}:${y}:${pdfPath}`
    ], path.dirname(pdfPath));
    const record = this.records(output, "input")[0];
    if (!record?.input) {
      throw new Error("No source position was found in the SyncTeX data.");
    }
    return {
      input: record.input,
      line: this.number(record, "line"),
      column: Number(record.column ?? "-1")
    };
  }

  private static records(output: string, startKey: string): RecordValues[] {
    const records: RecordValues[] = [];
    let current: RecordValues = {};
    for (const line of output.split(/\r?\n/)) {
      const match = /^([^:]+):(.*)$/.exec(line);
      if (!match) {
        continue;
      }
      const rawKey = match[1].trim();
      const key = rawKey === "W" ? "width" : rawKey === "H" ? "height" : rawKey.toLowerCase();
      if (key === startKey && current[startKey] !== undefined) {
        records.push(current);
        current = {};
      }
      current[key] = match[2].trim();
    }
    if (current[startKey] !== undefined) {
      records.push(current);
    }
    return records;
  }

  private static number(record: RecordValues, ...keys: string[]): number {
    for (const rawKey of keys) {
      const value = record[rawKey.toLowerCase()];
      if (value !== undefined) {
        const result = Number(value);
        if (Number.isFinite(result)) {
          return result;
        }
      }
    }
    throw new Error(`Invalid SyncTeX response: missing ${keys[0]}.`);
  }

  private static execute(args: string[], cwd: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn.spawn(Config.syncTeXPath(), args, {
        cwd,
        shell: false,
        windowsHide: true
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      child.stdout?.on("data", data => stdout.push(Buffer.from(data)));
      child.stderr?.on("data", data => stderr.push(Buffer.from(data)));
      child.once("error", error => {
        settled = true;
        reject(new Error(`Could not run ${Config.syncTeXPath()}: ${error.message}`));
      });
      child.once("close", code => {
        if (settled) {
          return;
        }
        const output = Buffer.concat(stdout).toString("utf8");
        if (code === 0 && output.includes("SyncTeX result begin")) {
          resolve(output);
          return;
        }
        const details = Buffer.concat(stderr).toString("utf8").trim();
        reject(new Error(details || `SyncTeX exited with code ${code}. Check that the .synctex.gz file exists.`));
      });
    });
  }
}
