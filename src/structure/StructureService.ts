import * as vscode from 'vscode';
import * as path from 'path';
import LaTeXProject from '../project/LaTeXProject';
import { isStructureTrivia, parseStructureEvents, StructureEvent, structurePlainText } from './LaTeXStructureParser';
import { StructureKind, StructureLabelEntry, StructureLocation, StructureNode, StructureSnapshot } from './StructureTypes';
import * as Workspace from '../workspace';
import * as LaTeXParser from '../latex-parser';
import { resolveInputFile } from '../project/InputFileResolver';
import NativeOutlinePositions, { OutlineEdit } from './NativeOutlinePositions';
import { sourceTextChanges } from './SourceTextChanges';

interface SourceAnalysis {
  syntax?: LaTeXParser.LaTeXSource;
  events?: StructureEvent[];
}

interface ParsedSource {
  uri: vscode.Uri;
  source: string;
  syntax: LaTeXParser.LaTeXSource;
  events: StructureEvent[];
  id?: number;
  document?: vscode.TextDocument;
  documentVersion?: number;
  textRanges?: { start: number; end: number }[];
  analysis?: SourceAnalysis;
}

interface LoadedSnapshot extends StructureSnapshot {
  /** Includes absent candidates whose creation could change input resolution. */
  dependencies: vscode.Uri[];
  checkedCandidates: readonly { readonly uri: vscode.Uri; readonly exists: boolean }[];
  neededFiles: Set<string>;
  neededDirectories: Set<string>;
  directories: Set<string>;
}

interface LivePositions {
  document: vscode.TextDocument;
  version: number;
  sourceId: number | undefined;
  /** Edits are queued even before the first native heading tree is requested. */
  batches: OutlineEdit[][];
  tracker?: NativeOutlinePositions;
  projection?: { version: number; tree: StructureNode[]; nodes: StructureNode[] };
  unknown?: boolean;
}

interface ExpandedEvent {
  parsed: ParsedSource;
  occurrence: string;
  event: StructureEvent | { type: 'text'; start: number; end: number } | { type: 'issue'; title: string; start: number; end: number };
}

