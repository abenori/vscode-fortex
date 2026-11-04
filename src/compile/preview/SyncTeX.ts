import * as path from "path";
import * as spawn from "cross-spawn";
import Config from "../../Config";
import { assertWorkspaceTrusted } from "../../WorkspaceTrust";

export type SyncTeXForwardResult = {
  /** 1始まりのPDFページ番号． */
  page: number;
  /** SyncTeXが返す横座標．単位はPDFポイント． */
  x: number;
  /** SyncTeXが返す縦座標．単位はPDFポイント． */
  y: number;
  /** SyncTeXが返す対応矩形の水平方向の基準座標．単位はPDFポイント． */
  h: number;
  /** SyncTeXが返す対応矩形の垂直方向の基準座標．単位はPDFポイント． */
  v: number;
  /** 対応矩形の幅．単位はPDFポイント． */
  width: number;
  /** 対応矩形の高さの絶対値．単位はPDFポイント． */
  height: number;
};

export type SyncTeXEditResult = {
  /** 元のTeXソースファイルのパス． */
  input: string;
  /** 1始まりのソース行番号． */
  line: number;
  /** SyncTeXのソース列番号．不明の場合は-1． */
  column: number;
};

type RecordValues = Record<string, string>;

/** synctexコマンドを実行し，文字列の検索結果を型付きの位置情報へ変換する． */
export default class SyncTeX {
  /**
   * ソースの行と列をPDFページ上の矩形へ対応付ける．
   * @param pdfPath PDFファイルのファイルシステム上のパス．
   * @param inputPath 対応するTeXソースのファイルシステム上のパス．
   * @param line 1始まりのソース行番号．
   * @param column ソース内の列番号．
   * @returns 指定したソース位置に対応するPDFのページ番号，座標，および矩形の大きさ．Promiseで返す．
   */
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

  /**
   * PDFのページ座標を元のTeXソースの位置へ変換する．
   * @param pdfPath PDFファイルのファイルシステム上のパス．
   * @param page 1始まりのPDFページ番号．
   * @param x PDFページ上の横座標．
   * @param y PDFページ上の縦座標．
   * @returns 入力ファイルのパス，1始まりの行番号，および列番号．不明な列番号は-1．Promiseで返す．
   */
  public static async edit(pdfPath: string, page: number, x: number, y: number): Promise<SyncTeXEditResult> {
    // 逆検索でPDF座標を入力ファイルとソース行へ対応付ける．
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

  /**
   * SyncTeXのkey:value形式の出力を検索結果ごとのレコードへ分割する．
   * @param output 外部コマンドの標準出力．
   * @param startKey 新しいSyncTeX検索結果の先頭を識別するキー．
   * @returns キーを正規化した検索結果の配列．
   */
  private static records(output: string, startKey: string): RecordValues[] {
    // 繰り返されるkey:value形式の結果には外側の区切りがない．最初のキーが再び現れたら，次の検索結果の開始とみなす．
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

  /**
   * SyncTeXレコードから候補キーに対応する有限数を取得する．
   * @param record SyncTeXの1件の検索結果を表すキーと文字列値の表．
   * @param keys 処理対象のキー．
   * @returns 最初に見つかった有効な数値．有効な値がなければ例外を送出する．
   */
  private static number(record: RecordValues, ...keys: string[]): number {
    // 不正な出力をここで拒否し，原因を調べにくくなるNaNの座標をビューアへ渡さないようにする．
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

  /**
   * SyncTeXを作業ディレクトリで起動する．
   * @param args 呼び出し先へ渡す引数．
   * @param cwd 外部コマンドを実行する作業ディレクトリのパス．
   * @returns 正常に検索結果を含む標準出力．起動・検索の失敗時は例外．Promiseで返す．
   */
  private static execute(args: string[], cwd: string): Promise<string> {
    assertWorkspaceTrusted("SyncTeX");
    // シェルを介さずにパスを渡し，追加の引用処理を避ける．失敗理由の説明に使うため標準エラーも保持する．
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
