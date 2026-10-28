import * as vscode from 'vscode';
import * as path from 'path';
import LaTeXProject from '../project/LaTeXProject';
import { isStructureTrivia, parseStructureEvents, StructureEvent, structurePlainText } from './LaTeXStructureParser';
import { StructureKind, StructureLabelEntry, StructureLocation, StructureNode, StructureSnapshot } from './StructureTypes';
import * as Workspace from '../workspace';
import * as LaTeXParser from '../latex-parser';
import { resolveInputFile } from '../project/InputFileResolver';

interface ParsedSource {
  uri: vscode.Uri;
  source: string;
  syntax: LaTeXParser.LaTeXSource;
  events: StructureEvent[];
  id?: number;
  document?: vscode.TextDocument;
  documentVersion?: number;
  textRanges?: { start: number; end: number }[];
}

interface LoadedSnapshot extends StructureSnapshot {
  /** Includes absent candidates whose creation could change input resolution. */
  dependencies: vscode.Uri[];
  checkedCandidates: readonly { readonly uri: vscode.Uri; readonly exists: boolean }[];
  neededFiles: Set<string>;
  neededDirectories: Set<string>;
  directories: Set<string>;
}

interface ExpandedEvent {
  parsed: ParsedSource;
  occurrence: string;
  event: StructureEvent | { type: 'text'; start: number; end: number } | { type: 'issue'; title: string; start: number; end: number };
}

const equationEnvironments = new Set(['equation', 'equation*', 'align', 'align*', 'alignat', 'alignat*',
  'gather', 'gather*', 'multline', 'multline*', 'flalign', 'flalign*', 'displaymath', '\\[', '$$']);
const defaultTheorems: Record<string, string> = {
  theorem: 'Theorem', lemma: 'Lemma', proposition: 'Proposition', corollary: 'Corollary',
  definition: 'Definition', remark: 'Remark', example: 'Example', conjecture: 'Conjecture'
};

function location(parsed: ParsedSource, start: number, end = start): StructureLocation {
  return { uri: parsed.uri, start, end, sourceVersion: parsed.id };
}

