import * as vscode from 'vscode';
import { discoverBibReferences, resolveBibUri } from './BibFileDiscovery';
import { CitationEntry } from './Citation';
import BibFileCache from './BibFileCache';
import KpsewhichResolver from './KpsewhichResolver';
import LaTeXProject from '../../project/LaTeXProject';
import * as Workspace from '../../workspace';

interface ProjectScope {
  main: vscode.Uri;
  files: vscode.Uri[];
  references: string[];
}

/**
 * Discovers bibliography sources for each request. Only bibliography contents
 * and bibliography path lookups are retained between requests.
 */
export default class CitationService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly kpsewhich = new KpsewhichResolver();
  private readonly bibliography = new BibFileCache(() => this.kpsewhich.clear());
  private sourceRevision = 0;
  private disposed = false;

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
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('vscode-fortex.kpsewhich.path')) {
          this.kpsewhich.clear();
        }
      })
    );
  }

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
    const kpsewhichResults = await this.kpsewhich.resolve(scope.main, scope.references);
    // A closed document or a newer project structure must not register stale
    // watches after asynchronous project/path discovery finishes.
    if (!current()) {
      return [];
    }
    const uris: vscode.Uri[] = [];
    const seen = new Set<string>();
    for (const [index, reference] of scope.references.entries()) {
      const uri = kpsewhichResults[index] ?? resolveBibUri(scope.main, reference);
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

  public dispose(): void {
    this.disposed = true;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.bibliography.dispose();
    this.sourceRevision++;
    this.kpsewhich.dispose();
  }

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
    try {
      const project = await LaTeXProject.create(document.uri, {
        readSource, onDependency: uri => watch([uri]), onDirectory: uri => watchDirectories([uri])
      });
      main = project.mainfile;
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
    return { main, files: projectFiles, references };
  }
}

function isBibDocument(document: vscode.TextDocument): boolean {
  return document.uri.path.toLocaleLowerCase().endsWith('.bib');
}
