import * as vscode from 'vscode';
import { discoverBibReferences, resolveBibUri } from './BibFileDiscovery';
import { CitationEntry } from './Citation';
import BibFileCache from './BibFileCache';
import KpsewhichResolver from './KpsewhichResolver';
import LaTeXProject from '../../project/LaTeXProject';
import * as Workspace from '../../workspace';
import * as LaTeXParser from '../../latex-parser';

interface ProjectScope {
  main: vscode.Uri;
  files: vscode.Uri[];
  references: string[];
}

interface ProjectScopeCacheEntry {
  signature: string;
  scope: Promise<ProjectScope>;
}

/**
 * Discovers project bibliography files, parses their entries, and invalidates
 * caches when either bibliography contents or LaTeX project structure changes.
 */
export default class CitationService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly kpsewhich = new KpsewhichResolver();
  private readonly bibliography = new BibFileCache(() => this.kpsewhich.clear());
  private readonly projectScopes = new Map<string, ProjectScopeCacheEntry>();
  private readonly structuralSignatures = new Map<string, string>();
  private disposed = false;

  public constructor() {
    // Bibliographies are watched individually when resolved. Structural .tex
    // changes can alter the main file, include graph, or bibliography list.
    const texWatcher = vscode.workspace.createFileSystemWatcher('**/*.tex');
    const invalidateProjects = () => this.projectScopes.clear();
    this.disposables.push(
      texWatcher,
      texWatcher.onDidChange(invalidateProjects),
      texWatcher.onDidCreate(invalidateProjects),
      texWatcher.onDidDelete(invalidateProjects),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (isBibDocument(event.document)) {
          this.bibliography.invalidate(event.document.uri);
        } else if (event.document.languageId === 'latex') {
          const key = Workspace.uriKey(event.document.uri);
          const signature = projectStructureSignature(event.document.getText());
          const previous = this.structuralSignatures.get(key);
          if (previous !== undefined && previous !== signature) {
            this.projectScopes.clear();
          }
          this.structuralSignatures.set(key, signature);
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (isBibDocument(document)) {
          this.bibliography.invalidate(document.uri);
        } else if (document.languageId === 'latex') {
          const key = Workspace.uriKey(document.uri);
          this.structuralSignatures.delete(key);
          this.bibliography.release(key);
          this.projectScopes.clear();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('vscode-fortex.kpsewhich.path')) {
          this.kpsewhich.clear();
        }
        if (event.affectsConfiguration('vscode-fortex.mainFileOrder')) {
          this.projectScopes.clear();
        }
      })
    );
  }

  public async entriesFor(document: vscode.TextDocument): Promise<CitationEntry[]> {
    if (this.disposed || document.isClosed) {
      return [];
    }
    const key = Workspace.uriKey(document.uri);
    const scopePromise = this.projectScope(document);
    const scope = await scopePromise;
    if (this.disposed || document.isClosed || this.projectScopes.get(key)?.scope !== scopePromise) {
      return [];
    }
    const kpsewhichResults = await this.kpsewhich.resolve(scope.main, scope.references);
    // A closed document or a newer project structure must not register stale
    // watches after asynchronous project/path discovery finishes.
    if (this.disposed || document.isClosed || this.projectScopes.get(key)?.scope !== scopePromise) {
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
    this.bibliography.setReferences(key, uris);
    const groups = await Promise.all(uris.map((uri) => this.bibliography.read(uri)));
    if (this.disposed || document.isClosed || this.projectScopes.get(key)?.scope !== scopePromise) {
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
    this.projectScopes.clear();
    this.structuralSignatures.clear();
    this.kpsewhich.dispose();
  }

  private projectScope(document: vscode.TextDocument): Promise<ProjectScope> {
    const key = Workspace.uriKey(document.uri);
    const signature = projectStructureSignature(document.getText());
    this.structuralSignatures.set(key, signature);
    const cached = this.projectScopes.get(key);
    if (cached?.signature === signature) {
      return cached.scope;
    }

    // Cache the in-flight promise as well as completed results so simultaneous
    // IntelliSense requests share one filesystem traversal.
    const scope = (async (): Promise<ProjectScope> => {
      let main = document.uri;
      try {
        const project = await LaTeXProject.generate_project(document.uri, true);
        main = project[1];
      } catch {
        // A standalone or unsaved document remains its own project root.
      }
      const files = await LaTeXProject.collectProjectFiles(main);
      const projectFiles = files.length > 0 ? files : [document.uri];
      const sources = await Promise.all(projectFiles.map(async (uri) => ({ uri, source: await Workspace.readDocumentText(uri).catch(() => '') })));
      const references: string[] = [];
      const seen = new Set<string>();
      for (const { uri, source } of sources) {
        this.structuralSignatures.set(Workspace.uriKey(uri), projectStructureSignature(source));
        for (const reference of discoverBibReferences(source)) {
          if (!seen.has(reference)) {
            seen.add(reference);
            references.push(reference);
          }
        }
      }
      return { main, files: projectFiles, references };
    })();
    this.projectScopes.set(key, { signature, scope });
    return scope;
  }
}

function isBibDocument(document: vscode.TextDocument): boolean {
  return document.uri.path.toLocaleLowerCase().endsWith('.bib');
}

function projectStructureSignature(source: string): string {
  // Only directives that affect project discovery belong in this cheap signature;
  // ordinary text edits should not discard the project-scope cache.
  const directives = source.match(/^%#main\b[^\r\n]*/gm) ?? [];
  const commands = new LaTeXParser.DocumentParser(source).declarations
    .filter(declaration => declaration.kind !== 'package')
    .map(declaration => source.slice(declaration.start, declaration.end));
  return JSON.stringify([directives, commands]);
}