function theoremSettings(uri: vscode.Uri): Record<string, string> {
  const configured = vscode.workspace.getConfiguration('vscode-fortex', uri).get<unknown>('outline.theoremEnvironments', {});
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) { return {}; }
  return Object.fromEntries(Object.entries(configured).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

/** Build semantic ownership after include expansion, preserving each occurrence. */
function buildStructure(events: ExpandedEvent[], configuredTheorems: Record<string, string>): StructureNode[] {
  const theoremNames = { ...defaultTheorems, ...configuredTheorems };
  for (const { event } of events) {
    if (event.type === 'theoremDefinition') { theoremNames[event.name] = event.title; }
  }
  const roots: StructureNode[] = [];
  const sections: StructureNode[] = [];
  const environments: { name: string; node?: StructureNode; parsed: ParsedSource; contentStart: number }[] = [];
  let pendingHeading: StructureNode | undefined;
  const environmentOwner = () => [...environments].reverse().find(entry => entry.node)?.node;
  const add = (node: StructureNode) => (environmentOwner()?.children ?? sections.at(-1)?.children ?? roots).push(node);
  const make = (entry: ExpandedEvent, kind: StructureKind, title: string, command: string): StructureNode => ({
    id: `${entry.occurrence}:${entry.event.start}:${kind}`,
    kind, title, command,
    location: location(entry.parsed, entry.event.start, entry.event.end),
    end: location(entry.parsed, entry.parsed.source.length),
    labels: [], children: []
  });

  for (const entry of events) {
    const { event, parsed } = entry;
    if (event.type === 'text') { pendingHeading = undefined; continue; }
    if (event.type === 'heading') {
      while (sections.length && sections.at(-1)!.level! >= event.level) {
        sections.pop()!.end = location(parsed, event.start);
      }
      const node = make(entry, 'section', event.title || `\\${event.command}`, event.command);
      node.level = event.level;
      add(node);
      sections.push(node);
      pendingHeading = node;
      continue;
    }
    if (event.type === 'label') {
      const label = { key: event.key, location: location(parsed, event.start, event.end) };
      const owner = environmentOwner() ?? pendingHeading;
      if (owner) { owner.labels.push(label); }
      else {
        const node = make(entry, 'label', event.key, 'label');
        node.end = node.location;
        node.labels.push(label);
        add(node);
      }
      continue;
    }
    pendingHeading = undefined;
    if (event.type === 'begin') {
      const baseName = event.name.replace(/\*$/, '');
      let kind: StructureKind | undefined;
      let title = event.name;
      if (equationEnvironments.has(event.name)) {
        if (!environments.some(env => env.node?.kind === 'equation')) { kind = 'equation'; }
      } else if (baseName === 'figure' || baseName === 'table') {
        kind = baseName;
        title = baseName === 'figure' ? 'Figure' : 'Table';
      } else if (theoremNames[event.name] || theoremNames[baseName]) {
        kind = 'theorem';
        title = theoremNames[event.name] ?? theoremNames[baseName];
        if (event.title) { title += `: ${event.title}`; }
      }
      const node = kind ? make(entry, kind, title, event.name) : undefined;
      if (node) { add(node); }
      environments.push({ name: event.name, node, parsed, contentStart: event.end });
    } else if (event.type === 'end') {
      let index = environments.length - 1;
      while (index >= 0 && environments[index].name !== event.name) { index--; }
      if (index < 0) { continue; }
      for (const env of environments.splice(index)) {
        if (!env.node) { continue; }
        env.node.end = location(parsed, event.end);
        if (env.node.kind === 'equation' && Workspace.uriKey(env.parsed.uri) === Workspace.uriKey(parsed.uri)) {
          const content = parsed.source.slice(env.contentStart, event.start);
          env.node.title = structurePlainText(content, { omitEnvironmentCommands: true }).slice(0, 100) || env.name;
        }
      }
    } else if (event.type === 'caption') {
      const owner = [...environments].reverse().find(env => env.node?.kind === 'figure' || env.node?.kind === 'table')?.node;
      if (owner && (owner.title === 'Figure' || owner.title === 'Table')) { owner.title = event.title || owner.title; }
    } else if (event.type === 'issue') {
      const node = make(entry, 'issue', event.title, 'input');
      node.end = node.location;
      add(node);
    }
  }
  const last = events.at(-1);
  if (last) {
    for (const node of sections) { node.end = location(last.parsed, last.parsed.source.length); }
  }
  return roots;
}

function labelEntries(roots: StructureNode[]): StructureLabelEntry[] {
  const declarations = new Map<string, StructureLabelEntry>();
  const keys = new Map<string, Set<string>>();
  const visit = (nodes: StructureNode[]) => {
    for (const node of nodes) {
      for (const label of node.labels) {
        const id = `${Workspace.uriKey(label.location.uri)}:${label.location.start}`;
        const existing = declarations.get(id);
        if (existing) { existing.occurrences++; }
        else { declarations.set(id, { label, node, occurrences: 1, duplicate: false }); }
        const definitions = keys.get(label.key) ?? new Set<string>();
        definitions.add(id);
        keys.set(label.key, definitions);
      }
      visit(node.children);
    }
  };
  visit(roots);
  for (const entry of declarations.values()) { entry.duplicate = keys.get(entry.label.key)!.size > 1; }
  return [...declarations.values()];
}

function appendEvents(parsed: ParsedSource, occurrence: string, append: (entry: ExpandedEvent) => void): void {
  if (!parsed.textRanges) {
    const ranges: { start: number; end: number }[] = [];
    let cursor = 0;
    for (const event of parsed.events) {
      if (event.start > cursor && !isStructureTrivia(parsed.source.slice(cursor, event.start))) {
        ranges.push({ start: cursor, end: event.start });
      }
      cursor = Math.max(cursor, event.end);
    }
    if (!isStructureTrivia(parsed.source.slice(cursor))) { ranges.push({ start: cursor, end: parsed.source.length }); }
    parsed.textRanges = ranges;
  }
  let index = 0;
  for (const event of parsed.events) {
    while (index < parsed.textRanges.length && parsed.textRanges[index].end <= event.start) {
      append({ parsed, occurrence, event: { type: 'text', ...parsed.textRanges[index++] } });
    }
    append({ parsed, occurrence, event });
  }
  while (index < parsed.textRanges.length) {
    append({ parsed, occurrence, event: { type: 'text', ...parsed.textRanges[index++] } });
  }
}

/** Local Outline always reads the active buffer and never discovers a parent. */
export async function localDocumentStructure(document: vscode.TextDocument): Promise<StructureNode[]> {
  const source = document.getText();
  const syntax = new LaTeXParser.LaTeXSource(source);
  const parsed = { uri: document.uri, source, syntax, events: parseStructureEvents(syntax) };
  const expanded: ExpandedEvent[] = [];
  appendEvents(parsed, 'local', entry => expanded.push(entry));
  return buildStructure(expanded, theoremSettings(document.uri));
}

/** Outline snapshots advance on save and source/lifecycle changes, never on typing. */
export default class StructureService implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<StructureSnapshot | undefined>();
  readonly onDidChange = this.changed.event;
  private readonly statusChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeStatus = this.statusChanged.event;
  private readonly sourcesChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeSources = this.sourcesChanged.event;
  private readonly disposables: vscode.Disposable[] = [this.changed, this.statusChanged, this.sourcesChanged];
  private readonly watches = new Map<string, vscode.Disposable>();
  private readonly watchedFiles = new Set<string>();
  private readonly candidateDirectories = new Set<string>();
  private readonly stateFiles = new Set<string>();
  private readonly sources = new Map<string, ParsedSource>();
  private readonly sourceReads = new Map<string, Promise<ParsedSource>>();
  private readonly sourceRevisions = new Map<string, number>();
  private readonly dirty = new Set<string>();
  private readonly externalReloads = new Map<string, string>();
  private readonly localFiles = new Set<string>();
  private readonly localTrees = new Map<string, { source: ParsedSource; settings: string; nodes: StructureNode[] }>();
  private selected?: vscode.TextDocument;
  private publishedDocument?: vscode.TextDocument;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private nextSourceVersion = 0;
  private pending?: Promise<void>;
  private disposed = false;
  private state?: StructureSnapshot;
  get snapshot(): StructureSnapshot | undefined { return this.state; }

  constructor(private readonly watch = true) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(event => {
        const key = Workspace.uriKey(event.document.uri);
        if (event.contentChanges.length === 0) {
          // VS Code delivers dirty-state transitions separately from text edits.
          // Undoing back to the saved text must not require a redundant save.
          if (!event.document.isDirty && this.dirty.has(key)) { this.reconcileClean(event.document); }
          return;
        }
        const parsed = this.sources.get(key);
        if (!parsed || (parsed.document === event.document && parsed.documentVersion === event.document.version)) { return; }
        // No getText, parsing, project discovery, timers, or tree rebuilds on typing.
        const firstChange = !this.dirty.has(key);
        this.dirty.add(key);
        if (firstChange && this.stateFiles.has(key)) { this.updateStatus(); }
        // Dirty flags arrive separately from content changes in VS Code. Only
        // a verified filesystem change can authorize an external reload here.
        const external = this.externalReloads.get(key);
        if (external !== undefined) {
          this.externalReloads.delete(key);
          queueMicrotask(() => {
            if (this.disposed || event.document.isClosed || event.document.getText() !== external) { return; }
            this.capture(event.document);
            this.sourcesChanged.fire();
            if (this.stateFiles.has(key)) { this.schedule(); }
          });
        }
      }),
      vscode.workspace.onDidSaveTextDocument(document => {
        if (!this.relevant(document.uri)) { return; }
        const key = Workspace.uriKey(document.uri);
        const previous = this.sources.get(key);
        const advanced = previous?.document !== document || previous.documentVersion !== document.version || this.dirty.has(key);
        // Capture exactly this save. Other edited buffers keep their old text.
        this.capture(document);
        // A clean-state notification can precede the save event. Do not emit a
        // second native-provider invalidation for the same captured version.
        if (advanced) {
          this.sourcesChanged.fire();
          if (this.selected) { this.schedule(); }
        }
      }),
      vscode.workspace.onDidOpenTextDocument(document => {
        const key = Workspace.uriKey(document.uri);
        if (!this.sources.has(key)) { return; }
        this.capture(document);
        this.sourcesChanged.fire();
        if (this.selected) { this.schedule(); }
      }),
      vscode.workspace.onDidCloseTextDocument(document => {
        const key = Workspace.uriKey(document.uri);
        if (!this.sources.has(key) && !this.watchedFiles.has(key)) { return; }
        this.invalidateSource(key);
        this.localFiles.delete(key);
        this.sourcesChanged.fire();
        if (this.selected === document) { this.selected = undefined; }
        if (this.selected) { this.schedule(); }
        else if (this.watch) { this.state = undefined; this.changed.fire(undefined); }
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('vscode-fortex.mainFileOrder')
          || event.affectsConfiguration('vscode-fortex.outline.followIncludes')
          || event.affectsConfiguration('vscode-fortex.outline.theoremEnvironments')) {
          this.localTrees.clear();
          this.sourcesChanged.fire();
          if (this.selected) { this.schedule(); }
        }
      })
    );
    if (!watch) { return; }
    this.disposables.push(vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor?.document.languageId === 'latex' && editor.document !== this.selected) {
        this.selected = editor.document;
        this.schedule();
      }
    }));
    if (vscode.window.activeTextEditor?.document.languageId === 'latex') {
      this.selected = vscode.window.activeTextEditor.document;
      this.schedule();
    }
  }

  /** Native Outline shares the saved per-file parse, but never exposes stale offsets. */
  async local(document: vscode.TextDocument): Promise<StructureNode[]> {
    if (this.disposed || document.isClosed) { return []; }
    const key = Workspace.uriKey(document.uri);
    this.localFiles.add(key);
    this.watchedFiles.add(key);
    this.watchDirectory(vscode.Uri.joinPath(document.uri, '..'));
    const parsed = await this.read(document.uri);
    if (this.disposed || !this.matchesDocument(parsed, document)) { return []; }
    const settings = theoremSettings(document.uri);
    const signature = JSON.stringify(settings);
    let local = this.localTrees.get(key);
    if (local?.source !== parsed || local.settings !== signature) {
      const expanded: ExpandedEvent[] = [];
      appendEvents(parsed, 'local', entry => expanded.push(entry));
      local = { source: parsed, settings: signature, nodes: buildStructure(expanded, settings) };
      this.localTrees.set(key, local);
    }
    return local.nodes;
  }

  /** A location is usable only with the exact text that supplied its offsets. */
  canNavigate(location: StructureLocation, document = Workspace.findOpenDocument(location.uri)): boolean {
    if (this.disposed) { return false; }
    const parsed = this.sources.get(Workspace.uriKey(location.uri));
    if (!parsed || parsed.id !== location.sourceVersion) { return false; }
    return document ? this.matchesDocument(parsed, document) : parsed.document === undefined;
  }

  /** Descriptions use captured text and never open documents as a rendering side effect. */
  lineNumber(location: StructureLocation): number | undefined {
    const parsed = this.sources.get(Workspace.uriKey(location.uri));
    if (!parsed || parsed.id !== location.sourceVersion) { return undefined; }
    return parsed.source.slice(0, location.start).split(/\r\n|\r|\n/).length;
  }

  private matchesDocument(parsed: ParsedSource, document: vscode.TextDocument): boolean {
    return !document.isClosed && parsed.document === document && parsed.documentVersion === document.version;
  }

  private relevant(uri: vscode.Uri): boolean {
    const key = Workspace.uriKey(uri);
    return this.sources.has(key) || this.watchedFiles.has(key)
      || (uri.scheme === 'file' && path.extname(uri.path).toLowerCase() === '.tex'
        && this.candidateDirectories.has(Workspace.uriKey(vscode.Uri.joinPath(uri, '..'))));
  }

  private updateStatus(): void {
    if (this.state) { this.state = { ...this.state, waitingForSave: true }; }
    this.statusChanged.fire();
  }

  private reconcileClean(document: vscode.TextDocument): void {
    const key = Workspace.uriKey(document.uri);
    const parsed = this.sources.get(key);
    if (!parsed || document.isClosed) { return; }
    const source = document.getText();
    if (source !== parsed.source) {
      // The first display may have captured an already-dirty buffer. Returning
      // from that initial text to disk is a clean source transition.
      this.capture(document);
      this.sourcesChanged.fire();
      if (this.selected) { this.schedule(); }
      return;
    }
    parsed.document = document;
    parsed.documentVersion = document.version;
    this.dirty.delete(key);
    this.externalReloads.delete(key);
    if (this.state) {
      this.state = { ...this.state, waitingForSave: [...this.stateFiles].some(file => this.dirty.has(file)) };
    }
    this.statusChanged.fire();
    this.sourcesChanged.fire();
  }

  private schedule(): void {
    if (this.disposed) { return; }
    this.generation++;
    if (this.timer) { clearTimeout(this.timer); }
    // Only saves, filesystem/lifecycle changes, and semantic settings reach here.
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, 0);
  }

  async refresh(document?: vscode.TextDocument): Promise<void> {
    if (this.disposed) { return; }
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const active = document ?? this.selected ?? vscode.window.activeTextEditor?.document;
    if (!active || active.isClosed || active.languageId !== 'latex') { return; }
    this.selected = active;
    const generation = ++this.generation;
    const request = this.load(active, generation).then(async snapshot => {
      if (this.disposed || generation !== this.generation) { return; }
      // An input resolver may discover an absent candidate just before its watch
      // was registered. Recheck existence under the now-established observation.
      const changed = await Promise.all(snapshot.checkedCandidates.map(async candidate => {
        try {
          const stat = await vscode.workspace.fs.stat(candidate.uri);
          return ((stat.type & vscode.FileType.File) !== 0) !== candidate.exists;
        } catch (error) {
          if ((error as { code?: string }).code !== 'FileNotFound') { throw error; }
          return candidate.exists;
        }
      }));
      if (this.disposed || generation !== this.generation) { return; }
      if (changed.some(Boolean)) { this.schedule(); return; }
      // Native Outline requests may have added another open file while the
      // asynchronous existence checks were pending.
      for (const key of this.localFiles) {
        snapshot.neededFiles.add(key);
        const parsed = this.sources.get(key);
        if (parsed) { snapshot.neededDirectories.add(Workspace.uriKey(vscode.Uri.joinPath(parsed.uri, '..'))); }
      }
      for (const key of this.sources.keys()) {
        if (!snapshot.neededFiles.has(key)) { this.invalidateSource(key); }
      }
      for (const [key, watcher] of this.watches) {
        if (!snapshot.neededDirectories.has(key)) { watcher.dispose(); this.watches.delete(key); }
      }
      this.watchedFiles.clear();
      for (const key of snapshot.neededFiles) { this.watchedFiles.add(key); }
      this.candidateDirectories.clear();
      for (const key of snapshot.directories) { this.candidateDirectories.add(key); }
      this.stateFiles.clear();
      this.stateFiles.add(Workspace.uriKey(active.uri));
      for (const uri of snapshot.dependencies) { this.stateFiles.add(Workspace.uriKey(uri)); }
      snapshot.waitingForSave = [...this.stateFiles].some(key => this.dirty.has(key));
      this.publishedDocument = active;
      this.state = snapshot;
      this.changed.fire(snapshot);
    }).catch(error => {
      if (this.disposed || generation !== this.generation) { return; }
      this.state = { main: active.uri, followIncludes: false, roots: [], labels: [], files: [active.uri],
        message: `Unable to read LaTeX structure: ${error instanceof Error ? error.message : String(error)}` };
      this.changed.fire(this.state);
    });
    this.pending = request;
    await request;
  }

  async current(): Promise<StructureSnapshot | undefined> {
    while (!this.disposed) {
      if (this.timer) { await this.refresh(); continue; }
      const request = this.pending;
      await request;
      if (this.timer || request !== this.pending) { continue; }
      return this.state;
    }
    return this.state;
  }

  private remember(uri: vscode.Uri, source: string, document?: vscode.TextDocument): ParsedSource {
    const key = Workspace.uriKey(uri);
    const previous = this.sources.get(key);
    let syntax: LaTeXParser.LaTeXSource | undefined;
    let events: StructureEvent[] | undefined;
    const parsed: ParsedSource = previous?.source === source
      ? { ...previous, document, documentVersion: document?.version }
      : { uri, source, id: ++this.nextSourceVersion, document, documentVersion: document?.version,
        get syntax() { return syntax ??= new LaTeXParser.LaTeXSource(source); },
        get events() { return events ??= parseStructureEvents(this.syntax); } };
    this.sources.set(key, parsed);
    this.localTrees.delete(key);
    this.dirty.delete(key);
    return parsed;
  }

  private capture(document: vscode.TextDocument): ParsedSource {
    const key = Workspace.uriKey(document.uri);
    this.sourceRevisions.set(key, (this.sourceRevisions.get(key) ?? 0) + 1);
    this.externalReloads.delete(key);
    return this.remember(document.uri, document.getText(), document);
  }

  private invalidateSource(key: string): void {
    this.sourceRevisions.set(key, (this.sourceRevisions.get(key) ?? 0) + 1);
    this.sources.delete(key);
    this.localTrees.delete(key);
    this.dirty.delete(key);
    this.externalReloads.delete(key);
  }

  private async read(uri: vscode.Uri, allowInitialDirty = true): Promise<ParsedSource> {
    if (this.disposed) { throw new vscode.CancellationError(); }
    const key = Workspace.uriKey(uri);
    const cached = this.sources.get(key);
    if (cached) { return cached; }
    let pending = this.sourceReads.get(key);
    if (!pending) {
      pending = (async () => {
        while (!this.disposed) {
          const revision = this.sourceRevisions.get(key) ?? 0;
          const document = Workspace.findOpenDocument(uri);
          if (document && allowInitialDirty) { return this.capture(document); }
          const source = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
          if (this.disposed) { throw new vscode.CancellationError(); }
          const newer = this.sources.get(key);
          if (newer) { return newer; }
          if (revision !== (this.sourceRevisions.get(key) ?? 0)) { continue; }
          // If a buffer opened during disk I/O, capture its first outline text.
          const opened = Workspace.findOpenDocument(uri);
          if (opened && allowInitialDirty) { return this.capture(opened); }
          const parsed = this.remember(uri, source);
          // A save that discovers a previously unseen dirty dependency must use
          // its disk baseline, not incorporate that other buffer's unsaved edit.
          if (opened) {
            // Compare text rather than relying on isDirty, whose notification
            // can lag behind the content change that triggered another save.
            if (opened.getText() === source) {
              parsed.document = opened;
              parsed.documentVersion = opened.version;
            } else { this.dirty.add(key); }
          }
          return parsed;
        }
        throw new vscode.CancellationError();
      })();
      this.sourceReads.set(key, pending);
      void pending.finally(() => {
        if (this.sourceReads.get(key) === pending) { this.sourceReads.delete(key); }
      }).catch(() => {});
    }
    return pending;
  }

  private watchDirectory(directory: vscode.Uri, candidate = false): void {
    if (this.disposed || !this.watch || directory.scheme !== 'file') { return; }
    const key = Workspace.uriKey(directory);
    if (candidate) { this.candidateDirectories.add(key); }
    if (this.watches.has(key)) { return; }
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(directory, '*'));
    const changed = (uri: vscode.Uri, existence = false) => {
      if (!this.relevant(uri)) { return; }
      const fileKey = Workspace.uriKey(uri);
      const document = Workspace.findOpenDocument(uri);
      // Ordinary saves are already captured by onDidSave. Preserve every other
      // dirty buffer even when a neighboring save triggers a project rebuild.
      if (!document) { this.invalidateSource(fileKey); }
      else if (!existence && document.isDirty) { return; }
      else if (!existence) {
        void this.readExternalChange(uri, document).catch(() => {});
        return;
      }
      this.sourcesChanged.fire();
      this.schedule();
    };
    this.watches.set(key, vscode.Disposable.from(watcher,
      watcher.onDidChange(uri => changed(uri)), watcher.onDidCreate(uri => changed(uri, true)),
      watcher.onDidDelete(uri => changed(uri, true))));
  }

  private async readExternalChange(uri: vscode.Uri, document: vscode.TextDocument): Promise<void> {
    const key = Workspace.uriKey(uri);
    const revision = this.sourceRevisions.get(key) ?? 0;
    const source = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    if (this.disposed || document.isClosed || document.isDirty || revision !== (this.sourceRevisions.get(key) ?? 0)) { return; }
    if (document.getText() === source) {
      this.capture(document);
    } else {
      // The provider can report disk changes before VS Code reloads its clean
      // buffer. These offsets stay non-navigable until that buffer catches up.
      this.sourceRevisions.set(key, revision + 1);
      this.remember(uri, source);
      this.externalReloads.set(key, source);
    }
    this.sourcesChanged.fire();
    this.schedule();
  }

  private dependency(uri: vscode.Uri, dependencies: Map<string, vscode.Uri>): void {
    if (this.disposed) { throw new vscode.CancellationError(); }
    const key = Workspace.uriKey(uri);
    dependencies.set(key, uri);
    this.watchedFiles.add(key);
    this.watchDirectory(vscode.Uri.joinPath(uri, '..'));
  }

  private async load(document: vscode.TextDocument, generation: number): Promise<LoadedSnapshot> {
    const checkCurrent = () => {
      if (this.disposed || generation !== this.generation) { throw new vscode.CancellationError(); }
    };
    const config = vscode.workspace.getConfiguration('vscode-fortex', document.uri);
    const allowInitialDirty = this.publishedDocument !== document;
    const followIncludes = config.get('outline.followIncludes', true) && document.uri.scheme === 'file';
    const dependencies = new Map<string, vscode.Uri>();
    const directories = new Set<string>();
    this.dependency(document.uri, dependencies);
    let main = document.uri;
    let message: string | undefined;
    if (followIncludes) {
      try {
        main = await LaTeXProject.resolveMainFile(document.uri, {
          readSource: async uri => { checkCurrent(); const parsed = await this.read(uri, allowInitialDirty); checkCurrent(); return parsed.source; },
          onDependency: uri => { checkCurrent(); this.dependency(uri, dependencies); },
          onDirectory: uri => { checkCurrent(); directories.add(Workspace.uriKey(uri)); this.watchDirectory(uri, true); }
        });
      } catch (error) {
        checkCurrent();
        if (error instanceof vscode.CancellationError) { throw error; }
        message = 'Main file could not be determined; showing the current file.';
      }
    }
    const files = new Map<string, vscode.Uri>();
    const checkedCandidates: { readonly uri: vscode.Uri; readonly exists: boolean }[] = [];
    const compilationDirectory = vscode.Uri.file(path.dirname(main.fsPath));
    const expanded: ExpandedEvent[] = [];
    let sequence = 0;
    const visit = async (uri: vscode.Uri, ancestors: Set<string>, site?: ExpandedEvent): Promise<void> => {
      checkCurrent();
      const key = Workspace.uriKey(uri);
      files.set(key, uri);
      this.dependency(uri, dependencies);
      if (ancestors.has(key)) {
        if (site) { expanded.push({ ...site, event: { ...site.event, type: 'issue', title: `Circular include: ${path.basename(uri.fsPath)}` } }); }
        return;
      }
      let parsed: ParsedSource;
      try { parsed = await this.read(uri, allowInitialDirty); checkCurrent(); }
      catch {
        checkCurrent();
        if (site) { expanded.push({ ...site, event: { ...site.event, type: 'issue', title: `Missing include: ${path.basename(uri.fsPath)}` } }); }
        else { throw new Error(`Cannot read ${uri.fsPath}`); }
        return;
      }
      const occurrence = String(sequence++);
      const local: ExpandedEvent[] = [];
      appendEvents(parsed, occurrence, entry => local.push(entry));
      const nextAncestors = new Set(ancestors).add(key);
      for (const entry of local) {
        if (entry.event.type !== 'include') { expanded.push(entry); continue; }
        if (!followIncludes) { expanded.push({ ...entry, event: { ...entry.event, type: 'text' } }); continue; }
        const token = LaTeXParser.readCommand(parsed.source, entry.event.start);
        if (!token || (token.name !== 'input' && token.name !== 'include')) { continue; }
        // Strict outline expansion intentionally does not expand filename macros.
        const result = await resolveInputFile(parsed.syntax, { ...token, name: token.name }, compilationDirectory);
        checkCurrent();
        checkedCandidates.push(...result.checkedCandidates);
        for (const candidate of result.checkedCandidates) { this.dependency(candidate.uri, dependencies); }
        if (result.status === 'resolved') { await visit(result.uri, nextAncestors, entry); }
        else if (result.status === 'missing') {
          const target = result.checkedCandidates[0]?.uri;
          if (target) { files.set(Workspace.uriKey(target), target); }
          expanded.push({ ...entry, event: { ...entry.event, type: 'issue', title: `Missing include: ${path.basename(target?.fsPath ?? result.filename)}` } });
        } else {
          expanded.push({ ...entry, event: { ...entry.event, type: 'issue', title: `Unresolved include: ${entry.event.path}` } });
        }
      }
    };
    await visit(main, new Set());
    checkCurrent();
    const roots = buildStructure(expanded, theoremSettings(document.uri));
    // Watch ownership follows the published scope; local Outline snapshots stay
    // alive while their document is open, independently of the project tree.
    const neededFiles = new Set([...dependencies.keys(), ...this.localFiles]);
    const neededDirectories = new Set(directories);
    for (const uri of dependencies.values()) { neededDirectories.add(Workspace.uriKey(vscode.Uri.joinPath(uri, '..'))); }
    for (const key of this.localFiles) {
      const source = this.sources.get(key);
      if (source) { neededDirectories.add(Workspace.uriKey(vscode.Uri.joinPath(source.uri, '..'))); }
    }
    // Cleanup is performed after the request wins publication, not by stale work.
    return { main, followIncludes, roots, labels: labelEntries(roots), files: [...files.values()],
      dependencies: [...dependencies.values()], checkedCandidates, message,
      neededFiles, neededDirectories, directories };
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    if (this.timer) { clearTimeout(this.timer); }
    this.timer = undefined;
    for (const watcher of this.watches.values()) { watcher.dispose(); }
    this.watches.clear(); this.watchedFiles.clear(); this.candidateDirectories.clear();
    this.sources.clear(); this.sourceReads.clear(); this.sourceRevisions.clear(); this.dirty.clear();
    this.externalReloads.clear();
    this.localTrees.clear(); this.localFiles.clear(); this.stateFiles.clear();
    for (const disposable of this.disposables) { disposable.dispose(); }
  }
}
