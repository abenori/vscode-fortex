import * as vscode from 'vscode';
import * as path from 'path';
import Config from "../Config";
import * as Workspace from '../workspace';
import * as LaTeXParser from '../latex-parser';
import { resolveInputFile } from './InputFileResolver';
import type { InputToken } from './InputFileResolver';
import { MacroState } from './InputMacros';

type LaTeXFileType = typeof LaTeXProject.LaTeXFileType[keyof typeof LaTeXProject.LaTeXFileType];

interface IncludedFile {
  readonly uri: vscode.Uri;
  readonly type: LaTeXFileType;
}

/** Missing references remain available to builds but are omitted from source searches. */
interface ProjectFileEntry extends IncludedFile {
  readonly exists: boolean;
}

type ProjectDescription = [
  file: vscode.Uri | null,
  main: vscode.Uri,
  classFile: string,
  classOption: string,
  directives: { [key: string]: string }
];

interface ProjectSource {
  readonly syntax: LaTeXParser.LaTeXSource;
}

/** Source selection and discovery notifications; callers own refreshes and watches. */
export interface ProjectReadOptions {
  /** Defaults to editor-buffer-first reading. Called once per URI, without later replacement or retry. */
  readonly readSource?: (uri: vscode.Uri) => Promise<string>;
  /** Reports each read/existence candidate once, including missing files, so the caller can watch it. */
  readonly onDependency?: (uri: vscode.Uri) => void;
  /** Reports each directory searched for main-file candidates once. */
  readonly onDirectory?: (uri: vscode.Uri) => void;
}

interface ProjectRequest {
  readonly lifetime: number;
  readonly options: ProjectReadOptions;
  readonly order: readonly string[];
  readonly sources: Map<string, Promise<ProjectSource>>;
  readonly dependencies: Set<string>;
  readonly directories: Set<string>;
}

/**
 * Describes the active LaTeX project and locates its main document.
 *
 * Main-file detection applies the user-configured strategies in order: `%#main`,
 * recursive parent discovery, and finally treating the current file as main.
 */
export default class LaTeXProject {
  private static lifetime = 0;

  /** Cancel pending requests without retaining project state between requests. */
  public static dispose(): void {
    LaTeXProject.lifetime++;
  }

  private static async request<T>(options: ProjectReadOptions, run: (request: ProjectRequest) => Promise<T>): Promise<T> {
    // Inputs are captured as they are first read. Changes affect the next call,
    // rather than restarting an operation that is already in progress.
    const request: ProjectRequest = {
      lifetime: LaTeXProject.lifetime, options, order: [...Config.mainFileOrder()],
      sources: new Map(), dependencies: new Set(), directories: new Set()
    };
    try {
      const result = await run(request);
      LaTeXProject.checkRequest(request);
      return result;
    } catch (error) {
      LaTeXProject.checkRequest(request);
      throw error;
    }
  }

  private static checkRequest(request: ProjectRequest): void {
    if (request.lifetime !== LaTeXProject.lifetime) { throw new vscode.CancellationError(); }
  }

  private static dependency(request: ProjectRequest, uri: vscode.Uri): boolean {
    LaTeXProject.checkRequest(request);
    const key = Workspace.uriKey(uri);
    if (request.dependencies.has(key)) { return false; }
    request.dependencies.add(key);
    request.options.onDependency?.(uri);
    return true;
  }

  private static async readSource(request: ProjectRequest, file: vscode.Uri): Promise<ProjectSource> {
    LaTeXProject.dependency(request, file);
    const key = Workspace.uriKey(file);
    let pending = request.sources.get(key);
    if (!pending) {
      pending = (async () => {
        const source = await (request.options.readSource?.(file) ?? Workspace.readDocumentText(file));
        LaTeXProject.checkRequest(request);
        return { syntax: new LaTeXParser.LaTeXSource(source) };
      })();
      request.sources.set(key, pending);
    }
    return pending;
  }

  static readonly LaTeXFileType = {
    main: 0,
    include: 1,
    input: 2,
  } as const;
  private file_: vscode.Uri | null = null;
  get file(): vscode.Uri | null { return this.file_; }
  private mainfile_: vscode.Uri;
  get mainfile(): vscode.Uri { return this.mainfile_; }
  private classfile_: string = "";
  get classfile(): string { return this.classfile_; }
  private classoption_: string = "";
  get classoption(): string { return this.classoption_; }
  private readonly filelist_: readonly ProjectFileEntry[];
  /** Unique references in traversal order, with existence recorded at creation. */
  get filelist(): readonly ProjectFileEntry[] { return this.filelist_; }
  private percent_sharp_: { [key: string]: string } = {};
  public percent_sharp(key: string): string | undefined {
    return this.percent_sharp_[key];
  }

