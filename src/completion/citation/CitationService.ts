import * as vscode from 'vscode';
import { discoverBibReferences, resolveBibUri } from './BibFileDiscovery';
import { CitationEntry } from './Citation';
import BibFileCache from './BibFileCache';
import KpsewhichResolver, { programName } from '../../project/KpsewhichResolver';
import Config from '../../Config';
import LaTeXProject from '../../project/LaTeXProject';
import * as Workspace from '../../workspace';

interface ProjectScope {
  main: vscode.Uri;
  files: vscode.Uri[];
  references: string[];
  program: string;
  args: readonly string[];
}

/**
 * Discovers bibliography sources for each request. Only bibliography contents
 * and bibliography path lookups are retained between requests.
 */
export default class CitationService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly bibliography = new BibFileCache();
  private sourceRevision = 0;
  private disposed = false;

  /** Registers content invalidation while leaving path-cache lifecycle to the shared resolver. */
  public constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (isBibDocument(event.document)) {
          this.bibliography.invalidate(event.document.uri);
        } else if (event.contentChanges.length > 0) {
          // No source reads or parsing on editor input. This only prevents an
          // older pending request from publishing after a source edit.
          this.sourceRevision++;
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (isBibDocument(document)) {
          this.bibliography.invalidate(document.uri);
        } else if (document.languageId === 'latex') {
          const key = Workspace.uriKey(document.uri);
          this.bibliography.release(key);
          this.sourceRevision++;
        }
      })
    );
  }

  /** Resolves declared bibliography files and merges current entries while rejecting stale requests. */
  public async entriesFor(
    document: vscode.TextDocument,
    token?: vscode.CancellationToken,
    watch: (uris: readonly vscode.Uri[]) => void = () => undefined,
    watchDirectories: (uris: readonly vscode.Uri[]) => void = () => undefined
  ): Promise<CitationEntry[]> {
    if (this.disposed || document.isClosed || token?.isCancellationRequested) {
      return [];
    }
    const key = Workspace.uriKey(document.uri);
    const revision = this.sourceRevision;
    const version = document.version;
    // A completion session permits edits within its query. Its token owns that
    // validity check; standalone callers conservatively reject any source edit.
    const current = () => !this.disposed && !document.isClosed && !token?.isCancellationRequested
      && (token !== undefined || (this.sourceRevision === revision && document.version === version));
    let scope: ProjectScope;
    try {
      scope = await this.projectScope(document, token,
        uris => { if (current()) { watch(uris); } },
        uris => { if (current()) { watchDirectories(uris); } });
    } catch (error) {
      if (!current() || error instanceof vscode.CancellationError) { return []; }
      throw error;
    }
    if (!current()) {
      return [];
    }
    const localBiber = programName(scope.program) === 'biber'
      ? await this.localBiberFiles(scope) : scope.references.map(() => undefined);
    if (!current()) { return []; }
    const unresolved = scope.references.filter((_reference, index) => !localBiber[index]);
    const kpsewhichResults = await KpsewhichResolver.resolve(scope.main, unresolved,
      programName(scope.program) === 'biber' ? 'kpsewhich' : scope.program);
    let resolvedIndex = 0;
    // A closed document or a newer project structure must not register stale
    // watches after asynchronous project/path discovery finishes.
    if (!current()) {
      return [];
    }
    const uris: vscode.Uri[] = [];
    const seen = new Set<string>();
    for (const [index, reference] of scope.references.entries()) {
      const uri = localBiber[index] ?? kpsewhichResults[resolvedIndex++] ?? resolveBibUri(scope.main, reference);
      const uriKey = Workspace.uriKey(uri);
      if (!seen.has(uriKey)) {
        seen.add(uriKey);
        uris.push(uri);
      }
    }
    watch(uris);
    this.bibliography.setReferences(key, uris);
    const groups = await Promise.all(uris.map((uri) => this.bibliography.read(uri)));
    if (!current()) {
      return [];
    }
    // Keep the first occurrence of a duplicate key, matching bibliography order.
    const unique = new Map<string, CitationEntry>();
    for (const entry of groups.flat()) {
      if (!unique.has(entry.key)) {
        unique.set(entry.key, entry);
      }
    }
    return Array.from(unique.values());
  }

  /** Releases completion-owned resources without disposing the shared lookup cache. */
  public dispose(): void {
    this.disposed = true;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.bibliography.dispose();
    this.sourceRevision++;
  }

  /** Prefers Biber's configured input/output directory, then project-local datasource candidates. */
  private async localBiberFiles(scope: ProjectScope): Promise<(vscode.Uri | undefined)[]> {
    let input: string | undefined;
    for (const option of ['--input-directory', '--output-directory']) {
      const index = scope.args.findIndex(arg => arg === option || arg.startsWith(`${option}=`));
      if (index >= 0) {
        input = scope.args[index] === option ? scope.args[index + 1] : scope.args[index].slice(option.length + 1);
        if (input) { break; }
      }
    }
    const bases = input ? [vscode.Uri.joinPath(resolveBibUri(scope.main, input), '_'), scope.main] : [scope.main];
    return Promise.all(scope.references.map(async reference => {
      for (const base of bases) {
        const uri = resolveBibUri(base, reference);
        try { if ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.File) { return uri; } }
        catch { /* The next local candidate or Kpathsea may resolve this name. */ }
      }
      return undefined;
    }));
  }

  /** Collects both bibliography declarations using one immutable set of source reads. */
  private async projectScope(
    document: vscode.TextDocument, token: vscode.CancellationToken | undefined,
    watch: (uris: readonly vscode.Uri[]) => void,
    watchDirectories: (uris: readonly vscode.Uri[]) => void
  ): Promise<ProjectScope> {
    const key = Workspace.uriKey(document.uri);
    // One request owns immutable reads, including the current query. Continuing
    // that query must not repeatedly restart main-file/project discovery.
    const sources = new Map<string, Promise<string>>([[key, Promise.resolve(document.getText())]]);
    const readSource = (uri: vscode.Uri): Promise<string> => {
      if (token?.isCancellationRequested) { return Promise.reject(new vscode.CancellationError()); }
      const sourceKey = Workspace.uriKey(uri);
      let source = sources.get(sourceKey);
      if (!source) { source = Workspace.readDocumentText(uri); sources.set(sourceKey, source); }
      return source;
    };
    let main = document.uri;
    let projectFiles = [document.uri];
    let bibliography = Config.programSettings('bibtex');
    try {
      const project = await LaTeXProject.create(document.uri, {
        readSource, onDependency: uri => watch([uri]), onDirectory: uri => watchDirectories([uri])
      });
      main = project.mainfile;
      bibliography = Config.programSettings('bibtex', project.percent_sharp?.('bibtex')?.trim());
      const files = project.filelist.filter(entry => entry.exists).map(entry => entry.uri);
      if (files.length > 0) { projectFiles = files; }
    } catch (error) {
      if (error instanceof vscode.CancellationError) { throw error; }
      // A standalone or unsaved document remains its own project root.
    }
    const texts = await Promise.all(projectFiles.map(uri => readSource(uri).catch(() => '')));
    const references: string[] = [];
    const seen = new Set<string>();
    for (const source of texts) {
      for (const reference of discoverBibReferences(source)) {
        if (!seen.has(reference)) {
          seen.add(reference);
          references.push(reference);
        }
      }
    }
    return { main, files: projectFiles, references, program: bibliography.command, args: bibliography.args };
  }
}

function isBibDocument(document: vscode.TextDocument): boolean {
  return document.uri.path.toLocaleLowerCase().endsWith('.bib');
}