/** Compare the native provider's output, ignoring internal source identities. */
function sameHeadings(left: readonly StructureNode[], right: readonly StructureNode[]): boolean {
  return left === right || (left.length === right.length && left.every((node, index) => {
    const other = right[index];
    return node.title === other.title && node.command === other.command
      && node.location.start === other.location.start && node.location.end === other.location.end
      && node.end.end === other.end.end && sameHeadings(node.children, other.children);
  }));
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
  /** Saved-source, settings, or position-baseline changes requiring explicit symbol refresh.
   * VS Code requests symbols automatically for ordinary text edits. */
  private readonly documentSymbolsChanged = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChangeDocumentSymbols = this.documentSymbolsChanged.event;
  private readonly sourceUpdatesChanged = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [this.changed, this.documentSymbolsChanged, this.sourceUpdatesChanged];
  private readonly watches = new Map<string, vscode.Disposable>();
  private readonly watchedFiles = new Set<string>();
  private readonly candidateDirectories = new Set<string>();
  private readonly sources = new Map<string, ParsedSource>();
  private readonly sourceReads = new Map<string, Promise<ParsedSource>>();
  private readonly sourceRevisions = new Map<string, number>();
  private readonly sourceUpdates = new Map<string, Promise<void>>();
  private readonly sourceFailures = new Set<string>();
  private readonly livePositions = new Map<string, LivePositions>();
  private readonly dirty = new Set<string>();
  private readonly localFiles = new Set<string>();
  private readonly localTrees = new Map<string, { source: ParsedSource; settings: string; nodes: StructureNode[] }>();
  private selected?: vscode.TextDocument;
  private publishedDocument?: vscode.TextDocument;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private nextSourceVersion = 0;
  private pending?: Promise<void>;
  private projectRefreshFailed = false;
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
        if (!parsed) { return; }
        const live = this.livePositions.get(key);
        if (live?.document === event.document && live.version === event.document.version) { return; }
        // No getText, parsing, project discovery, timers, or tree rebuilds on typing.
        const changes = event.contentChanges.map(change => ({
          offset: change.rangeOffset, length: change.rangeLength, insertedLength: change.text.length
        }));
        if (live?.document === event.document && live.sourceId === parsed.id) {
          if (live.tracker) { live.tracker.record(changes); }
          else { live.batches.push(changes); }
          live.version = event.document.version;
          live.projection = undefined;
        } else {
          // A document identity switch needs verification before old ranges can
          // be projected into it. Ordinary edits always use the numeric path.
          this.livePositions.set(key, { document: event.document, version: event.document.version,
            sourceId: parsed.id, batches: [], unknown: true });
        }
        this.dirty.add(key);
      }),
      vscode.workspace.onDidSaveTextDocument(document => {
        if (!this.relevant(document.uri)) { return; }
        // didSave carries the live document, not the bytes written by that save.
        // Read the successful disk snapshot before advancing this one source.
        void this.refreshSource(document.uri, document);
      }),
      vscode.workspace.onDidOpenTextDocument(document => {
        const key = Workspace.uriKey(document.uri);
        if (!this.sources.has(key)) { return; }
        void this.refreshSource(document.uri, document);
      }),
      vscode.workspace.onDidCloseTextDocument(document => {
        const key = Workspace.uriKey(document.uri);
        if (!this.sources.has(key) && !this.watchedFiles.has(key)) { return; }
        this.invalidateSource(key);
        this.localFiles.delete(key);
        if (this.selected === document) { this.selected = undefined; }
        if (this.selected) { this.schedule(); }
        else if (this.watch) { this.state = undefined; this.changed.fire(undefined); }
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('vscode-fortex.mainFileOrder')
          || event.affectsConfiguration('vscode-fortex.outline.followIncludes')
          || event.affectsConfiguration('vscode-fortex.outline.theoremEnvironments')) {
          if (event.affectsConfiguration('vscode-fortex.outline.theoremEnvironments')) {
            for (const key of this.localFiles) {
              const parsed = this.sources.get(key);
              const document = parsed && Workspace.findOpenDocument(parsed.uri);
              if (!parsed || !document) { continue; }
              const before = this.localNodes(document, parsed, false);
              this.localTrees.delete(key);
              this.notifyDocumentSymbolsChange(document, before, this.localNodes(document, parsed));
            }
          }
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

  /** Native Outline keeps saved headings and projects only their live positions. */
  async local(document: vscode.TextDocument): Promise<StructureNode[]> {
    if (this.disposed || document.isClosed) { return []; }
    const key = Workspace.uriKey(document.uri);
    this.localFiles.add(key);
    this.watchedFiles.add(key);
    this.watchDirectory(vscode.Uri.joinPath(document.uri, '..'));
    await this.waitForSourceUpdates(key);
    if (this.disposed || document.isClosed) { return []; }
    const parsed = await this.read(document.uri);
    if (this.disposed || document.isClosed) { return []; }
    return this.localNodes(document, parsed);
  }

  /** Synchronous so source commits can compare both trees in the same live version. */
  private localNodes(document: vscode.TextDocument, parsed: ParsedSource, updateSettings = true): StructureNode[] {
    const key = Workspace.uriKey(document.uri);
    let live = this.livePositions.get(key);
    if (!live || live.document !== document || live.sourceId !== parsed.id) {
      this.bindLive(parsed, document, document.getText());
      live = this.livePositions.get(key)!;
    }
    if (live.unknown || live.version !== document.version) { return []; }
    let local = this.localTrees.get(key);
    const settings = updateSettings || !local ? theoremSettings(document.uri) : undefined;
    const signature = settings ? JSON.stringify(settings) : local!.settings;
    if (local?.source !== parsed || local.settings !== signature) {
      const expanded: ExpandedEvent[] = [];
      appendEvents(parsed, 'local', entry => expanded.push(entry));
      local = { source: parsed, settings: signature, nodes: this.onlyHeadings(buildStructure(expanded, settings ?? {})) };
      this.localTrees.set(key, local);
    }
    if (live.projection?.version === document.version && live.projection.tree === local.nodes) {
      return live.projection.nodes;
    }
    if (!live.tracker) {
      const headings = this.headingNodes(local.nodes);
      live.tracker = new NativeOutlinePositions(headings.map(node => ({
        start: node.location.start, end: node.location.end, extent: node.end.end
      })));
      for (const batch of live.batches) { live.tracker.record(batch); }
      live.batches = [];
    }
    const nodes = this.projectHeadings(local.nodes, live.tracker.project());
    live.projection = { version: document.version, tree: local.nodes, nodes };
    return nodes;
  }

  private notifyDocumentSymbolsChange(document: vscode.TextDocument, before: StructureNode[], after: StructureNode[]): void {
    if (!sameHeadings(before, after)) { this.documentSymbolsChanged.fire(document.uri); }
    else if (before[0]?.location.sourceVersion === after[0]?.location.sourceVersion) {
      // An unchanged save keeps the same immutable projection and conversion.
      const live = this.livePositions.get(Workspace.uriKey(document.uri));
      if (live?.projection) { live.projection.nodes = before; }
    }
  }

  private headingNodes(nodes: readonly StructureNode[]): StructureNode[] {
    return nodes.flatMap(node => [...(node.kind === 'section' ? [node] : []), ...this.headingNodes(node.children)]);
  }

  private onlyHeadings(nodes: readonly StructureNode[]): StructureNode[] {
    return nodes.flatMap(node => {
      const children = this.onlyHeadings(node.children);
      return node.kind === 'section' ? [{ ...node, children }] : children;
    });
  }

  private projectHeadings(
    nodes: readonly StructureNode[], positions: ReturnType<NativeOutlinePositions['project']>
  ): StructureNode[] {
    return nodes.flatMap(node => {
      const children = this.projectHeadings(node.children, positions);
      const position = positions.get(node.location.start);
      if (node.kind !== 'section' || !position?.valid) { return children; }
      return [{ ...node, location: { ...node.location, start: position.start, end: position.end },
        end: { ...node.end, start: position.extent, end: position.extent }, children }];
    });
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
    return !document.isClosed && !this.dirty.has(Workspace.uriKey(document.uri))
      && parsed.document === document && parsed.documentVersion === document.version;
  }

  private relevant(uri: vscode.Uri): boolean {
    const key = Workspace.uriKey(uri);
    return this.sources.has(key) || this.watchedFiles.has(key)
      || (uri.scheme === 'file' && path.extname(uri.path).toLowerCase() === '.tex'
        && this.candidateDirectories.has(Workspace.uriKey(vscode.Uri.joinPath(uri, '..'))));
  }

  private reconcileClean(document: vscode.TextDocument): void {
    const key = Workspace.uriKey(document.uri);
    const parsed = this.sources.get(key);
    if (!parsed || document.isClosed) { return; }
    const source = document.getText();
    if (source !== parsed.source) {
      // A save can report clean while an even newer buffer was never written.
      // Only verified disk contents may replace a differing saved snapshot.
      queueMicrotask(() => {
        if (!this.disposed && !document.isClosed && !this.sourceUpdates.has(key)) {
          void this.refreshSource(document.uri, document);
        }
      });
      return;
    }
    const before = this.localFiles.has(key) ? this.localNodes(document, parsed) : undefined;
    parsed.document = document;
    parsed.documentVersion = document.version;
    this.bindLive(parsed, document, source);
    this.dirty.delete(key);
    if (before) { this.notifyDocumentSymbolsChange(document, before, this.localNodes(document, parsed)); }
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
    const request = (async () => {
      await this.waitForSourceUpdates();
      if (this.disposed || generation !== this.generation) { throw new vscode.CancellationError(); }
      return this.load(active, generation);
    })().then(async snapshot => {
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
      this.publishedDocument = active;
      this.state = snapshot;
      this.projectRefreshFailed = false;
      this.changed.fire(snapshot);
    }).catch(error => {
      if (this.disposed || generation !== this.generation) { return; }
      this.projectRefreshFailed = true;
      const message = `Unable to read LaTeX structure: ${error instanceof Error ? error.message : String(error)}`;
      this.state = this.state ? { ...this.state, message }
        : { main: active.uri, followIncludes: false, roots: [], labels: [], files: [active.uri], message };
      this.changed.fire(this.state);
    });
    this.pending = request;
    await request;
  }

  async current(): Promise<StructureSnapshot | undefined> {
    while (!this.disposed) {
      await this.waitForSourceUpdates();
      if (this.disposed) { break; }
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
    const sameSource = previous?.source === source;
    if (sameSource) {
      previous.document = document;
      previous.documentVersion = document?.version;
      this.dirty.delete(key);
      return previous;
    }
    const analysis: SourceAnalysis = {};
    const parsed: ParsedSource = { uri, source, id: ++this.nextSourceVersion,
      document, documentVersion: document?.version, analysis,
      get syntax() { return analysis.syntax ??= new LaTeXParser.LaTeXSource(source); },
      get events() { return analysis.events ??= parseStructureEvents(this.syntax); } };
    this.sources.set(key, parsed);
    this.localTrees.delete(key);
    this.dirty.delete(key);
    return parsed;
  }

  private capture(document: vscode.TextDocument): ParsedSource {
    const key = Workspace.uriKey(document.uri);
    this.sourceRevisions.set(key, (this.sourceRevisions.get(key) ?? 0) + 1);
    const source = document.getText();
    const parsed = this.remember(document.uri, source, document);
    this.bindLive(parsed, document, source);
    return parsed;
  }

  private bindLive(parsed: ParsedSource, document: vscode.TextDocument, liveSource: string): void {
    const key = Workspace.uriKey(parsed.uri);
    const edits = sourceTextChanges(parsed.source, liveSource);
    this.livePositions.set(key, { document, version: document.version, sourceId: parsed.id,
      batches: edits.length ? [edits] : [] });
    if (parsed.source === liveSource) {
      parsed.document = document;
      parsed.documentVersion = document.version;
      this.dirty.delete(key);
    } else {
      parsed.document = undefined;
      parsed.documentVersion = undefined;
      this.dirty.add(key);
    }
  }

  private async waitForSourceUpdates(key?: string): Promise<void> {
    while (!this.disposed) {
      let subscription: vscode.Disposable | undefined;
      const changed = new Promise<void>(resolve => { subscription = this.sourceUpdatesChanged.event(() => resolve()); });
      try {
        const requests = key ? [this.sourceUpdates.get(key)].filter((value): value is Promise<void> => value !== undefined)
          : [...this.sourceUpdates.values()];
        if (!requests.length) { return; }
        // A newer save can supersede blocked old I/O. Waiters follow the latest
        // source request instead of remaining attached to an obsolete read.
        await Promise.race([Promise.all(requests), changed]);
      } finally { subscription?.dispose(); }
    }
  }

  /** Read the saved bytes, then atomically bridge them to one captured live version. */
  private refreshSource(uri: vscode.Uri, expectedDocument?: vscode.TextDocument): Promise<void> {
    if (this.disposed) { return Promise.resolve(); }
    const key = Workspace.uriKey(uri);
    const revision = (this.sourceRevisions.get(key) ?? 0) + 1;
    this.sourceRevisions.set(key, revision);
    const current = () => !this.disposed && this.sourceRevisions.get(key) === revision
      && (!expectedDocument || !expectedDocument.isClosed);
    const request = (async () => {
      const source = await Workspace.readFileText(uri);
      if (!current()) { return; }
      const document = Workspace.findOpenDocument(uri);
      if (expectedDocument && document !== expectedDocument) { return; }
      // No await between capturing this live version, creating its bridge, and
      // installing the new source. Later edit events append to this new journal.
      const liveSource = document?.getText();
      const previous = this.sources.get(key);
      const changed = previous?.source !== source;
      const before = previous && document && this.localFiles.has(key) ? this.localNodes(document, previous) : undefined;
      const live = this.livePositions.get(key);
      if (document && source === previous?.source && liveSource !== source
        && live?.document === document && live.version === document.version && live.sourceId === previous.id && !live.unknown) {
        // An unchanged disk notification must not replace an exact edit journal
        // with a potentially conservative diff across a large ambiguous body.
        this.dirty.add(key);
      } else {
        const parsed = this.remember(uri, source);
        if (document && liveSource !== undefined) { this.bindLive(parsed, document, liveSource); }
        else { this.livePositions.delete(key); }
      }
      const recovered = this.sourceFailures.delete(key);
      if (before && document) {
        this.notifyDocumentSymbolsChange(document, before, this.localNodes(document, this.sources.get(key)!));
      }
      // Save and filesystem notifications may describe the same bytes. Rebind
      // positions above, but do not repeat project discovery/tree construction.
      if (this.selected && (changed || recovered || this.projectRefreshFailed)) { this.schedule(); }
    })().catch(error => {
      if (!current()) { return; }
      // Keep both the previous structure and its numeric projection on failure.
      this.sourceFailures.add(key);
      if (expectedDocument) { this.dirty.add(key); }
      if (this.state) {
        this.state = { ...this.state, message: `Unable to update LaTeX structure: ${error instanceof Error ? error.message : String(error)}` };
        this.changed.fire(this.state);
      }
    }).finally(() => {
      if (this.sourceUpdates.get(key) === request) {
        this.sourceUpdates.delete(key);
        this.sourceUpdatesChanged.fire();
      }
    });
    this.sourceUpdates.set(key, request);
    this.sourceUpdatesChanged.fire();
    return request;
  }

  private invalidateSource(key: string): void {
    this.sourceRevisions.set(key, (this.sourceRevisions.get(key) ?? 0) + 1);
    this.sources.delete(key);
    this.sourceFailures.delete(key);
    this.localTrees.delete(key);
    this.dirty.delete(key);
    this.livePositions.delete(key);
    if (this.sourceUpdates.delete(key)) { this.sourceUpdatesChanged.fire(); }
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
          const source = await Workspace.readFileText(uri);
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
            this.bindLive(parsed, opened, opened.getText());
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
      if (this.sources.has(fileKey)) { void this.refreshSource(uri, document); }
      else { this.invalidateSource(fileKey); this.schedule(); }
      // Existence changes can alter root/input selection even if reading the
      // old source now fails (for example, deletion of an included document).
      if (existence) { this.schedule(); }
    };
    this.watches.set(key, vscode.Disposable.from(watcher,
      watcher.onDidChange(uri => changed(uri)), watcher.onDidCreate(uri => changed(uri, true)),
      watcher.onDidDelete(uri => changed(uri, true))));
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
        if (this.publishedDocument === document && this.state) { throw error; }
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
      catch (error) {
        checkCurrent();
        if ((error as { code?: string }).code !== 'FileNotFound') { throw error; }
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
    this.sourceUpdatesChanged.fire();
    this.generation++;
    if (this.timer) { clearTimeout(this.timer); }
    this.timer = undefined;
    for (const watcher of this.watches.values()) { watcher.dispose(); }
    this.watches.clear(); this.watchedFiles.clear(); this.candidateDirectories.clear();
    this.sources.clear(); this.sourceReads.clear(); this.sourceRevisions.clear(); this.dirty.clear();
    this.livePositions.clear(); this.sourceUpdates.clear();
    this.localTrees.clear(); this.localFiles.clear(); this.sourceFailures.clear();
    for (const disposable of this.disposables) { disposable.dispose(); }
  }
}
