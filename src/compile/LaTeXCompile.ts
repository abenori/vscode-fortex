import * as path from 'path';
import Process from './Process';
import LaTeXProject from '../project/LaTeXProject';
import TeXToPDF, { TeXToPDFResult } from './TeXToPDF/TeXToPDF';
import Log from '../log';
import * as vscode from 'vscode';
import type { BuildContext, BuildRequest, BuildResult } from './BuildProtocol';
import type PDFPreview from './preview/PDFPreview';
import * as Workspace from '../workspace';
import Config from '../Config';
import {
  assertProgramAllowed,
  findCommandSeparator,
  parseCommandLine,
  singleProgramFromDirective
} from './BuildSecurity';

/** 解析済みの%#!ビルド処理を分類するための基底クラス． */
class Action{}
/** fortexに組み込まれたビルド処理を呼び出す． */
class CommandAction extends Action{
  /** 組み込みビルド処理の名前． */
  action = "";
  /** 組み込みビルド処理へ渡すオプション文字列． */
  option = "";
  /**
   * CommandActionの初期状態と所有するリソースを準備する．
   * @param cmd 解析するコマンド文字列．
   * @param option 処理名に付随するオプション文字列．
   * @returns 新しいインスタンス．コンストラクタから明示的な値は返さない．
   */
  public constructor(cmd: string, option: string){
    super();
    this.action = cmd;
    this.option = option;
  }
}
/** 解析済みの%#!コマンドを，シェルを使わず直接実行する． */
class ExecuteAction extends Action{
  /** 起動する実行ファイル名またはパス． */
  executable: string;
  /** 実行ファイルへ個別に渡す追加引数．シェル用の引用符は加えない． */
  args: string[];
  /**
   * ExecuteActionの初期状態と所有するリソースを準備する．
   * @param cmd 解析するコマンド文字列．
   * @returns 新しいインスタンス．コンストラクタから明示的な値は返さない．
   */
  public constructor(cmd : string){
    super();
    const parsed = parseCommandLine(cmd.trim());
    this.executable = parsed.executable;
    this.args = parsed.args;
  }
}

/** LaTeXプロジェクトの探索，ソース指示の実行，共通のビルド通知への変換を担当する． */
export default class LaTeXCompile {
  /**
   * 探索済みのプロジェクトを保持する．再実行可能な要求は実行のたびに新しいインスタンスを作る．
   * @param LaTeXProject ビルド対象のメインファイルと関連ファイルを含むプロジェクト．
   * @param preview ビルド後のPDF表示を担当するサービス．省略可能．
   * @returns 新しいインスタンス．コンストラクタから明示的な値は返さない．
   */
  constructor(/** ビルド対象のメインファイルと関連ファイルの情報． */ private readonly LaTeXProject: LaTeXProject, /** ビルド後のPDF表示サービス． */ private readonly preview?: PDFPreview) {}

  /**
   * ソース探索の前に管理側が実行権を確保できるよう，まだ処理を開始しない要求を作る．
   * @param source 対象ソースのURI．
   * @param preview ビルド後のPDF表示を担当するサービス．省略可能．
   * @returns ソースURIと実行処理を保持する，まだ開始していないビルド要求．
   */
  public static createBuildRequest(source: vscode.Uri, preview?: PDFPreview): BuildRequest {
    return {
      source, label: 'LaTeX',
      /**
       * 待機列からの実行や明示的な再ビルドでも，保存済みの入力を読み直す．
       * @param context キャンセルトークンと，ビルドの進捗・通知を受け取る関数．
       * @returns 対象プロジェクトのビルド結果．Promiseで返す．
       */
      async execute(context) {
        try {
          context.reportProgress('Processing saved sources…', source);
          const project = await LaTeXProject.create(source, {
            readSource: async uri => {
              if (context.token.isCancellationRequested) { throw new vscode.CancellationError(); }
              const text = await Workspace.readFileText(uri);
              if (context.token.isCancellationRequested) { throw new vscode.CancellationError(); }
              return text;
            }
          });
          if (context.token.isCancellationRequested) { throw new vscode.CancellationError(); }
          return await new LaTeXCompile(project, preview).build(context);
        } catch (error) {
          if (context.token.isCancellationRequested || error instanceof vscode.CancellationError) {
            return { outcome: 'cancelled', severity: 'info', message: 'Build cancelled.' };
          }
          const message = error instanceof Error ? error.message : String(error);
          Log.error(message);
          return { outcome: 'failed', severity: 'error', message };
        }
      }
    };
  }

