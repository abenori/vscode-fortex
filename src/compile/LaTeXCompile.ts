import * as path from 'path';
import Process from './Process';
import LaTeXProject from '../project/LaTeXProject';
import TeXToPDF, { TeXToPDFResult } from './TeXToPDF';
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

/** Marker base class for parsed `%#!` build actions. */
class Action{}
/** Invokes one of fortex's built-in build stages. */
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

/** Owns LaTeX discovery, directive execution and adaptation to generic build reports. */
export default class LaTeXCompile {
  /** Keeps one discovered project; reusable requests construct a fresh instance on each run. */
  constructor(private readonly LaTeXProject: LaTeXProject, private readonly preview?: PDFPreview) {}

  /** Creates an inert request so the manager can reserve execution before source discovery. */
  public static createBuildRequest(source: vscode.Uri, preview?: PDFPreview): BuildRequest {
    return {
      source, label: 'LaTeX',
      /** Reads saved inputs afresh, including on queued execution and explicit rebuild. */
      async execute(context) {
        try {
          context.reportProgress('Processing saved sources…', source);
          const project = await LaTeXProject.create(source, {
            /** Cancels discovery at read boundaries without affecting other project consumers. */
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

  /** Runs directives and returns a complete diagnostic snapshot only after uncancelled execution. */
  private async build(context?: BuildContext): Promise<BuildResult> {
    const project = this.LaTeXProject;
    const directive = project.percent_sharp('!')?.trim();
    // Every nonempty %#! uses the request source, including engine-only and built-in forms.
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

  /** Adapts private pipeline callbacks; TeXToPDF never receives the manager's context. */
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
      const code = await new Process().execute(executable, args,
        path.dirname(this.LaTeXProject.mainfile.fsPath), false, context?.token);
      this.checkCancellation(context);
      if (code !== 0) { throw new Error(executable + ' exited with code ' + code + '.'); }
    }
    return { outcome: 'succeeded', severity: 'info', message: 'Command succeeded.' };
  }

  /** Keeps PDF viewer failures separate from the pipeline result and routes all notices through this owner. */
  private async updatePreview(pdfs: vscode.Uri[], context?: BuildContext): Promise<void> {
    /** Converts viewer messages to generic notices without leaking its reporting API. */
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

  /** Stops between actions and after preview requests, including asynchronous completion. */
  private checkCancellation(context?: BuildContext): void {
    if (context?.token.isCancellationRequested) { throw new vscode.CancellationError(); }
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
