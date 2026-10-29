import * as vscode from 'vscode';
import { DEFAULT_ALLOWED_PROGRAMS } from './compile/BuildSecurity';

export interface LaTeXEngineRule {
  classes?: string[];
  options?: string[];
  engine: string;
}

export type CompileProgram = 'bibtex' | 'makeindex' | 'dvipdf';

export interface CompileProgramSettings {
  command: string;
  args: string[];
}

export interface LaTeXEngineSettings extends CompileProgramSettings {
  output?: 'pdf' | 'dvi';
}

/** Centralized, typed access to the `vscode-fortex` configuration section. */
export default class Config {
  static readonly config_name = "vscode-fortex";
  private static get<T>(key: string, default_value: T) : T {
    // Keeping fallbacks here makes commands work even before package.json settings
    // have been migrated into a user's profile.
    return vscode.workspace.getConfiguration(Config.config_name).get<T>(key, default_value);
  }

  public static mainFileOrder(){
    return Config.get<string[]>("mainFileOrder", ["magic", "guess", "current"]);
  }

  public static completionScope(
    kind: 'label' | 'command' | 'environment',
    uri: vscode.Uri
  ): 'document' | 'project' {
    return vscode.workspace.getConfiguration(Config.config_name, uri)
      .get<string>('completion.' + kind + '.scope', 'document') === 'project' ? 'project' : 'document';
  }

  public static compileTrigger(){
    return Config.get<string[]>("compileTrigger", ["onSave"]);
  }

  public static allowedPrograms(): string[] {
    return Config.get<string[]>('compile.allowedPrograms', [...DEFAULT_ALLOWED_PROGRAMS]);
  }

  public static pdfViewer(): "internal" | "sumatra" {
    return Config.get<"internal" | "sumatra">("pdfViewer", "internal");
  }

  public static openPdfAfterBuild(): boolean {
    return Config.get<boolean>("openPdfAfterBuild", false);
  }

  public static sumatraPDFPath(): string {
    return Config.get<string>("sumatraPDF.path", "");
  }

  public static sumatraPDFArgs(): string[] {
    return Config.get<string[]>("sumatraPDF.args", ["-reuse-instance"]);
  }

  public static sumatraPDFInverseSearchEnabled(): boolean {
    return Config.get<boolean>("sumatraPDF.inverseSearch.enabled", true);
  }

  public static sumatraPDFInverseSearchVSCodePath(): string {
    return Config.get<string>("sumatraPDF.inverseSearch.vscodePath", "");
  }

  public static syncTeXPath(): string {
    return Config.get<string>("synctex.path", "synctex");
  }

  public static syncTeXForwardSearchFocus(): "editor" | "viewer" {
    return Config.get<"editor" | "viewer">("synctex.forwardSearch.focus", "editor");
  }

  public static kpsewhichPath(): string {
    return Config.get<string>("kpsewhich.path", "kpsewhich");
  }

  public static texdocPath(): string {
    return Config.get<string>("texdoc.path", "texdoc");
  }

  public static environmentIndentContent(): boolean {
    return Config.get<boolean>("environment.indentContent", true);
  }

  public static maxLaTeXRuns(): number {
    return Config.get<number>("compile.maxLaTeXRuns", 7);
  }

  public static latexEngineSelection(): 'source' | 'fixed' {
    const key = 'compile.latex.engineSelection';
    const selection = Config.get<unknown>(key, 'source');
    if (selection !== 'source' && selection !== 'fixed') {
      return Config.settingError(key, '"source" or "fixed"');
    }
    return selection;
  }

  public static latexEngine(): string {
    const key = 'compile.latex.engine';
    return Config.settingString(Config.get<unknown>(key, 'pdflatex'), key);
  }

  public static *latexEngineRules(): Iterable<LaTeXEngineRule> {
    const key = 'compile.latex.engineRules';
    const rules = Config.get<unknown>(key, [
      { classes: ['article', 'report', 'book'], engine: 'pdflatex' },
      { classes: ['jarticle', 'jreport', 'jbook'], engine: 'platex' },
      { classes: ['ujarticle', 'ujreport', 'ujbook'], engine: 'uplatex' },
      { classes: ['jsarticle', 'jsbook', 'jsreport'], options: ['uplatex'], engine: 'uplatex' },
      { classes: ['jsarticle', 'jsbook', 'jsreport'], engine: 'platex' },
      { classes: ['ltjsarticle', 'ltjsbook', 'ltjsreport'], engine: 'lualatex' },
      { classes: ['jlreq'], options: ['platex'], engine: 'platex' },
      { classes: ['jlreq'], options: ['lualatex'], engine: 'lualatex' },
      { classes: ['jlreq'], engine: 'uplatex' }
    ]);
    if (!Array.isArray(rules)) { return Config.settingError(key, 'an array of rules'); }
    // Validate rules as they are consumed; rules after the first match are unused.
    for (const [index, value] of rules.entries()) {
      const ruleKey = `${key}[${index}]`;
      const rule = Config.settingObject(value, ruleKey);
      yield {
        engine: Config.settingString(rule.engine, `${ruleKey}.engine`),
        classes: rule.classes === undefined ? undefined : Config.settingArgs(rule.classes, `${ruleKey}.classes`),
        options: rule.options === undefined ? undefined : Config.settingArgs(rule.options, `${ruleKey}.options`)
      };
    }
  }

  public static latexEngineSettings(engine: string, commandOverride?: string): LaTeXEngineSettings {
    const key = 'compile.latex.engines';
    const engines = Config.settingObject(Config.get<unknown>(key, {}), key);
    const engineKey = `${key}.${engine}`;
    const settings = Object.hasOwn(engines, engine) ? Config.settingObject(engines[engine], engineKey) : {};
    const command = commandOverride ?? (settings.command === undefined ? engine
      : Config.settingString(settings.command, `${engineKey}.command`));
    const args = settings.args === undefined ? [] : Config.settingArgs(settings.args, `${engineKey}.args`);
    const output = settings.output;
    if (output !== undefined && output !== 'pdf' && output !== 'dvi') {
      return Config.settingError(`${engineKey}.output`, '"pdf" or "dvi"');
    }
    return { command, args, output };
  }

  public static programSettings(program: CompileProgram, commandOverride?: string): CompileProgramSettings {
    const key = `compile.${program}`;
    const defaults: Record<CompileProgram, string> = {
      bibtex: 'upbibtex', makeindex: 'upmendex', dvipdf: 'dvipdfmx'
    };
    const settings = Config.settingObject(Config.get<unknown>(key, {}), key);
    const command = commandOverride ?? (settings.command === undefined ? defaults[program]
      : Config.settingString(settings.command, `${key}.command`));
    const args = settings.args === undefined ? [] : Config.settingArgs(settings.args, `${key}.args`);
    return { command, args };
  }

  private static settingError(key: string, expected: string): never {
    throw new Error(`Invalid ${Config.config_name}.${key}: expected ${expected}.`);
  }

  private static settingObject(value: unknown, key: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return Config.settingError(key, 'an object');
    }
    return value as Record<string, unknown>;
  }

  private static settingString(value: unknown, key: string): string {
    if (typeof value !== 'string' || !value.trim()) {
      return Config.settingError(key, 'a non-empty string');
    }
    return value;
  }

  private static settingArgs(value: unknown, key: string): string[] {
    if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
      return Config.settingError(key, 'an array of strings');
    }
    return [...value];
  }
}