  /**
   * ソース指示を実行し，キャンセルされずに終了した場合だけ診断全体のスナップショットを返す．
   * @param context キャンセルトークンと，ビルドの進捗・通知を受け取る関数．省略可能．
   * @returns ビルドの成否と，未キャンセル時の診断スナップショット．Promiseで返す．
   */
  private async build(context?: BuildContext): Promise<BuildResult> {
    const project = this.LaTeXProject;
    const directive = project.percent_sharp('!')?.trim();
    // 空でない%#!指示では，エンジン名だけの指定や組み込み処理の指定も含めて要求元のソースを使用する．
    const key = directive ? project.file ?? project.mainfile : project.mainfile;
    const entries: [vscode.Uri, vscode.Diagnostic[]][] = [];
    const warnings: string[] = [];
    const pdfs = new Map<string, vscode.Uri>();
    let lastMessage = 'Build succeeded.';
    try {
      this.checkCancellation(context);
      context?.reportProgress('Preparing build…', project.mainfile);
      const actions = directive && singleProgramFromDirective(directive) === undefined
        ? LaTeXCompile.parse_action(directive) : [new CommandAction('TeXToPDF', '')];
      this.validate_percent_sharp_programs(actions);
      for (const action of actions) {
        this.checkCancellation(context);
        const result = await this.execute_action(action, context);
        this.checkCancellation(context);
        if (result.outcome === 'cancelled') {
          return { outcome: 'cancelled', severity: 'info', message: result.message };
        }
        entries.push(...result.diagnostics ?? []);
        for (const pdf of result.pdfs ?? []) { pdfs.set(Workspace.uriKey(pdf), pdf); }
        if (result.outcome === 'failed') {
          return { outcome: 'failed', severity: 'error', message: result.message, diagnostics: { key, entries } };
        }
        if (result.severity !== 'info') { warnings.push(result.message); }
        lastMessage = result.message;
      }
      if (pdfs.size && this.preview) { await this.updatePreview([...pdfs.values()], context); }
      this.checkCancellation(context);
      const message = warnings.length ? warnings.join(' ') : lastMessage;
      Log.log(message);
      return {
        outcome: 'succeeded', severity: warnings.length ? 'warning' : 'info', message,
        diagnostics: { key, entries }
      };
    } catch (error) {
      if (context?.token.isCancellationRequested || error instanceof vscode.CancellationError) {
        return { outcome: 'cancelled', severity: 'info', message: 'Build cancelled.' };
      }
      const message = error instanceof Error ? error.message : String(error);
      Log.error(message);
      return { outcome: 'failed', severity: 'error', message, diagnostics: { key, entries } };
    }
  }

  /** ビルド処理専用のコールバックへ変換する．TeXToPDFには管理側のコンテキストを渡さない． */
  /**
   * 1つの組み込み処理，または独立して管理する外部プロセスを実行する．
   * @param action 実行する処理．
   * @param context キャンセルトークンと，ビルドの進捗・通知を受け取る関数．省略可能．
   * @returns 処理の成否，通知の重要度，メッセージ，および生成したPDFや診断情報．Promiseで返す．
   */
  private async execute_action(action: Action, context?: BuildContext): Promise<TeXToPDFResult> {
    if (action instanceof CommandAction) {
      if (action.action.toLowerCase() !== 'textopdf') { throw new Error('Unknown action command: ' + action.action); }
      return new TeXToPDF(this.LaTeXProject, action.option).build({
        token: context?.token,
        onProgress: message => context?.reportProgress(message)
      });
    }
    if (action instanceof ExecuteAction) {
      const executable = this.expand_placeholders(action.executable);
      const args = action.args.map(arg => this.expand_placeholders(arg));
      context?.reportProgress('Running ' + executable + '…');
      Log.process_message('Executing command: %s\n', LaTeXCompile.format_command(executable, args));
      const code = await new Process(executable, args,
        path.dirname(this.LaTeXProject.mainfile.fsPath)).execute(context?.token);
      this.checkCancellation(context);
      if (code !== 0) { throw new Error(executable + ' exited with code ' + code + '.'); }
    }
    return { outcome: 'succeeded', severity: 'info', message: 'Command succeeded.' };
  }

