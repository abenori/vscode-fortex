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

interface MainFileCacheEntry {
  readonly signature: string;
  readonly main: Promise<vscode.Uri>;
}

interface ProjectSource {
  readonly source: string;
  readonly syntax: LaTeXParser.LaTeXSource;
  readonly signature: string;
  readonly documentClass: [string, string];
}

/**
 * Describes the active LaTeX project and locates its main document.
 *
 * Main-file detection applies the user-configured strategies in order: `%#main`,
 * recursive parent discovery, and finally treating the current file as main.
 */
export default class LaTeXProject {
  private static readonly changed = new vscode.EventEmitter<void>();
  private static readonly mainFiles = new Map<string, MainFileCacheEntry>();
  private static readonly sources = new Map<string, ProjectSource>();
  private static readonly trackedFiles = new Set<string>();
  private static readonly directoryWatches = new Map<string, vscode.Disposable>();
  private static readonly subscriptions: vscode.Disposable[] = [];
  private static watching = false;
  private static revision = 0;
  private static lifetime = 0;

  /** Discovery inputs changed; consumers should refresh their own project results. */
  public static get onDidChange(): vscode.Event<void> {
    LaTeXProject.ensureWatching();
    return LaTeXProject.changed.event;
  }

  public static dispose(): void {
    for (const subscription of LaTeXProject.subscriptions) { subscription.dispose(); }
    for (const watcher of LaTeXProject.directoryWatches.values()) { watcher.dispose(); }
    LaTeXProject.subscriptions.length = 0;
    LaTeXProject.directoryWatches.clear();
    LaTeXProject.sources.clear();
    LaTeXProject.trackedFiles.clear();
    LaTeXProject.mainFiles.clear();
    LaTeXProject.watching = false;
    LaTeXProject.revision++;
    LaTeXProject.lifetime++;
  }

  private static invalidate(): void {
    LaTeXProject.revision++;
    LaTeXProject.mainFiles.clear();
    const retained = new Set(LaTeXProject.trackedFiles);
    LaTeXProject.trackedFiles.clear();
    const open = new Set(vscode.workspace.textDocuments.filter(document => !document.isClosed)
      .map(document => Workspace.uriKey(document.uri)));
    for (const key of LaTeXProject.sources.keys()) {
      if (!open.has(key) && !retained.has(key)) { LaTeXProject.sources.delete(key); }
    }
    LaTeXProject.changed.fire();
  }

  private static isTeXFile(uri: vscode.Uri): boolean {
    return path.extname(uri.path).toLowerCase() === '.tex';
  }

