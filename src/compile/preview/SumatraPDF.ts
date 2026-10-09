import * as fs from "fs";
import * as path from "path";
import * as spawn from "cross-spawn";
import Config from "../../Config";
import { assertWorkspaceTrusted } from "../../WorkspaceTrust";

/** Starts SumatraPDF with forward and inverse SyncTeX arguments on Windows. */
export default class SumatraPDF {
  private static inverseSearchCommand(): string {
    // Sumatra substitutes %f and %l when it invokes this command. Quotes remain in
    // the argument because Sumatra parses the inverse-search command line itself.
    const configured = Config.sumatraPDFInverseSearchVSCodePath().trim();
    if (configured && !fs.existsSync(configured)) {
      throw new Error(`VS Code was not found at the configured inverse-search path: ${configured}`);
    }
    const vscodePath = configured || process.execPath;
    return `"${vscodePath.replace(/"/g, '\\"')}" -r -g "%f:%l"`;
  }

  private static executable(): string {
    // An explicit setting wins; otherwise check normal installation locations
    // before falling back to PATH lookup.
    const configured = Config.sumatraPDFPath().trim();
    if (configured) {
      if (!fs.existsSync(configured)) {
        throw new Error(`SumatraPDF was not found at the configured path: ${configured}`);
      }
      return configured;
    }

    const candidates = [
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "SumatraPDF", "SumatraPDF.exe"),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, "SumatraPDF", "SumatraPDF.exe"),
      process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"]!, "SumatraPDF", "SumatraPDF.exe")
    ].filter((candidate): candidate is string => Boolean(candidate));

    return candidates.find(candidate => fs.existsSync(candidate)) ?? "SumatraPDF.exe";
  }

  public static open(pdfPath: string, sourcePath?: string, line?: number): Promise<void> {
    try {
      assertWorkspaceTrusted("SumatraPDF preview");
    } catch (error) {
      return Promise.reject(error);
    }
    if (process.platform !== "win32") {
      return Promise.reject(new Error("SumatraPDF preview is available only on Windows."));
    }
    if (!fs.existsSync(pdfPath)) {
      return Promise.reject(new Error(`PDF file does not exist: ${pdfPath}`));
    }

    let executable: string;
    try {
      executable = this.executable();
    } catch (error) {
      return Promise.reject(error);
    }
    const args = [...Config.sumatraPDFArgs()];
    // Forward search should not resend inverse-search configuration. A reused
    // Sumatra instance retains it from a normal preview launch.
    if (sourcePath === undefined &&
        Config.sumatraPDFInverseSearchEnabled() &&
        !args.some(arg => arg.toLowerCase() === "-inverse-search")) {
      try {
        args.push("-inverse-search", this.inverseSearchCommand());
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (sourcePath && line !== undefined) {
      args.push("-forward-search", sourcePath, String(line));
    }
    args.push(pdfPath);

    return new Promise<void>((resolve, reject) => {
      const child = spawn.spawn(executable, args, {
        // Let inverse search launch VS Code as an editor, not as a Node.js process.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
        detached: true,
        stdio: "ignore",
        windowsHide: false,
        shell: false
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  }
}
