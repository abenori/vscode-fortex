import * as path from 'path';
import * as vscode from 'vscode';
import { parseBibTeX } from './BibTeXParser';
import { CitationEntry } from './Citation';
import { latexToPlainText } from './CitationSearch';

interface ParsedFile {
  document: vscode.TextDocument | undefined;
  documentVersion?: number;
  entries: CitationEntry[];
}

interface PendingRead {
  revision: number;
  document: vscode.TextDocument | undefined;
  documentVersion: number | undefined;
  promise: Promise<CitationEntry[]>;
}

interface WatchedFile {
  disposable: vscode.Disposable;
  revision: number;
  cached?: ParsedFile;
  pending?: PendingRead;
}

/** Parsed bibliographies and non-recursive watches, including outside the workspace. */
export default class BibFileCache implements vscode.Disposable {
  private readonly files = new Map<string, WatchedFile>();
  private readonly references = new Map<string, Set<string>>();
  private disposed = false;

  constructor(private readonly onFileCreatedOrDeleted: () => void = () => {}) {}

  public setReferences(owner: string, uris: readonly vscode.Uri[]): void {
    if (this.disposed) {
      return;
    }
    const keys = new Set<string>();
    for (const uri of uris) {
      const key = citationUriKey(uri);
      keys.add(key);
      if (!this.files.has(key)) {
        // Watching the parent also handles editors that save by replacing the
        // file. A simple glob avoids recursive watching and filename escaping
        // issues (e.g. references[1].bib); only the exact URI is acted upon.
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), '*')
        );
        const changed = (eventUri: vscode.Uri, existenceChanged = false) => {
          if (citationUriKey(eventUri) !== key) {
            return;
          }
          this.invalidate(uri);
          if (existenceChanged) {
            this.onFileCreatedOrDeleted();
          }
        };
        this.files.set(key, {
          revision: 0,
          disposable: vscode.Disposable.from(
            watcher,
            watcher.onDidChange((eventUri) => changed(eventUri)),
            watcher.onDidCreate((eventUri) => changed(eventUri, true)),
            watcher.onDidDelete((eventUri) => changed(eventUri, true))
          )
        });
      }
    }
    this.references.set(owner, keys);
    this.releaseUnused();
  }

  public release(owner: string): void {
    this.references.delete(owner);
    this.releaseUnused();
  }

  public invalidate(uri: vscode.Uri): void {
    const file = this.files.get(citationUriKey(uri));
    if (file) {
      file.revision++;
      file.cached = undefined;
      file.pending = undefined;
    }
  }

  public async read(uri: vscode.Uri): Promise<CitationEntry[]> {
    const key = citationUriKey(uri);
    const file = this.files.get(key);
    // Registration must precede reading, so an update during the first read
    // cannot be lost before the cache is populated.
    if (!file) {
      return [];
    }
    // Continuous external writes must not keep a completion request alive
    // indefinitely. Leave the cache empty and retry on the next request.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.disposed || this.files.get(key) !== file) {
        return [];
      }
      const document = findOpenDocument(uri);
      const documentVersion = document?.version;
      if (file.cached && file.cached.document === document && file.cached.documentVersion === documentVersion) {
        return file.cached.entries;
      }
      let pending = file.pending;
      if (!pending || pending.revision !== file.revision || pending.document !== document
        || pending.documentVersion !== documentVersion) {
        pending = {
          revision: file.revision,
          document,
          documentVersion,
          promise: this.parse(uri, document)
        };
        file.pending = pending;
      }
      let entries: CitationEntry[] | undefined;
      try {
        entries = await pending.promise;
      } catch {
        // Missing files are not cached; create notifications or the next
        // completion can pick up a file that becomes available later.
      }
      if (file.pending === pending) {
        file.pending = undefined;
      }
      if (this.disposed || this.files.get(key) !== file) {
        return [];
      }
      const currentDocument = findOpenDocument(uri);
      if (file.revision !== pending.revision || currentDocument !== document
        || currentDocument?.version !== documentVersion) {
        continue;
      }
      if (entries) {
        file.cached = { document, documentVersion, entries };
      }
      return entries ?? [];
    }
    return [];
  }

  public dispose(): void {
    this.disposed = true;
    for (const file of this.files.values()) {
      file.disposable.dispose();
    }
    this.files.clear();
    this.references.clear();
  }

  private releaseUnused(): void {
    const retained = new Set(Array.from(this.references.values()).flatMap((keys) => [...keys]));
    for (const [key, file] of this.files) {
      if (!retained.has(key)) {
        file.disposable.dispose();
        this.files.delete(key);
      }
    }
  }

  private async parse(uri: vscode.Uri, document: vscode.TextDocument | undefined): Promise<CitationEntry[]> {
    const source = document ? document.getText() : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    return parseBibTeX(source).map((parsed): CitationEntry => ({
      key: parsed.key,
      type: parsed.type,
      author: latexToPlainText(parsed.fields.author ?? ''),
      title: latexToPlainText(parsed.fields.title ?? ''),
      year: parsed.fields.year ? latexToPlainText(parsed.fields.year) : undefined,
      sourceUri: uri
    }));
  }
}

/** Normalize local Windows paths, without folding case on remote file systems. */
export function citationUriKey(uri: vscode.Uri): string {
  return uri.scheme === 'file' && process.platform === 'win32'
    ? path.normalize(uri.fsPath).toLowerCase()
    : uri.toString();
}

function findOpenDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  const key = citationUriKey(uri);
  return vscode.workspace.textDocuments.find((document) => !document.isClosed && citationUriKey(document.uri) === key);
}
