import * as vscode from 'vscode';
import { parseBibTeX } from './BibTeXParser';
import { discoverBibReferences, resolveBibUri } from './BibFileDiscovery';
import { CitationEntry } from './Citation';
import { latexToPlainText, searchCitations } from './CitationSearch';
import KpsewhichResolver from './KpsewhichResolver';
import LaTeXProject from '../compile/LaTeXProject';

interface CacheEntry {
  documentVersion?: number;
  entries: CitationEntry[];
}

interface ProjectScope {
  main: vscode.Uri;
  files: vscode.Uri[];
  references: string[];
}

interface ProjectScopeCacheEntry {
  signature: string;
  scope: Promise<ProjectScope>;
}

export default class CitationService implements vscode.Disposable {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly kpsewhich = new KpsewhichResolver();
  private readonly projectScopes = new Map<string, ProjectScopeCacheEntry>();
  private readonly structuralSignatures = new Map<string, string>();

  public constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.bib');
    const texWatcher = vscode.workspace.createFileSystemWatcher('**/*.tex');
    const invalidateProjects = () => this.projectScopes.clear();
    this.disposables.push(
      watcher,
      texWatcher,
      watcher.onDidChange((uri) => this.invalidate(uri)),
      watcher.onDidCreate((uri) => this.invalidate(uri)),
      watcher.onDidDelete((uri) => this.invalidate(uri)),
      texWatcher.onDidChange(invalidateProjects),
      texWatcher.onDidCreate(invalidateProjects),
      texWatcher.onDidDelete(invalidateProjects),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (isBibDocument(event.document)) {
          this.invalidate(event.document.uri);
        } else if (event.document.languageId === 'latex') {
          const key = event.document.uri.toString();
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
          this.invalidate(document.uri);
        } else if (document.languageId === 'latex') {
          this.structuralSignatures.delete(document.uri.toString());
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
    const scope = await this.projectScope(document);
    const kpsewhichResults = await this.kpsewhich.resolve(scope.main, scope.references);
    const uris = scope.references.map((reference, index) => kpsewhichResults[index] ?? resolveBibUri(scope.main, reference));
    const groups = await Promise.all(uris.map((uri) => this.readEntries(uri)));
    const unique = new Map<string, CitationEntry>();
    for (const entry of groups.flat()) {
      if (!unique.has(entry.key)) {
        unique.set(entry.key, entry);
      }
    }
    return Array.from(unique.values());
  }

  public search(entries: readonly CitationEntry[], query: string): CitationEntry[] {
    return searchCitations(entries, query);
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.cache.clear();
    this.projectScopes.clear();
    this.structuralSignatures.clear();
    this.kpsewhich.dispose();
  }

  private projectScope(document: vscode.TextDocument): Promise<ProjectScope> {
    const key = document.uri.toString();
    const signature = projectStructureSignature(document.getText());
    this.structuralSignatures.set(key, signature);
    const cached = this.projectScopes.get(key);
    if (cached?.signature === signature) {
      return cached.scope;
    }

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
      const sources = await Promise.all(projectFiles.map(async (uri) => ({ uri, source: await readTexSource(uri) })));
      const references: string[] = [];
      const seen = new Set<string>();
      for (const { uri, source } of sources) {
        this.structuralSignatures.set(uri.toString(), projectStructureSignature(source));
        for (const reference of discoverBibReferences(source)) {
          const referenceKey = reference.toLocaleLowerCase();
          if (!seen.has(referenceKey)) {
            seen.add(referenceKey);
            references.push(reference);
          }
        }
      }
      return { main, files: projectFiles, references };
    })();
    this.projectScopes.set(key, { signature, scope });
    return scope;
  }

  private invalidate(uri: vscode.Uri): void {
    this.cache.delete(uri.toString());
  }

  private async readEntries(uri: vscode.Uri): Promise<CitationEntry[]> {
    const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
    const cacheKey = uri.toString();
    const cached = this.cache.get(cacheKey);
    if (openDocument && cached?.documentVersion === openDocument.version) {
      return cached.entries;
    }
    if (!openDocument && cached && cached.documentVersion === undefined) {
      return cached.entries;
    }

    try {
      const source = openDocument ? openDocument.getText() : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      const entries = parseBibTeX(source).map((parsed): CitationEntry => ({
        key: parsed.key,
        type: parsed.type,
        author: latexToPlainText(parsed.fields.author ?? ''),
        title: latexToPlainText(parsed.fields.title ?? ''),
        year: parsed.fields.year ? latexToPlainText(parsed.fields.year) : undefined,
        sourceUri: uri
      }));
      this.cache.set(cacheKey, {
        documentVersion: openDocument?.version,
        entries
      });
      return entries;
    } catch {
      return [];
    }
  }
}

function isBibDocument(document: vscode.TextDocument): boolean {
  return document.uri.path.toLocaleLowerCase().endsWith('.bib');
}

async function readTexSource(uri: vscode.Uri): Promise<string> {
  const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
  try {
    return openDocument?.getText() ?? Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  } catch {
    return '';
  }
}

function projectStructureSignature(source: string): string {
  const directives = source.match(/^%#main\b[^\r\n]*/gm) ?? [];
  const commands = source.match(/\\(?:documentclass|input|include|bibliography|addbibresource)\b(?:\s*\[[^\]]*\])?\s*\{[^{}]*\}/g) ?? [];
  return JSON.stringify([directives, commands]);
}