  /**
   * PDFビューアの失敗をビルド処理の結果と分け，この所有者を通してすべての通知を伝える．
   * @param pdfs 今回のビルドで生成したPDFのURIの一覧．
   * @param context キャンセルトークンと，ビルドの進捗・通知を受け取る関数．省略可能．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
  private async updatePreview(pdfs: vscode.Uri[], context?: BuildContext): Promise<void> {
    const report = (message?: string) => {
      context?.reportNotice(message === undefined ? undefined : {
        severity: 'warning', message: 'PDF generated, but preview update failed: ' + message
      });
    };
    try {
      this.checkCancellation(context);
      await this.preview!.onBuildComplete(pdfs, context?.token,
        message => context?.reportProgress(message), report);
    } catch (error) {
      this.checkCancellation(context);
      if (error instanceof vscode.CancellationError) { throw error; }
      report(error instanceof Error ? error.message : String(error));
    }
    this.checkCancellation(context);
  }

  /**
   * 処理段階の間とプレビュー要求の後でキャンセルを確認する．非同期処理の完了後も確認する．
   * @param context キャンセルトークンと，ビルドの進捗・通知を受け取る関数．省略可能．
   * @returns なし．
   */
  private checkCancellation(context?: BuildContext): void {
    if (context?.token.isCancellationRequested) { throw new vscode.CancellationError(); }
  }

  /**
   * ソース指示で起動するプログラムが許可リストに含まれることを確認する．
   * @param actions 実行順に並んだビルド処理．
   * @returns なし．
   */
  private validate_percent_sharp_programs(actions: Action[]): void {
    const allowedPrograms = Config.allowedPrograms();
    const buildDirective = this.LaTeXProject.percent_sharp('!')?.trim();
    if (buildDirective) {
      const engine = singleProgramFromDirective(buildDirective);
      if (engine !== undefined) {
        assertProgramAllowed(this.expand_placeholders(engine), allowedPrograms, '%#!');
      }
    }

    // これらの指示は標準のビルド手順で使う補助プログラムを選ぶ．今回のビルドで文献・索引・DVI変換が不要でも，すべての指定をこの時点で検証する．
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

  /**
   * ビルドコマンド中のファイル名プレースホルダをプロジェクトのパスへ置き換える．
   * @param value 変換または検証する値．
   * @returns プレースホルダを展開した文字列．
   */
  private expand_placeholders(value: string): string {
    // 小文字の置換記号は現在のソース，大文字は検出したメインファイルを表す．引数の分割後に展開するため，空白を含むパスも1つの引数として保持する．
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

  /**
   * 実行ファイルと引数をログ表示用のコマンド文字列にまとめる．
   * @param executable 起動する実行ファイル名またはパス．
   * @param args 呼び出し先へ渡す引数．
   * @returns 空白を含む要素を引用符で囲んだ表示用文字列．
   */
  private static format_command(executable: string, args: string[]): string {
    return [executable, ...args].map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(' ');
  }

  /**
   * 区切りの前後の空白を許容し，組み込み処理と外部コマンドを解析する．
   * @param action 実行する処理．
   * @returns 指示に記載された順序の組み込み処理・外部コマンド．
   */
  private static parse_action(action: string): Action[] {
    // 組み込み処理の記法は$(C:name:option)．括弧の深さを追跡するため，オプション自体に括弧を含められる．
    action = action.trim();
    let parse_top = 0;
    let rv : Action[] = [];
    while(true){
      while(/\s/.test(action.substring(parse_top,parse_top + 1))){
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
        while(/\s/.test(action.substring(parse_top,parse_top + 1))){
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