  private constructor([file, main, classFile, classOption, directives]: ProjectDescription, entries: readonly ProjectFileEntry[]) {
    this.file_ = file;
    this.mainfile_ = main;
    this.classfile_ = classFile;
    this.classoption_ = classOption;
    this.percent_sharp_ = directives;
    this.filelist_ = entries;
  }

  /** Return a project only after its complete file list has been collected. */
  public static async create(file: vscode.Uri | null, options: ProjectReadOptions = {}): Promise<LaTeXProject> {
    return LaTeXProject.request(options, async request => {
      const description = await LaTeXProject.generate_project(request, file);
      const entries = await LaTeXProject.collectProjectEntries(request, description[1]);
      return new LaTeXProject(description, entries);
    });
  }

  private static async get_class_option_from_main(request: ProjectRequest, main: vscode.Uri): Promise<[string, string]> {
    const parsed = await LaTeXProject.readSource(request, main);
    return LaTeXProject.get_classfile(parsed.syntax);
  }
  private static async fileExists(request: ProjectRequest, file: vscode.Uri): Promise<boolean> {
    LaTeXProject.dependency(request, file);
    let exists = false;
    try {
      const stat = await vscode.workspace.fs.stat(file);
      exists = (stat.type & vscode.FileType.File) !== 0;
    } catch { /* An unavailable candidate cannot be selected as main. */ }
    LaTeXProject.checkRequest(request);
    return exists;
  }
  private static async mainFromMagic(file: vscode.Uri, directives: { [key: string]: string }): Promise<vscode.Uri | undefined> {
    const name = directives.main?.trim();
    if (!name) { return undefined; }
    const main = vscode.Uri.file(path.resolve(path.dirname(file.fsPath), name));
    return main;
  }

  private static async mainFromCurrentFile(file: vscode.Uri): Promise<vscode.Uri | undefined> {
    return file;
  }

  /** Resolve the main URI without an additional file-list collection. */
  public static async resolveMainFile(file: vscode.Uri | null, options: ProjectReadOptions = {}): Promise<vscode.Uri> {
    return LaTeXProject.request(options, async request => (await LaTeXProject.generate_project(request, file))[1]);
  }

  private static async generate_project(request: ProjectRequest, f: vscode.Uri | null): Promise<ProjectDescription> {
    const file = f ?? vscode.window.activeTextEditor?.document.uri;
    if (!file) { throw new Error("Cannot get the current file"); }
    const parsed = await LaTeXProject.readSource(request, file);
    const directives = LaTeXProject.parse_percent_sharp_doc(parsed.syntax);
    const main = await LaTeXProject.discoverMain(request, file, directives, request.order);
    const [cls, options] = await LaTeXProject.get_class_option_from_main(request, main);
    return [f, main, cls, options, directives];
  }

  private static async discoverMain(request: ProjectRequest, file: vscode.Uri, directives: { [key: string]: string }, order: readonly string[]): Promise<vscode.Uri> {
    // Strategies are data-driven so changing `mainFileOrder` does not duplicate
    // the validation and result assembly below.
    const strategies = new Map<string, () => Promise<vscode.Uri | undefined>>([
      ['magic', () => LaTeXProject.mainFromMagic(file, directives)],
      ['guess', () => LaTeXProject.guessMainFile(request, file)],
      ['current', () => LaTeXProject.mainFromCurrentFile(file)]
    ]);
    for (const name of order) {
      const main = await strategies.get(name)?.();
      if (main && await LaTeXProject.fileExists(request, main)) { return main; }
    }
    throw new Error("The main cannot be found.");
  }

  // [class,option]を返す
  private static get_classfile(source: string | LaTeXParser.SourceScanner | LaTeXParser.LaTeXSource): [string, string] {
    const syntax = source instanceof LaTeXParser.LaTeXSource ? source : new LaTeXParser.LaTeXSource(source);
    const scanner = syntax.sourceScanner;
    const parsed = syntax.documentParser;
    const declaration = parsed.declarations.find(item => item.kind === 'documentClass' && item.complete);
    if (!declaration?.argument) { return ["", ""]; }
    const name = scanner.textWithoutComments(declaration.argument.contentStart, declaration.argument.contentEnd)?.trim() ?? '';
    const options = declaration.options;
    return [name, options ? scanner.textWithoutComments(options.contentStart, options.contentEnd) ?? '' : ''];
  }

