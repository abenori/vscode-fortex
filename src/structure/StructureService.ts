import * as vscode from 'vscode';
import * as path from 'path';
import LaTeXProject from '../project/LaTeXProject';
import { isStructureTrivia, parseStructureEvents, readHeadingTitle, StructureEvent } from './LaTeXStructureParser';
import { StructureLocation, StructureNode, StructureSnapshot } from './StructureTypes';
import * as Workspace from '../workspace';
import * as LaTeXParser from '../latex-parser';
import { resolveInputFile } from '../project/InputFileResolver';
import SourcePositionTracker, { MappedSourceAnchor, SourceEditDelta } from './SourcePositionTracker';
import { buildStructure, SourceStructureEvent, labelEntries } from './StructureBuilder';
import { sourceTextChanges } from './SourceTextChanges';
import SourceLineIndex from './SourceLineIndex';

interface SourceAnalysis {
  syntax?: LaTeXParser.LaTeXSource;
  events?: StructureEvent[];
  lines?: SourceLineIndex;
}

/** Captured file text and identity stay fixed; derived analysis is cached lazily.
 * The first capture may use an unsaved editor buffer. */
interface SourceSnapshot {
  uri: vscode.Uri;
  source: string;
  syntax: LaTeXParser.LaTeXSource;
  events: StructureEvent[];
  sourceSnapshotId: number;
  textRanges?: { start: number; end: number }[];
  analysis: SourceAnalysis;
}

/** A structure result plus mutable dependency and publication bookkeeping. */
interface StructureLoadResult extends StructureSnapshot {
  /** The exact baselines used to build this tree, retained only after publication. */
  sourceSnapshots: Map<string, SourceSnapshot>;
  /** Includes absent candidates whose creation could change input resolution. */
  checkedCandidates: readonly { readonly uri: vscode.Uri; readonly exists: boolean }[];
  neededFiles: Set<string>;
  neededDirectories: Set<string>;
  mainFileSearchDirectoryKeys: Set<string>;
}

interface LiveHeadingTitle {
  revision: number;
  title: string;
  complete: boolean;
}

interface LiveSourceState {
  document: vscode.TextDocument;
  documentVersion: number;
  /** Edits are queued even before the first native heading tree is requested. */
  batches: SourceEditDelta[][];
  tracker?: SourcePositionTracker;
  titles?: Map<number, LiveHeadingTitle>;
  projection?: { version: number; tree: StructureNode[]; nodes: StructureNode[] };
  needsRebind?: boolean;
}

interface SourceProjection {
  live: LiveSourceState;
  positions: ReturnType<SourcePositionTracker['project']>;
}

/** Compare the native provider's output, ignoring internal source identities. */
function sameHeadings(left: readonly StructureNode[], right: readonly StructureNode[]): boolean {
  return left === right || (left.length === right.length && left.every((node, index) => {
    const other = right[index];
    return node.title === other.title && node.constructName === other.constructName
      && node.declarationRange.start === other.declarationRange.start && node.declarationRange.end === other.declarationRange.end
      && node.extentEnd.end === other.extentEnd.end && sameHeadings(node.children, other.children);
  }));
}

