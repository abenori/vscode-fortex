import * as ChildProcess from 'child_process';
import * as path from 'path';
import * as spawn from 'cross-spawn';
import * as vscode from 'vscode';
import Config from '../Config';
import { assertWorkspaceTrusted } from '../WorkspaceTrust';

const searchTimeoutMilliseconds = 15000;
const maximumOutputBytes = 2 * 1024 * 1024;

export interface TexdocEntry {
  /** texdocのこの検索結果に対応する検索語． */
  query: string;
  /** 候補の評価値．値の優先順は，その検索・解析処理の規則に従う． */
  score: number;
  /** ドキュメントファイルのパス． */
  filePath: string;
  /** ドキュメントの言語．指定がなければ未設定． */
  language?: string;
  /** 項目の内容を示す説明． */
  description?: string;
}

/**
 * texdocのタブ区切り出力を，順位を変えずに解析する．
 * @param output 外部コマンドの標準出力．
 * @returns texdocが返した順序を保つ，パス・順位・言語・説明を含む検索結果．
 */
export function parseTexdocOutput(output: string): TexdocEntry[] {
  const entries: TexdocEntry[] = [];
  for (const [index, line] of output.split(/\r?\n/).entries()) {
    if (!line.trim()) {
      continue;
    }
    const [query, rawScore, filePath, language, description] = line.split('\t');
    if (!query?.trim() || !rawScore?.trim() || !Number.isFinite(Number(rawScore)) ||
      !filePath || !path.isAbsolute(filePath) || /[\0\r\n]/.test(filePath)) {
      throw new Error(`texdoc returned an invalid documentation list at line ${index + 1}. Check that vscode-fortex.texdoc.path points to TeX Live's texdoc.`);
    }
    // 先頭の3列だけを必須とする．補足情報は省略される場合があり，将来のtexdocで列が追加される可能性もある．
    entries.push({
      query,
      score: Number(rawScore),
      filePath,
      language: language || undefined,
      description: description || undefined
    });
  }
  return entries;
}

/** TeX Liveのtexdocで文書を検索し，ビューアの選択はtexdocの設定に従う． */
export default class TexdocService implements vscode.Disposable {
  /** 実行中のtexdocプロセスから，その要求を中止する関数への表． */
  private readonly processes = new Map<ChildProcess.ChildProcess, () => void>();
  /** 所有するリソースを解放し，新しい要求を受け付けない場合はtrue． */
  private disposed = false;

  /**
   * texdocでインストール済み文書を検索する．
   * @param query 現在入力されている検索文字列．
   * @param token 要求のキャンセルを確認するトークン．省略可能．
   * @returns texdocの順位順のドキュメント候補．Promiseで返す．
   */
  public async list(query: string, token?: vscode.CancellationToken): Promise<TexdocEntry[]> {
    if (!query.trim() || /[\0\r\n]/.test(query)) {
      throw new Error('Enter a documentation name on a single line.');
    }
    query = query.trim();
    const output = await this.run(['--list', '--machine', '--', query], true, token);
    return parseTexdocOutput(output);
  }

  /**
   * 選択したドキュメントをtexdocのビューアで開く．
   * @param filePath 操作するファイルのパス．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
  public async open(filePath: string): Promise<void> {
    if (!path.isAbsolute(filePath) || /[\0\r\n]/.test(filePath)) {
      throw new Error('texdoc requires an absolute documentation file path.');
    }
    await this.run(['--nointeract', '--just-view', filePath], false);
  }

  /**
   * 所有する監視・購読・表示などのリソースを解放する．
   * 引数はない．
   * @returns なし．
   */
  public dispose(): void {
    this.disposed = true;
    for (const cancel of this.processes.values()) {
      cancel();
    }
    this.processes.clear();
  }

  /**
   * texdocを起動し，検索時のキャンセルとタイムアウトを管理する．
   * @param args 呼び出し先へ渡す引数．
   * @param searching 文書検索としてタイムアウトとキャンセルを管理する場合はtrue．
   * @param token 要求のキャンセルを確認するトークン．省略可能．
   * @returns texdocの標準出力．起動失敗や異常終了では例外．Promiseで返す．
   */
  private run(args: string[], searching: boolean, token?: vscode.CancellationToken): Promise<string> {
    assertWorkspaceTrusted('TeX documentation');
    if (this.disposed || token?.isCancellationRequested) {
      return Promise.reject(new vscode.CancellationError());
    }
    const executable = Config.texdocPath().trim() || 'texdoc';
    return new Promise((resolve, reject) => {
      let child: ChildProcess.ChildProcess;
      try {
        child = spawn.spawn(executable, args, {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (error) {
        reject(startError(error, executable));
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      let cancellation: vscode.Disposable | undefined;
      const finish = (error?: Error, output = '') => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        cancellation?.dispose();
        this.processes.delete(child);
        child.stdout?.removeListener('data', collectStdout);
        child.stderr?.removeListener('data', collectStderr);
        if (error) {
          reject(error);
        } else {
          resolve(output);
        }
      };
      const terminate = (error: Error) => {
        if (settled) {
          return;
        }
        finish(error);
        child.kill();
      };
      const collect = (buffers: Buffer[], chunk: Buffer | string) => {
        if (settled) {
          return;
        }
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += buffer.length;
        if (outputBytes > maximumOutputBytes) {
          terminate(new Error('texdoc returned too much output. Try a more specific documentation name.'));
          return;
        }
        buffers.push(buffer);
      };
      const collectStdout = (chunk: Buffer | string) => collect(stdout, chunk);
      const collectStderr = (chunk: Buffer | string) => collect(stderr, chunk);
      const cancel = () => terminate(new vscode.CancellationError());
      this.processes.set(child, cancel);
      child.stdout?.on('data', collectStdout);
      child.stderr?.on('data', collectStderr);
      child.once('error', (error) => finish(startError(error, executable)));
      child.once('close', (code, signal) => {
        if (code === 0) {
          finish(undefined, Buffer.concat(stdout).toString('utf8'));
        } else if (searching && code === 3) {
          // TeX Liveでは，該当する文書がない場合の終了コードに3を使用する．
          finish();
        } else {
          const detail = Buffer.concat(stderr).toString('utf8').trim().slice(0, 2000);
          const reason = signal ? `signal ${signal}` : `exit code ${code}`;
          finish(new Error(`texdoc failed (${reason})${detail ? `: ${detail}` : '.'}`));
        }
      });
      // 文書表示は外部アプリケーションの終了まで待つ場合があるため，検索にだけ制限時間を設ける．拡張機能の終了時にはどちらも停止できる．
      if (searching) {
        timeout = setTimeout(() => {
          terminate(new Error('texdoc documentation search timed out after 15 seconds.'));
        }, searchTimeoutMilliseconds);
      }
      cancellation = token?.onCancellationRequested(cancel);
      if (settled) {
        cancellation?.dispose();
      } else if (token?.isCancellationRequested) {
        cancel();
      }
    });
  }
}

/**
 * 外部コマンドの起動失敗を表示用のエラーへ変換する．
 * @param error 失敗の理由を表す例外または値．
 * @param executable 起動する実行ファイル名またはパス．
 * @returns 実行ファイル名と起動失敗の理由を含むError．
 */
function startError(error: unknown, executable: string): Error {
  if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
    return new Error(`Cannot find texdoc (${executable}). Install TeX Live or set vscode-fortex.texdoc.path to its texdoc executable.`);
  }
  return new Error(`Cannot start texdoc (${executable}): ${error instanceof Error ? error.message : String(error)}`);
}