  private static async guessMainFile(request: ProjectRequest, file: vscode.Uri): Promise<vscode.Uri | undefined> {
    const [cls] = await LaTeXProject.get_class_option_from_main(request, file);
    if (cls) { return file; }
    let directory = vscode.Uri.file(path.dirname(file.fsPath));
    // Search every ancestor. A candidate is accepted only when it has a
    // document class and recursively includes the active file.
    while (true) {
      const main = await LaTeXProject.findMainInDirectory(request, directory, file);
      if (main) { return main; }
      const parent = vscode.Uri.file(path.dirname(directory.fsPath));
      if (Workspace.uriKey(parent) === Workspace.uriKey(directory)) { break; }
      directory = parent;
    }
    return undefined;
  }

  private static async findMainInDirectory(request: ProjectRequest, directory: vscode.Uri, target: vscode.Uri): Promise<vscode.Uri | undefined> {
    // Only top-level documents in this directory are candidates; recursive
    // inclusion is checked by collectProjectFiles for each candidate.
    try {
      LaTeXProject.checkRequest(request);
      const key = Workspace.uriKey(directory);
      if (!request.directories.has(key)) {
        request.directories.add(key);
        request.options.onDirectory?.(directory);
      }
      const files = await vscode.workspace.fs.readDirectory(directory);
      LaTeXProject.checkRequest(request);
      for (const file of files) {
        if (file[1] === vscode.FileType.Directory) { continue; }
        if (path.extname(file[0]).toLowerCase() !== ".tex") { continue; }
        const filepath = vscode.Uri.joinPath(directory, file[0]);
        try {
          const [cls] = await LaTeXProject.get_class_option_from_main(request, filepath);
          if (!cls) { continue; }
          const projectFiles = await LaTeXProject.collectProjectFiles(request, filepath);
          if (projectFiles.some((projectFile) => Workspace.uriKey(projectFile) === Workspace.uriKey(target))) {
            return filepath;
          }
        } catch (error) {
          if (error instanceof vscode.CancellationError) { throw error; }
          continue;
        }
      }
      return undefined;

    }
    catch (error) {
      if (error instanceof vscode.CancellationError) { throw error; }
      return undefined;
    }
  }

  private static async collectProjectEntries(request: ProjectRequest, main: vscode.Uri): Promise<ProjectFileEntry[]> {
    const entries: ProjectFileEntry[] = [];
    const listed = new Set<string>();
    const ancestors = new Set<string>();
    const macros = new MacroState();
    const directory = vscode.Uri.file(path.dirname(main.fsPath));
    let visits = 0;
    const visit = async (entry: IncludedFile, knownExists?: boolean): Promise<void> => {
      LaTeXProject.checkRequest(request);
      const key = Workspace.uriKey(entry.uri);
      LaTeXProject.dependency(request, entry.uri);
      const exists = knownExists ?? await LaTeXProject.fileExists(request, entry.uri);
      if (!listed.has(key)) {
        listed.add(key);
        entries.push({ ...entry, exists });
      }
      if (!exists || ancestors.has(key)) { return; }
      if (++visits > 10000 || ancestors.size >= 256) { throw new Error('Too many nested LaTeX inputs'); }
      let parsed: ProjectSource;
      try {
        parsed = await LaTeXProject.readSource(request, entry.uri);
      } catch (error) {
        if (error instanceof vscode.CancellationError) { throw error; }
        return;
      }
      ancestors.add(key);
      try {
        const syntax = parsed.syntax;
        const scanner = syntax.sourceScanner;
        const definitions = new Map(syntax.definitionParser.definitions.map(definition => [definition.start, definition]));
        const hidden = syntax.definitionParser.consumedRanges;
        let hiddenIndex = 0;
        let cursor = 0;
        for (const command of scanner.commands) {
          if (command.start < cursor) { continue; }
          // Ordinary groups carry local definitions across input boundaries.
          for (let offset = cursor; offset < command.start; offset++) {
            if (scanner.maskedSource[offset] === '{') { macros.pushScope(); }
            else if (scanner.maskedSource[offset] === '}') { macros.popScope(); }
          }
          cursor = command.end;
          while (hiddenIndex < hidden.length && hidden[hiddenIndex].end <= command.start) { hiddenIndex++; }
          const definition = definitions.get(command.start);
          if (definition) {
            macros.apply(syntax, definition);
            cursor = Math.max(cursor, definition.consumedEnd);
            continue;
          }
          if (hidden[hiddenIndex]?.start <= command.start && command.start < hidden[hiddenIndex].end) {
            cursor = Math.max(cursor, hidden[hiddenIndex].end);
            continue;
          }
          if (command.name === 'begingroup' || command.name === 'bgroup') { macros.pushScope(); }
          else if (command.name === 'endgroup' || command.name === 'egroup') { macros.popScope(); }
          else if (command.name === 'begin' || command.name === 'end') {
            const argument = syntax.argumentScanner.readArgument(command.end);
            if (argument?.complete) {
              cursor = argument.end;
              if (command.name === 'begin') { macros.pushScope(); }
              else { macros.popScope(); }
            }
          } else if (command.name === 'input' || command.name === 'include') {
            let resolved = await resolveInputFile(syntax, command as InputToken, directory, name => macros.lookup(name));
            LaTeXProject.checkRequest(request);
            const fresh = resolved.checkedCandidates.filter(candidate => LaTeXProject.dependency(request, candidate.uri));
            // A trace consumer may register watches after the first stat. Only
            // such callers need to close that gap; ordinary reads need no restat.
            if (request.options.onDependency && (await Promise.all(fresh.map(async candidate =>
              (await LaTeXProject.fileExists(request, candidate.uri)) !== candidate.exists))).some(Boolean)) {
              resolved = await resolveInputFile(syntax, command as InputToken, directory, name => macros.lookup(name));
              LaTeXProject.checkRequest(request);
              const added = resolved.checkedCandidates.filter(candidate => LaTeXProject.dependency(request, candidate.uri));
              const unstable = await Promise.all(added.map(async candidate =>
                (await LaTeXProject.fileExists(request, candidate.uri)) !== candidate.exists));
              // Bound this existence correction. A watcher owner can schedule a
              // later request if another candidate changes during registration.
              if (unstable.some(Boolean)) { throw new vscode.CancellationError(); }
            }
            LaTeXProject.checkRequest(request);
            cursor = Math.max(cursor, resolved.consumedEnd);
            const target = resolved.status === 'resolved' ? resolved.uri
              : resolved.status === 'missing' ? resolved.checkedCandidates[0]?.uri : undefined;
            if (target) {
              await visit({ uri: target, type: command.name === 'input'
                ? LaTeXProject.LaTeXFileType.input : LaTeXProject.LaTeXFileType.include }, resolved.status === 'resolved');
            }
          }
        }
        for (let offset = cursor; offset < syntax.source.length; offset++) {
          if (scanner.maskedSource[offset] === '{') { macros.pushScope(); }
          else if (scanner.maskedSource[offset] === '}') { macros.popScope(); }
        }
      } finally {
        ancestors.delete(key);
      }
    };
    await visit({ uri: main, type: LaTeXProject.LaTeXFileType.main });
    return entries;
  }