function theoremSettings(uri: vscode.Uri): Record<string, string> {
  const configured = vscode.workspace.getConfiguration('vscode-fortex', uri).get<unknown>('outline.theoremEnvironments', {});
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) { return {}; }
  return Object.fromEntries(Object.entries(configured).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function appendEvents(sourceSnapshot: SourceSnapshot, occurrence: string, append: (entry: SourceStructureEvent) => void): void {
  if (!sourceSnapshot.textRanges) {
    const ranges: { start: number; end: number }[] = [];
    let cursor = 0;
    for (const event of sourceSnapshot.events) {
      if (event.start > cursor && !isStructureTrivia(sourceSnapshot.source.slice(cursor, event.start))) {
        ranges.push({ start: cursor, end: event.start });
      }
      cursor = Math.max(cursor, event.end);
    }
    if (!isStructureTrivia(sourceSnapshot.source.slice(cursor))) { ranges.push({ start: cursor, end: sourceSnapshot.source.length }); }
    sourceSnapshot.textRanges = ranges;
  }
  let index = 0;
  for (const event of sourceSnapshot.events) {
    while (index < sourceSnapshot.textRanges.length && sourceSnapshot.textRanges[index].end <= event.start) {
      append({ sourceSnapshot, occurrence, event: { type: 'text', ...sourceSnapshot.textRanges[index++] } });
    }
    append({ sourceSnapshot, occurrence, event });
  }
  while (index < sourceSnapshot.textRanges.length) {
    append({ sourceSnapshot, occurrence, event: { type: 'text', ...sourceSnapshot.textRanges[index++] } });
  }
}

/** Captured structure advances on source/lifecycle or settings changes; typing updates live projections. */
export default class StructureService implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<StructureSnapshot | undefined>();
  readonly onDidChange = this.changed.event;
  /** Saved-source, settings, or position-baseline changes requiring explicit symbol refresh.
   * VS Code requests symbols automatically for ordinary text edits. */
  private readonly documentSymbolsChanged = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChangeDocumentSymbols = this.documentSymbolsChanged.event;
  /** Cheap edit notification; consumers decide whether a visible view needs repainting. */
  private readonly liveSourcesChanged = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChangeLiveSources = this.liveSourcesChanged.event;
  private readonly sourceUpdatesChanged = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [this.changed, this.documentSymbolsChanged, this.liveSourcesChanged, this.sourceUpdatesChanged];
  private readonly watches = new Map<string, vscode.Disposable>();
  private readonly watchedFiles = new Set<string>();
  private readonly candidateDirectories = new Set<string>();
  private readonly sources = new Map<string, SourceSnapshot>();
  private publishedSources = new Map<string, SourceSnapshot>();
  private readonly sourceReads = new Map<string, Promise<SourceSnapshot>>();
  private readonly sourceRequestGenerations = new Map<string, number>();
  private readonly sourceUpdates = new Map<string, Promise<void>>();
  private readonly sourceFailures = new Set<string>();
  private liveSourceStates = new WeakMap<SourceSnapshot, LiveSourceState>();
  private readonly unreconciledSourceKeys = new Set<string>();
  private readonly symbolDocumentKeys = new Set<string>();
  private readonly documentHeadingTrees = new Map<string, { source: SourceSnapshot; settings: string; nodes: StructureNode[] }>();
  private selected?: vscode.TextDocument;
  private publishedDocument?: vscode.TextDocument;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private nextSourceSnapshotId = 0;
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
          if (!event.document.isDirty && this.unreconciledSourceKeys.has(key)) { this.reconcileClean(event.document); }
          return;
        }
        const current = this.sources.get(key);
        const published = this.publishedSources.get(key);
        if (!current && !published) { return; }
        const sourceSnapshots = new Set([current, published]);
        let recorded = false;
        // No getText, parsing, project discovery, or tree rebuilds on typing.
        const changes = event.contentChanges.map(change => ({
          offset: change.rangeOffset, length: change.rangeLength, insertedLength: change.text.length
        }));
        for (const sourceSnapshot of sourceSnapshots) {
          if (!sourceSnapshot) { continue; }
          const live = this.liveSourceStates.get(sourceSnapshot);
          if (live?.document === event.document && live.documentVersion === event.document.version) { continue; }
          if (live?.document === event.document) {
            if (live.tracker) { live.tracker.record(changes); }
            else { live.batches.push(changes); }
            live.documentVersion = event.document.version;
            live.projection = undefined;
          } else {
            // A document identity switch needs verification before old ranges can
            // be projected into it. Ordinary edits always use the numeric path.
            this.liveSourceStates.set(sourceSnapshot, { document: event.document, documentVersion: event.document.version,
              batches: [], needsRebind: true });
          }
          if (sourceSnapshot === current) { this.unreconciledSourceKeys.add(key); }
          recorded = true;
        }
        if (recorded) { this.liveSourcesChanged.fire(event.document.uri); }
      }),
      vscode.workspace.onDidSaveTextDocument(document => {
        if (!this.relevant(document.uri)) { return; }
        // didSave carries the live document, not the bytes written by that save.
        // Read the successful disk snapshot before advancing this one source.
        void this.refreshSource(document.uri, document);
      }),
      vscode.workspace.onDidOpenTextDocument(document => {
        const key = Workspace.uriKey(document.uri);
        if (!this.sources.has(key) && !this.publishedSources.has(key)) { return; }
        void this.refreshSource(document.uri, document);
      }),
      vscode.workspace.onDidCloseTextDocument(document => {
        const key = Workspace.uriKey(document.uri);
        if (!this.sources.has(key) && !this.publishedSources.has(key) && !this.watchedFiles.has(key)) { return; }
        for (const sourceSnapshot of [this.sources.get(key), this.publishedSources.get(key)]) {
          if (sourceSnapshot) { this.liveSourceStates.delete(sourceSnapshot); }
        }
        this.invalidateSource(key);
        this.symbolDocumentKeys.delete(key);
        this.liveSourcesChanged.fire(document.uri);
        if (this.selected === document) { this.selected = undefined; }
        if (this.selected) { this.schedule(); }
        else if (this.watch) { this.state = undefined; this.publishedSources.clear(); this.changed.fire(undefined); }
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('vscode-fortex.mainFileOrder')
          || event.affectsConfiguration('vscode-fortex.outline.followIncludes')
          || event.affectsConfiguration('vscode-fortex.outline.theoremEnvironments')) {
          if (event.affectsConfiguration('vscode-fortex.outline.theoremEnvironments')) {
            for (const key of this.symbolDocumentKeys) {
              const sourceSnapshot = this.sources.get(key);
              const document = sourceSnapshot && Workspace.findOpenDocument(sourceSnapshot.uri);
              if (!sourceSnapshot || !document) { continue; }
              const before = this.projectDocumentHeadings(document, sourceSnapshot, false);
              this.documentHeadingTrees.delete(key);
              this.notifyDocumentSymbolsChange(document, before, this.projectDocumentHeadings(document, sourceSnapshot));
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

  /** Captured hierarchy with shared live heading names and approximate positions. */
  async getDocumentHeadings(document: vscode.TextDocument): Promise<StructureNode[]> {
    if (this.disposed || document.isClosed) { return []; }
    const key = Workspace.uriKey(document.uri);
    this.symbolDocumentKeys.add(key);
    this.watchedFiles.add(key);
    this.watchDirectory(vscode.Uri.joinPath(document.uri, '..'));
    await this.waitForSourceUpdates(key);
    if (this.disposed || document.isClosed) { return []; }
    const sourceSnapshot = await this.read(document.uri);
    if (this.disposed || document.isClosed) { return []; }
    return this.projectDocumentHeadings(document, sourceSnapshot);
  }

  /** Synchronous so source commits can compare both trees in the same live version. */
  private projectDocumentHeadings(document: vscode.TextDocument, sourceSnapshot: SourceSnapshot, updateSettings = true): StructureNode[] {
    const key = Workspace.uriKey(document.uri);
    const projection = this.ensureLiveSourceProjection(sourceSnapshot, document);
    const live = projection.live;
    let local = this.documentHeadingTrees.get(key);
    const settings = updateSettings || !local ? theoremSettings(document.uri) : undefined;
    const signature = settings ? JSON.stringify(settings) : local!.settings;
    if (local?.source !== sourceSnapshot || local.settings !== signature) {
      const expanded: SourceStructureEvent[] = [];
      appendEvents(sourceSnapshot, 'local', entry => expanded.push(entry));
      local = { source: sourceSnapshot, settings: signature, nodes: this.onlyHeadings(buildStructure(expanded, settings ?? {})) };
      this.documentHeadingTrees.set(key, local);
    }
    if (live.projection?.version === document.version && live.projection.tree === local.nodes) {
      return live.projection.nodes;
    }
    const nodes = this.projectHeadings(local.nodes, sourceSnapshot, document, projection);
    live.projection = { version: document.version, tree: local.nodes, nodes };
    return nodes;
  }

  private notifyDocumentSymbolsChange(document: vscode.TextDocument, before: StructureNode[], after: StructureNode[]): void {
    if (!sameHeadings(before, after)) { this.documentSymbolsChanged.fire(document.uri); }
    else if (before[0]?.declarationRange.sourceSnapshotId === after[0]?.declarationRange.sourceSnapshotId) {
      // An unchanged save keeps the same immutable projection and conversion.
      const sourceSnapshot = this.sources.get(Workspace.uriKey(document.uri));
      const live = sourceSnapshot && this.liveSourceStates.get(sourceSnapshot);
      if (live?.projection) { live.projection.nodes = before; }
    }
  }

  private onlyHeadings(nodes: readonly StructureNode[]): StructureNode[] {
    return nodes.flatMap(node => {
      const children = this.onlyHeadings(node.children);
      return node.kind === 'section' ? [{ ...node, children }] : children;
    });
  }

  private projectHeadings(nodes: readonly StructureNode[], sourceSnapshot: SourceSnapshot,
    document: vscode.TextDocument, projection: SourceProjection): StructureNode[] {
    return nodes.map(node => ({ ...this.projectSourceNode(node, sourceSnapshot, document, projection),
      children: this.projectHeadings(node.children, sourceSnapshot, document, projection) }));
  }

  /** Each captured source has one numerical projection shared by local and project views. */
  private ensureLiveSourceProjection(sourceSnapshot: SourceSnapshot, document: vscode.TextDocument): SourceProjection {
    let live = this.liveSourceStates.get(sourceSnapshot);
    if (!live || live.document !== document || live.needsRebind || live.documentVersion !== document.version) {
      live = this.bindLive(sourceSnapshot, document, document.getText());
    }
    if (!live.tracker) {
      // Structural events already belong to the captured source analysis. Include their
      // endpoints so labels and cross-file section extents can move too.
      const anchors = new Map(sourceSnapshot.events.map(event => [event.start,
        { start: event.start, end: event.end }]));
      for (const offset of [...sourceSnapshot.events.map(event => event.end), sourceSnapshot.source.length]) {
        if (!anchors.has(offset)) { anchors.set(offset, { start: offset, end: offset }); }
      }
      live.tracker = new SourcePositionTracker([...anchors.values()]);
      for (const batch of live.batches) { live.tracker.record(batch); }
      live.batches = [];
    }
    return { live, positions: live.tracker.project() };
  }

  /** Project original captured offsets, not an already-projected location.
   * The result retains the original baseline ID; missing baselines leave offsets unchanged. */
  projectLocation(location: StructureLocation): StructureLocation {
    const sourceSnapshot = this.sourceSnapshotFor(location);
    const document = Workspace.findOpenDocument(location.uri);
    if (this.disposed || !sourceSnapshot || !document) { return location; }
    const { positions } = this.ensureLiveSourceProjection(sourceSnapshot, document);
    return this.mapLocation(location, positions);
  }

  /** Old project nodes remain live until their replacement tree is published. */
  private sourceSnapshotFor(location: StructureLocation): SourceSnapshot | undefined {
    const key = Workspace.uriKey(location.uri);
    const current = this.sources.get(key);
    if (current?.sourceSnapshotId === location.sourceSnapshotId) { return current; }
    const published = this.publishedSources.get(key);
    return published?.sourceSnapshotId === location.sourceSnapshotId ? published : undefined;
  }

  private mapLocation(location: StructureLocation, positions: SourceProjection['positions']): StructureLocation {
    const mapped = positions.get(location.start);
    const start = mapped?.start ?? location.start;
    const end = location.end === location.start ? start
      : mapped?.end ?? positions.get(location.end)?.start ?? location.end;
    return { ...location, start, end: Math.max(start, end) };
  }

  /** Project an original captured node, preserving identity/hierarchy even if its declaration is incomplete or removed.
   * Pass original nodes; returned locations retain the original baseline ID. */
  projectNode(node: StructureNode, projectExtentEnd = true): StructureNode {
    const sourceSnapshot = this.sourceSnapshotFor(node.declarationRange);
    const document = Workspace.findOpenDocument(node.declarationRange.uri);
    if (this.disposed || !sourceSnapshot || !document) {
      return { ...node, extentEnd: projectExtentEnd ? this.projectLocation(node.extentEnd) : node.extentEnd };
    }
    return this.projectSourceNode(node, sourceSnapshot, document, this.ensureLiveSourceProjection(sourceSnapshot, document), projectExtentEnd);
  }

  private projectSourceNode(node: StructureNode, sourceSnapshot: SourceSnapshot, document: vscode.TextDocument,
    { live, positions }: SourceProjection, projectExtentEnd = true): StructureNode {
    const extentEnd = !projectExtentEnd ? node.extentEnd : node.extentEnd.uri.toString() === sourceSnapshot.uri.toString() && node.extentEnd.sourceSnapshotId === sourceSnapshot.sourceSnapshotId
      ? this.mapLocation(node.extentEnd, positions) : this.projectLocation(node.extentEnd);
    const projected = { ...node, declarationRange: this.mapLocation(node.declarationRange, positions), extentEnd };
    if (node.kind !== 'section') { return projected; }
    const position = positions.get(node.declarationRange.start);
    if (!position) { return projected; }
    const title = this.liveHeadingTitle(node, document, live, position);
    projected.title = title.title;
    if (!title.complete) {
      // The command start still provides a useful destination when its argument
      // is unfinished. Deleted commands retain an approximate destination too.
      projected.declarationRange.end = projected.declarationRange.start + node.constructName.length + 1;
    }
    return projected;
  }

  private liveHeadingTitle(node: StructureNode, document: vscode.TextDocument, live: LiveSourceState,
    position: MappedSourceAnchor): LiveHeadingTitle {
    live.titles ??= new Map();
    let title = live.titles.get(node.declarationRange.start);
    if (!title) {
      title = { revision: 0, title: node.title, complete: true };
      live.titles.set(node.declarationRange.start, title);
    }
    if (title.revision !== position.revision) {
      // Bound work for unusually large/incomplete pasted declarations. Keep the
      // last readable name rather than scanning a document-sized fragment.
      const fragment = position.end - position.start <= 16_384
        ? document.getText(new vscode.Range(document.positionAt(position.start), document.positionAt(position.end))) : undefined;
      let updated = fragment === undefined ? undefined : readHeadingTitle(fragment, node.constructName);
      if (updated === undefined && fragment !== undefined && fragment.length < 16_384) {
        // Reinserting a deleted closing brace sits just outside the left-affine
        // saved declaration end. Probe one character, not the following body.
        const suffix = document.getText(new vscode.Range(document.positionAt(position.end), document.positionAt(position.end + 1)));
        if (suffix === '}') { updated = readHeadingTitle(fragment + suffix, node.constructName); }
      }
      title = { revision: position.revision, title: updated === undefined ? title.title : updated || `\\${node.constructName}`,
        complete: updated !== undefined };
      live.titles.set(node.declarationRange.start, title);
    }
    return title;
  }

  /** Descriptions never open documents as a rendering side effect. */
  lineNumber(location: StructureLocation): number | undefined {
    const document = Workspace.findOpenDocument(location.uri);
    if (document) { return document.positionAt(this.projectLocation(location).start).line + 1; }
    const sourceSnapshot = this.sourceSnapshotFor(location);
    if (!sourceSnapshot) { return undefined; }
    const analysis = sourceSnapshot.analysis;
    const lines = analysis.lines ??= new SourceLineIndex(sourceSnapshot.source);
    return lines.lineNumberAt(location.start);
  }

  private relevant(uri: vscode.Uri): boolean {
    const key = Workspace.uriKey(uri);
    return this.sources.has(key) || this.watchedFiles.has(key)
      || (uri.scheme === 'file' && path.extname(uri.path).toLowerCase() === '.tex'
        && this.candidateDirectories.has(Workspace.uriKey(vscode.Uri.joinPath(uri, '..'))));
  }

  private reconcileClean(document: vscode.TextDocument): void {
    const key = Workspace.uriKey(document.uri);
    const sourceSnapshot = this.sources.get(key);
    if (!sourceSnapshot || document.isClosed) { return; }
    const source = document.getText();
    if (source !== sourceSnapshot.source) {
      // A save can report clean while an even newer buffer was never written.
      // Only verified disk contents may replace a differing captured baseline.
      queueMicrotask(() => {
        if (!this.disposed && !document.isClosed && !this.sourceUpdates.has(key)) {
          void this.refreshSource(document.uri, document);
        }
      });
      return;
    }
    const before = this.symbolDocumentKeys.has(key) ? this.projectDocumentHeadings(document, sourceSnapshot) : undefined;
    this.bindLive(sourceSnapshot, document, source);
    if (before) { this.notifyDocumentSymbolsChange(document, before, this.projectDocumentHeadings(document, sourceSnapshot)); }
    this.liveSourcesChanged.fire(document.uri);
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
    const targetDocument = document ?? this.selected ?? vscode.window.activeTextEditor?.document;
    if (!targetDocument || targetDocument.isClosed || targetDocument.languageId !== 'latex') { return; }
    this.selected = targetDocument;
    const generation = ++this.generation;
    const request = (async () => {
      await this.waitForSourceUpdates();
      if (this.disposed || generation !== this.generation) { throw new vscode.CancellationError(); }
      return this.load(targetDocument, generation);
    })().then(async loadResult => {
      if (this.disposed || generation !== this.generation) { return; }
      // An input resolver may discover an absent candidate just before its watch
      // was registered. Recheck existence under the now-established observation.
      const changed = await Promise.all(loadResult.checkedCandidates.map(async candidate => {
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
      for (const key of this.symbolDocumentKeys) {
        loadResult.neededFiles.add(key);
        const sourceSnapshot = this.sources.get(key);
        if (sourceSnapshot) { loadResult.neededDirectories.add(Workspace.uriKey(vscode.Uri.joinPath(sourceSnapshot.uri, '..'))); }
      }
      for (const key of this.sources.keys()) {
        if (!loadResult.neededFiles.has(key)) { this.invalidateSource(key); }
      }
      for (const [key, watcher] of this.watches) {
        if (!loadResult.neededDirectories.has(key)) { watcher.dispose(); this.watches.delete(key); }
      }
      this.watchedFiles.clear();
      for (const key of loadResult.neededFiles) { this.watchedFiles.add(key); }
      this.candidateDirectories.clear();
      for (const key of loadResult.mainFileSearchDirectoryKeys) { this.candidateDirectories.add(key); }
      this.publishedDocument = targetDocument;
      this.publishedSources = loadResult.sourceSnapshots;
      this.state = loadResult;
      this.projectRefreshFailed = false;
      this.changed.fire(loadResult);
    }).catch(error => {
      if (this.disposed || generation !== this.generation) { return; }
      this.projectRefreshFailed = true;
      const message = `Unable to read LaTeX structure: ${error instanceof Error ? error.message : String(error)}`;
      this.state = this.state ? { ...this.state, message }
        : { main: targetDocument.uri, followIncludes: false, roots: [], labels: [], message };
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

  private remember(uri: vscode.Uri, source: string): SourceSnapshot {
    const key = Workspace.uriKey(uri);
    const previous = this.sources.get(key);
    const sameSource = previous?.source === source;
    if (sameSource) {
      this.unreconciledSourceKeys.delete(key);
      return previous;
    }
    const analysis: SourceAnalysis = {};
    const sourceSnapshot: SourceSnapshot = { uri, source, sourceSnapshotId: ++this.nextSourceSnapshotId,
      analysis,
      get syntax() { return analysis.syntax ??= new LaTeXParser.LaTeXSource(source); },
      get events() { return analysis.events ??= parseStructureEvents(this.syntax); } };
    this.sources.set(key, sourceSnapshot);
    this.documentHeadingTrees.delete(key);
    this.unreconciledSourceKeys.delete(key);
    return sourceSnapshot;
  }

  private capture(document: vscode.TextDocument): SourceSnapshot {
    const key = Workspace.uriKey(document.uri);
    this.sourceRequestGenerations.set(key, (this.sourceRequestGenerations.get(key) ?? 0) + 1);
    const source = document.getText();
    const sourceSnapshot = this.remember(document.uri, source);
    this.bindLive(sourceSnapshot, document, source);
    return sourceSnapshot;
  }

  private bindLive(sourceSnapshot: SourceSnapshot, document: vscode.TextDocument, liveSource: string): LiveSourceState {
    const key = Workspace.uriKey(sourceSnapshot.uri);
    const edits = sourceTextChanges(sourceSnapshot.source, liveSource);
    const live: LiveSourceState = { document, documentVersion: document.version,
      batches: edits.length ? [edits] : [] };
    this.liveSourceStates.set(sourceSnapshot, live);
    // A retained project baseline can differ from already-saved bytes. Its
    // projection must not mark the latest source as needing reconciliation.
    if (this.sources.get(key) === sourceSnapshot) {
      if (sourceSnapshot.source === liveSource) { this.unreconciledSourceKeys.delete(key); }
      else { this.unreconciledSourceKeys.add(key); }
    }
    return live;
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
    const revision = (this.sourceRequestGenerations.get(key) ?? 0) + 1;
    this.sourceRequestGenerations.set(key, revision);
    const current = () => !this.disposed && this.sourceRequestGenerations.get(key) === revision
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
      const before = previous && document && this.symbolDocumentKeys.has(key) ? this.projectDocumentHeadings(document, previous) : undefined;
      const live = previous && this.liveSourceStates.get(previous);
      if (document && source === previous?.source && liveSource !== source
        && live?.document === document && live.documentVersion === document.version && !live.needsRebind) {
        // An unchanged disk notification must not replace an exact edit journal
        // with a potentially conservative diff across a large ambiguous body.
        this.unreconciledSourceKeys.add(key);
      } else {
        const sourceSnapshot = this.remember(uri, source);
        if (document && liveSource !== undefined) { this.bindLive(sourceSnapshot, document, liveSource); }
        else { this.liveSourceStates.delete(sourceSnapshot); }
      }
      const recovered = this.sourceFailures.delete(key);
      if (before && document) {
        this.notifyDocumentSymbolsChange(document, before, this.projectDocumentHeadings(document, this.sources.get(key)!));
      }
      this.liveSourcesChanged.fire(uri);
      // Save and filesystem notifications may describe the same bytes. Rebind
      // positions above, but do not repeat project discovery/tree construction.
      if (this.selected && (changed || recovered || this.projectRefreshFailed)) { this.schedule(); }
    })().catch(error => {
      if (!current()) { return; }
      // Keep both the previous structure and its numeric projection on failure.
      this.sourceFailures.add(key);
      if (expectedDocument) { this.unreconciledSourceKeys.add(key); }
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
    this.sourceRequestGenerations.set(key, (this.sourceRequestGenerations.get(key) ?? 0) + 1);
    this.sources.delete(key);
    this.sourceFailures.delete(key);
    this.documentHeadingTrees.delete(key);
    this.unreconciledSourceKeys.delete(key);
    if (this.sourceUpdates.delete(key)) { this.sourceUpdatesChanged.fire(); }
  }

  private async read(uri: vscode.Uri, preferOpenBufferOnFirstRead = true): Promise<SourceSnapshot> {
    if (this.disposed) { throw new vscode.CancellationError(); }
    const key = Workspace.uriKey(uri);
    const cached = this.sources.get(key);
    if (cached) { return cached; }
    let pending = this.sourceReads.get(key);
    if (!pending) {
      pending = (async () => {
        while (!this.disposed) {
          const revision = this.sourceRequestGenerations.get(key) ?? 0;
          const document = Workspace.findOpenDocument(uri);
          if (document && preferOpenBufferOnFirstRead) { return this.capture(document); }
          const source = await Workspace.readFileText(uri);
          if (this.disposed) { throw new vscode.CancellationError(); }
          const newer = this.sources.get(key);
          if (newer) { return newer; }
          if (revision !== (this.sourceRequestGenerations.get(key) ?? 0)) { continue; }
          // If a buffer opened during disk I/O, capture its first outline text.
          const opened = Workspace.findOpenDocument(uri);
          if (opened && preferOpenBufferOnFirstRead) { return this.capture(opened); }
          const sourceSnapshot = this.remember(uri, source);
          // A save that discovers a previously unseen dirty dependency must use
          // its disk baseline, not incorporate that other buffer's unsaved edit.
          if (opened) {
            this.bindLive(sourceSnapshot, opened, opened.getText());
          }
          return sourceSnapshot;
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

  private async load(document: vscode.TextDocument, generation: number): Promise<StructureLoadResult> {
    const checkCurrent = () => {
      if (this.disposed || generation !== this.generation) { throw new vscode.CancellationError(); }
    };
    const config = vscode.workspace.getConfiguration('vscode-fortex', document.uri);
    const preferOpenBufferOnFirstRead = this.publishedDocument !== document;
    const followIncludes = config.get('outline.followIncludes', true) && document.uri.scheme === 'file';
    const dependencies = new Map<string, vscode.Uri>();
    const mainFileSearchDirectoryKeys = new Set<string>();
    this.dependency(document.uri, dependencies);
    let main = document.uri;
    let message: string | undefined;
    if (followIncludes) {
      try {
        main = await LaTeXProject.resolveMainFile(document.uri, {
          readSource: async uri => { checkCurrent(); const sourceSnapshot = await this.read(uri, preferOpenBufferOnFirstRead); checkCurrent(); return sourceSnapshot.source; },
          onDependency: uri => { checkCurrent(); this.dependency(uri, dependencies); },
          onDirectory: uri => { checkCurrent(); mainFileSearchDirectoryKeys.add(Workspace.uriKey(uri)); this.watchDirectory(uri, true); }
        });
      } catch (error) {
        checkCurrent();
        if (error instanceof vscode.CancellationError) { throw error; }
        if (this.publishedDocument === document && this.state) { throw error; }
        message = 'Main file could not be determined; showing the current file.';
      }
    }
    const checkedCandidates: { readonly uri: vscode.Uri; readonly exists: boolean }[] = [];
    const compilationDirectory = vscode.Uri.file(path.dirname(main.fsPath));
    const expanded: SourceStructureEvent[] = [];
    const sourceSnapshots = new Map<string, SourceSnapshot>();
    let sequence = 0;
    const visit = async (uri: vscode.Uri, ancestors: Set<string>, site?: SourceStructureEvent): Promise<void> => {
      checkCurrent();
      const key = Workspace.uriKey(uri);
      this.dependency(uri, dependencies);
      if (ancestors.has(key)) {
        if (site) { expanded.push({ ...site, event: { ...site.event, type: 'issue', title: `Circular include: ${path.basename(uri.fsPath)}` } }); }
        return;
      }
      let sourceSnapshot: SourceSnapshot;
      try { sourceSnapshot = await this.read(uri, preferOpenBufferOnFirstRead); checkCurrent(); }
      catch (error) {
        checkCurrent();
        if ((error as { code?: string }).code !== 'FileNotFound') { throw error; }
        if (site) { expanded.push({ ...site, event: { ...site.event, type: 'issue', title: `Missing include: ${path.basename(uri.fsPath)}` } }); }
        else { throw new Error(`Cannot read ${uri.fsPath}`); }
        return;
      }
      const occurrence = String(sequence++);
      sourceSnapshots.set(key, sourceSnapshot);
      const local: SourceStructureEvent[] = [];
      appendEvents(sourceSnapshot, occurrence, entry => local.push(entry));
      const nextAncestors = new Set(ancestors).add(key);
      for (const entry of local) {
        if (entry.event.type !== 'include') { expanded.push(entry); continue; }
        if (!followIncludes) { expanded.push({ ...entry, event: { ...entry.event, type: 'text' } }); continue; }
        const token = LaTeXParser.readCommand(sourceSnapshot.source, entry.event.start);
        if (!token || (token.name !== 'input' && token.name !== 'include')) { continue; }
        // Strict outline expansion intentionally does not expand filename macros.
        const result = await resolveInputFile(sourceSnapshot.syntax, { ...token, name: token.name }, compilationDirectory);
        checkCurrent();
        checkedCandidates.push(...result.checkedCandidates);
        for (const candidate of result.checkedCandidates) { this.dependency(candidate.uri, dependencies); }
        if (result.status === 'resolved') { await visit(result.uri, nextAncestors, entry); }
        else if (result.status === 'missing') {
          const target = result.checkedCandidates[0]?.uri;
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
    const neededFiles = new Set([...dependencies.keys(), ...this.symbolDocumentKeys]);
    const neededDirectories = new Set(mainFileSearchDirectoryKeys);
    for (const uri of dependencies.values()) { neededDirectories.add(Workspace.uriKey(vscode.Uri.joinPath(uri, '..'))); }
    for (const key of this.symbolDocumentKeys) {
      const source = this.sources.get(key);
      if (source) { neededDirectories.add(Workspace.uriKey(vscode.Uri.joinPath(source.uri, '..'))); }
    }
    // Cleanup is performed after the request wins publication, not by stale work.
    return { main, followIncludes, roots, labels: labelEntries(roots),
      sourceSnapshots, checkedCandidates, message,
      neededFiles, neededDirectories, mainFileSearchDirectoryKeys };
  }

  dispose(): void {
    this.disposed = true;
    this.sourceUpdatesChanged.fire();
    this.generation++;
    if (this.timer) { clearTimeout(this.timer); }
    this.timer = undefined;
    for (const watcher of this.watches.values()) { watcher.dispose(); }
    this.watches.clear(); this.watchedFiles.clear(); this.candidateDirectories.clear();
    this.sources.clear(); this.sourceReads.clear(); this.sourceRequestGenerations.clear(); this.unreconciledSourceKeys.clear();
    this.publishedSources.clear(); this.liveSourceStates = new WeakMap(); this.sourceUpdates.clear();
    this.documentHeadingTrees.clear(); this.symbolDocumentKeys.clear(); this.sourceFailures.clear();
    for (const disposable of this.disposables) { disposable.dispose(); }
  }
}
