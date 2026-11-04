import * as fs from "fs";
import * as path from "path";
import * as spawn from "cross-spawn";
import Config from "../../Config";
import { assertWorkspaceTrusted } from "../../WorkspaceTrust";

/** WindowsでSyncTeXの順検索・逆検索引数を付けてSumatraPDFを起動する． */
export default class SumatraPDF {
  /**
   * SumatraPDFからVS Codeへ戻るための逆検索コマンドを作る．
   * 引数はない．
   * @returns VS Codeの起動先とファイル・行番号の置換記号を含むコマンド文字列．
   */
  private static inverseSearchCommand(): string {
    // SumatraPDFがこのコマンドを呼ぶ際に%fと%lを置き換える．逆検索のコマンド行はSumatraPDF自身が解析するため，引数の引用符を残す．
    const configured = Config.sumatraPDFInverseSearchVSCodePath().trim();
    if (configured && !fs.existsSync(configured)) {
      throw new Error(`VS Code was not found at the configured inverse-search path: ${configured}`);
    }
    const vscodePath = configured || process.execPath;
    return `"${vscodePath.replace(/"/g, '\\"')}" -r -g "%f:%l"`;
  }

  /**
   * 設定または既定のインストール先からSumatraPDFの実行ファイルを探す．
   * 引数はない．
   * @returns 起動に使用する実行ファイルのパス．
   */
  private static executable(): string {
    // 明示的な設定を優先する．未設定なら標準のインストール先を確認し，最後にPATHで探索する．
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

  /**
   * SumatraPDFでPDFを開き，指定時はソース位置へ順検索する．
   * @param pdfPath PDFファイルのファイルシステム上のパス．
   * @param sourcePath 順検索元のTeXソースのパス．省略可能．
   * @param line 1始まりのソース行番号．省略可能．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
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
    // 順検索では逆検索の設定を再送しない．既存のSumatraPDFは通常のプレビュー起動時に渡した設定を保持する．
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
        // 逆検索ではVS CodeをNode.jsプロセスとしてではなく，エディタとして起動する．
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