  private static async collectProjectFiles(request: ProjectRequest, main: vscode.Uri): Promise<vscode.Uri[]> {
    const entries = await LaTeXProject.collectProjectEntries(request, main);
    return entries.filter(entry => entry.exists).map(entry => entry.uri);
  }

  private static parse_percent_sharp_doc(source: string | LaTeXParser.LaTeXSource): { [key: string]: string } {
    // Read full-line comments from the original document, excluding literal text.
    // Keep values opaque here: quotes, internal whitespace and `%` are meaningful
    // to their consumers. Only surrounding spaces and tabs are removed.
    const txt = typeof source === 'string' ? source : source.source;
    if (!txt.includes('%#')) { return {}; }
    const scanner = (typeof source === 'string' ? new LaTeXParser.LaTeXSource(source) : source).sourceScanner;
    const directives = new Map<string, string>();
    const directive = /^%#(!|[^ \t\r\n]+)([^\r\n]*)$/;
    for (const range of scanner.ignoredRanges) {
      if (range.kind !== 'comment' || !txt.startsWith('%#', range.start)) { continue; }
      let prefixStart = range.start;
      while (prefixStart > 0 && (txt[prefixStart - 1] === ' ' || txt[prefixStart - 1] === '\t')) {
        prefixStart--;
      }
      // Indentation is allowed, with a BOM only at the beginning of the file.
      if (prefixStart > 0 && txt[prefixStart - 1] !== '\r' && txt[prefixStart - 1] !== '\n'
        && !(prefixStart === 1 && txt[0] === '\uFEFF')) { continue; }
      const match = directive.exec(txt.slice(range.start, range.end));
      if (!match) { continue; }
      const value = match[2];
      let valueStart = 0;
      let valueEnd = value.length;
      while (valueStart < valueEnd && (value[valueStart] === ' ' || value[valueStart] === '\t')) {
        valueStart++;
      }
      while (valueEnd > valueStart && (value[valueEnd - 1] === ' ' || value[valueEnd - 1] === '\t')) {
        valueEnd--;
      }
      // `!` is a prefix, so `%#!engine args` and `%#! engine args` are equivalent.
      directives.set(match[1].toLowerCase(), value.slice(valueStart, valueEnd));
    }
    // Preserve unknown keys, including object property names; the last value wins.
    return Object.fromEntries(directives);
  }

}