  private static ensureWatching(): void {
    if (LaTeXProject.watching) { return; }
    LaTeXProject.watching = true;
    for (const document of vscode.workspace.textDocuments) {
      if (!document.isClosed && (document.languageId === 'latex' || LaTeXProject.isTeXFile(document.uri))) {
        LaTeXProject.rememberSource(document.uri, document.getText());
      }
    }
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.tex');
    const invalidate = () => LaTeXProject.invalidate();
    LaTeXProject.subscriptions.push(
      watcher, watcher.onDidChange(invalidate), watcher.onDidCreate(invalidate), watcher.onDidDelete(invalidate),
      vscode.workspace.onDidChangeTextDocument(event => {
        const document = event.document;
        if (document.languageId !== 'latex' && !LaTeXProject.isTeXFile(document.uri)
          && !LaTeXProject.trackedFiles.has(Workspace.uriKey(document.uri))) { return; }
        const key = Workspace.uriKey(document.uri);
        const previous = LaTeXProject.sources.get(key)?.signature;
        const signature = LaTeXProject.rememberSource(document.uri, document.getText()).signature;
        if (previous !== signature) { LaTeXProject.invalidate(); }
      }),
      vscode.workspace.onDidCloseTextDocument(document => {
        if (document.languageId !== 'latex' && !LaTeXProject.isTeXFile(document.uri)
          && !LaTeXProject.trackedFiles.has(Workspace.uriKey(document.uri))) { return; }
        LaTeXProject.sources.delete(Workspace.uriKey(document.uri));
        // Release old project directories on close. Keep watches alive across
        // ordinary invalidations so rapid create/delete events are not lost.
        for (const watcher of LaTeXProject.directoryWatches.values()) { watcher.dispose(); }
        LaTeXProject.directoryWatches.clear();
        LaTeXProject.invalidate();
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('vscode-fortex.mainFileOrder')) { LaTeXProject.invalidate(); }
      })
    );
  }

  /** Ancestor candidates and included files may be outside the open workspace. */
  private static watchDirectory(directory: vscode.Uri): void {
    if (!LaTeXProject.watching || directory.scheme !== 'file') { return; }
    const key = Workspace.uriKey(directory);
    if (LaTeXProject.directoryWatches.has(key)) { return; }
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(directory, '*'));
    const invalidate = (uri: vscode.Uri) => {
      if (LaTeXProject.isTeXFile(uri) || LaTeXProject.trackedFiles.has(Workspace.uriKey(uri))) {
        LaTeXProject.invalidate();
      }
    };
    LaTeXProject.directoryWatches.set(key, vscode.Disposable.from(
      watcher, watcher.onDidChange(invalidate), watcher.onDidCreate(invalidate), watcher.onDidDelete(invalidate)
    ));
  }

  private static async readSource(file: vscode.Uri): Promise<ProjectSource> {
    const lifetime = LaTeXProject.lifetime;
    while (true) {
      const revision = LaTeXProject.revision;
      if (LaTeXProject.watching) { LaTeXProject.trackedFiles.add(Workspace.uriKey(file)); }
      LaTeXProject.watchDirectory(vscode.Uri.joinPath(file, '..'));
      const source = await Workspace.readDocumentText(file);
      if (lifetime !== LaTeXProject.lifetime) { throw new vscode.CancellationError(); }
      if (revision !== LaTeXProject.revision) { continue; }
      // A buffer may have opened or changed while the disk read was pending.
      // Never overwrite its newer discovery signature with the old disk text.
      return LaTeXProject.rememberSource(file, Workspace.findOpenDocument(file)?.getText() ?? source);
    }
  }

  private static rememberSource(file: vscode.Uri, source: string): ProjectSource {
    const key = Workspace.uriKey(file);
    const cached = LaTeXProject.sources.get(key);
    if (cached?.source === source) { return cached; }
    const syntax = new LaTeXParser.LaTeXSource(source);
    const snapshot: ProjectSource = {
      source, syntax, signature: LaTeXProject.discoverySignature(syntax),
      get documentClass() { return LaTeXProject.get_classfile(syntax); }
    };
    if (LaTeXProject.watching) { LaTeXProject.sources.set(key, snapshot); }
    return snapshot;
  }

  /** Keep prose/build-directive edits cheap, but include definition order and scopes. */
  private static discoverySignature(syntax: LaTeXParser.LaTeXSource): string {
    const scanner = syntax.sourceScanner;
    const definitions = new Map(syntax.definitionParser.definitions.map(definition => [definition.start, definition]));
    const document = new Map(syntax.documentParser.declarations.map(declaration => [declaration.start, declaration]));
    const parts: string[] = [LaTeXProject.parse_percent_sharp_doc(syntax).main ?? ''];
    let cursor = 0;
    for (const command of scanner.commands) {
      if (command.start < cursor) { continue; }
      parts.push(scanner.maskedSource.slice(cursor, command.start).replace(/[^{}]/g, ''));
      const definition = definitions.get(command.start);
      if (definition) {
        parts.push(syntax.source.slice(command.start, definition.end));
        cursor = definition.end;
        continue;
      }
      const declaration = document.get(command.start);
      if (declaration?.kind === 'documentClass') {
        parts.push(syntax.source.slice(command.start, declaration.end));
        cursor = declaration.end;
      } else if (command.name === 'input' || command.name === 'include') {
        const argument = syntax.argumentScanner.readArgument(command.end);
        parts.push(command.name);
        if (argument) {
          parts.push(syntax.source.slice(argument.start, argument.end));
          cursor = argument.end;
        } else {
          cursor = command.end;
        }
      } else {
        parts.push(command.name);
        cursor = command.end;
      }
    }
    parts.push(scanner.maskedSource.slice(cursor).replace(/[^{}]/g, ''));
    return JSON.stringify(parts);
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
  public static async create(file: vscode.Uri | null): Promise<LaTeXProject> {
    LaTeXProject.ensureWatching();
    const lifetime = LaTeXProject.lifetime;
    while (true) {
      if (lifetime !== LaTeXProject.lifetime) { throw new vscode.CancellationError(); }
      const revision = LaTeXProject.revision;
      const description = await LaTeXProject.generate_project(file);
      const entries = await LaTeXProject.collectProjectEntries(description[1]);
      if (lifetime !== LaTeXProject.lifetime) { throw new vscode.CancellationError(); }
      if (revision !== LaTeXProject.revision) { continue; }
      return new LaTeXProject(description, entries);
    }
  }

  private static async get_class_option_from_main(main: vscode.Uri): Promise<[string, string]> {
    const parsed = await LaTeXProject.readSource(main);
    return [...parsed.documentClass];
  }
  private static async fileExists(file: vscode.Uri): Promise<boolean> {
    try {
      const stat = await vscode.workspace.fs.stat(file);
      return (stat.type & vscode.FileType.File) !== 0;
    } catch {
      return false;
    }
  }
  private static async mainFromMagic(file: vscode.Uri, directives: { [key: string]: string }): Promise<vscode.Uri | undefined> {
    const name = directives.main?.trim();
    if (!name) { return undefined; }
    const main = vscode.Uri.file(path.resolve(path.dirname(file.fsPath), name));
    if (LaTeXProject.watching) { LaTeXProject.trackedFiles.add(Workspace.uriKey(main)); }
    LaTeXProject.watchDirectory(vscode.Uri.joinPath(main, '..'));
    return main;
  }

  private static async mainFromCurrentFile(file: vscode.Uri): Promise<vscode.Uri | undefined> {
    return file;
  }

  /** Resolve the main URI without an additional file-list collection. */
  public static async resolveMainFile(file: vscode.Uri | null): Promise<vscode.Uri> {
    return (await LaTeXProject.generate_project(file))[1];
  }

  private static async generate_project(f: vscode.Uri | null): Promise<ProjectDescription> {
    LaTeXProject.ensureWatching();
    const file = f ?? vscode.window.activeTextEditor?.document.uri;
    if (!file) { throw new Error("Cannot get the current file"); }
    const key = Workspace.uriKey(file);
    const lifetime = LaTeXProject.lifetime;
    while (true) {
      if (lifetime !== LaTeXProject.lifetime) { throw new vscode.CancellationError(); }
      const revision = LaTeXProject.revision;
      const parsed = await LaTeXProject.readSource(file);
      // Directives always come from the original document, including fresh build
      // options when the parent itself is unchanged.
      const directives = LaTeXProject.parse_percent_sharp_doc(parsed.syntax);
      const order = Config.mainFileOrder();
      const signature = JSON.stringify([parsed.signature, order]);
      if (revision !== LaTeXProject.revision) { continue; }
      let cached = LaTeXProject.mainFiles.get(key);
      const reused = cached?.signature === signature;
      if (cached?.signature !== signature) {
        const entry: MainFileCacheEntry = {
          signature,
          main: LaTeXProject.discoverMain(file, directives, order)
        };
        LaTeXProject.mainFiles.set(key, entry);
        cached = entry;
        // Rejections must not poison later requests after a missing file appears.
        void entry.main.catch(() => {
          if (LaTeXProject.mainFiles.get(key) === entry) { LaTeXProject.mainFiles.delete(key); }
        });
      }
      let main: vscode.Uri;
      try {
        main = await cached.main;
      } catch (error) {
        if (revision !== LaTeXProject.revision) { continue; }
        throw error;
      }
      if (revision !== LaTeXProject.revision || LaTeXProject.mainFiles.get(key) !== cached) { continue; }
      let cls: string;
      let options: string;
      try {
        [cls, options] = await LaTeXProject.get_class_option_from_main(main);
      } catch (error) {
        if (LaTeXProject.mainFiles.get(key) === cached) { LaTeXProject.mainFiles.delete(key); }
        if (revision !== LaTeXProject.revision) { continue; }
        // A deleted cached main can be noticed before its filesystem event.
        // Retry discovery once; a newly selected unreadable main still fails.
        if (reused) { LaTeXProject.invalidate(); continue; }
        throw error;
      }
      if (revision !== LaTeXProject.revision || LaTeXProject.mainFiles.get(key) !== cached) { continue; }
      return [f, main, cls, options, directives];
    }
  }

  private static async discoverMain(file: vscode.Uri, directives: { [key: string]: string }, order: readonly string[]): Promise<vscode.Uri> {
    // Strategies are data-driven so changing `mainFileOrder` does not duplicate
    // the validation and result assembly below.
    const strategies = new Map<string, () => Promise<vscode.Uri | undefined>>([
      ['magic', () => LaTeXProject.mainFromMagic(file, directives)],
      ['guess', () => LaTeXProject.guessMainFile(file)],
      ['current', () => LaTeXProject.mainFromCurrentFile(file)]
    ]);
    for (const name of order) {
      const main = await strategies.get(name)?.();
      if (main && await LaTeXProject.fileExists(main)) { return main; }
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

  private static async guessMainFile(file: vscode.Uri): Promise<vscode.Uri | undefined> {
    const [cls] = await LaTeXProject.get_class_option_from_main(file);
    if (cls) { return file; }
    let directory = vscode.Uri.file(path.dirname(file.fsPath));
    // Search every ancestor. A candidate is accepted only when it has a
    // document class and recursively includes the active file.
    while (true) {
      const main = await LaTeXProject.findMainInDirectory(directory, file);
      if (main) { return main; }
      const parent = vscode.Uri.file(path.dirname(directory.fsPath));
      if (Workspace.uriKey(parent) === Workspace.uriKey(directory)) { break; }
      directory = parent;
    }
    return undefined;
  }

  private static async findMainInDirectory(directory: vscode.Uri, target: vscode.Uri): Promise<vscode.Uri | undefined> {
    // Only top-level documents in this directory are candidates; recursive
    // inclusion is checked by collectProjectFiles for each candidate.
    try {
      LaTeXProject.watchDirectory(directory);
      const files = await vscode.workspace.fs.readDirectory(directory);
      for (const file of files) {
        if (file[1] === vscode.FileType.Directory) { continue; }
        if (path.extname(file[0]).toLowerCase() !== ".tex") { continue; }
        const filepath = vscode.Uri.joinPath(directory, file[0]);
        try {
          const [cls] = await LaTeXProject.get_class_option_from_main(filepath);
          if (!cls) { continue; }
          const projectFiles = await LaTeXProject.collectProjectFiles(filepath);
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

  private static async collectProjectEntries(main: vscode.Uri): Promise<ProjectFileEntry[]> {
    const entries: ProjectFileEntry[] = [];
    const listed = new Set<string>();
    const ancestors = new Set<string>();
    const sources = new Map<string, Promise<ProjectSource>>();
    const macros = new MacroState();
    const directory = vscode.Uri.file(path.dirname(main.fsPath));
    const lifetime = LaTeXProject.lifetime;
    let visits = 0;
    const track = (uri: vscode.Uri): boolean => {
      const key = Workspace.uriKey(uri);
      const fresh = !LaTeXProject.trackedFiles.has(key);
      LaTeXProject.trackedFiles.add(key);
      LaTeXProject.watchDirectory(vscode.Uri.joinPath(uri, '..'));
      return fresh;
    };
    const visit = async (entry: IncludedFile, knownExists?: boolean): Promise<void> => {
      if (lifetime !== LaTeXProject.lifetime) { throw new vscode.CancellationError(); }
      const key = Workspace.uriKey(entry.uri);
      track(entry.uri);
      const exists = knownExists ?? await LaTeXProject.fileExists(entry.uri);
      if (!listed.has(key)) {
        listed.add(key);
        entries.push({ ...entry, exists });
      }
      if (!exists || ancestors.has(key)) { return; }
      if (++visits > 10000 || ancestors.size >= 256) { throw new Error('Too many nested LaTeX inputs'); }
      let parsed: ProjectSource;
      try {
        let pending = sources.get(key);
        if (!pending) {
          pending = LaTeXProject.readSource(entry.uri);
          sources.set(key, pending);
        }
        parsed = await pending;
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
            let resolved;
            while (true) {
              resolved = await resolveInputFile(syntax, command as InputToken, directory, name => macros.lookup(name));
              const fresh = resolved.checkedCandidates.filter(candidate => track(candidate.uri));
              // A previously unknown candidate may change while stat is pending,
              // before its directory/dependency has been registered. Check it
              // once more under tracking before publishing the resolution.
              const changed = await Promise.all(fresh.map(async candidate =>
                (await LaTeXProject.fileExists(candidate.uri)) !== candidate.exists));
              if (!changed.some(Boolean)) { break; }
            }
            if (lifetime !== LaTeXProject.lifetime) { throw new vscode.CancellationError(); }
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

  private static async collectProjectFiles(main: vscode.Uri): Promise<vscode.Uri[]> {
    const entries = await LaTeXProject.collectProjectEntries(main);
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
