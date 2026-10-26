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
}

interface LoadedSnapshot extends StructureSnapshot {
  /** Includes absent candidates whose creation could change input resolution. */
  dependencies: vscode.Uri[];
  checkedCandidates: readonly { readonly uri: vscode.Uri; readonly exists: boolean }[];
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
  return { uri: parsed.uri, start, end };
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
  let cursor = 0;
  for (const event of parsed.events) {
    if (event.start > cursor && !isStructureTrivia(parsed.source.slice(cursor, event.start))) {
      append({ parsed, occurrence, event: { type: 'text', start: cursor, end: event.start } });
    }
    append({ parsed, occurrence, event });
    cursor = Math.max(cursor, event.end);
  }
  if (!isStructureTrivia(parsed.source.slice(cursor))) {
    append({ parsed, occurrence, event: { type: 'text', start: cursor, end: parsed.source.length } });
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

export default class StructureService implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<StructureSnapshot | undefined>();
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [this.changed];
  private readonly watches = new Map<string, vscode.Disposable>();
  private readonly sources = new Map<string, ParsedSource>();
  private selected?: vscode.TextDocument;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private pending?: Promise<void>;
  private disposed = false;
  private state?: StructureSnapshot;
  get snapshot(): StructureSnapshot | undefined { return this.state; }

  constructor(private readonly watch = true) {
    if (!watch) { return; }
    const schedule = () => this.schedule();
    this.disposables.push(LaTeXProject.onDidChange(schedule),
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor?.document.languageId === 'latex') { this.selected = editor.document; this.schedule(); }
      }),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document.languageId !== 'latex') { return; }
        const key = Workspace.uriKey(event.document.uri);
        if (key === (this.selected && Workspace.uriKey(this.selected.uri)) || this.watches.has(key)) { this.schedule(); }
      }),
      vscode.workspace.onDidCloseTextDocument(document => {
        if (this.watches.has(Workspace.uriKey(document.uri))) { this.schedule(); }
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('vscode-fortex.outline.followIncludes')
          || event.affectsConfiguration('vscode-fortex.outline.theoremEnvironments')) {
          schedule();
        }
      }));
    if (vscode.window.activeTextEditor?.document.languageId === 'latex') {
      this.selected = vscode.window.activeTextEditor.document;
      this.schedule();
    }
  }

  private schedule(): void {
    if (this.disposed) { return; }
    // Invalidate a running request immediately, before the debounce elapses.
    this.generation++;
    if (this.timer) { clearTimeout(this.timer); }
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, 250);
  }

  async refresh(document?: vscode.TextDocument): Promise<void> {
    if (this.disposed) { return; }
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const active = document ?? (vscode.window.activeTextEditor?.document.languageId === 'latex'
      ? vscode.window.activeTextEditor.document : this.selected);
    if (!active || active.languageId !== 'latex') { return; }
    this.selected = active;
    const generation = ++this.generation;
    const request = this.load(active).then(async snapshot => {
      if (this.disposed || generation !== this.generation) { return; }
      if (this.watch) {
        const fresh = this.updateWatches(snapshot.files, snapshot.dependencies);
        // The first existence check preceded watcher registration. Close that
        // gap before publishing, including for absent non-.tex candidates.
        const changed = await Promise.all(snapshot.checkedCandidates
          .filter(candidate => fresh.has(Workspace.uriKey(candidate.uri)))
          .map(async candidate => {
            let exists = false;
            try {
              const stat = await vscode.workspace.fs.stat(candidate.uri);
              exists = (stat.type & vscode.FileType.File) !== 0;
            } catch (error) {
              if ((error as { code?: string }).code !== 'FileNotFound') { throw error; }
            }
            return exists !== candidate.exists;
          }));
        if (this.disposed || generation !== this.generation) { return; }
        if (changed.some(Boolean)) { this.schedule(); return; }
      }
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
      const generation = this.generation;
      await request;
      if (this.timer || request !== this.pending || generation !== this.generation) { continue; }
      return this.state;
    }
    return this.state;
  }

  private async read(uri: vscode.Uri): Promise<ParsedSource> {
    const diskOrBuffer = await Workspace.readDocumentText(uri);
    // A buffer may open or change while the provider read is pending.
    const source = Workspace.findOpenDocument(uri)?.getText() ?? diskOrBuffer;
    const key = Workspace.uriKey(uri);
    const cached = this.sources.get(key);
    if (cached?.source === source) { return cached; }
    const syntax = new LaTeXParser.LaTeXSource(source);
    const parsed = { uri, source, syntax, events: parseStructureEvents(syntax) };
    this.sources.set(key, parsed);
    return parsed;
  }

  private async load(document: vscode.TextDocument): Promise<LoadedSnapshot> {
    const config = vscode.workspace.getConfiguration('vscode-fortex', document.uri);
    const followIncludes = config.get('outline.followIncludes', true) && document.uri.scheme === 'file';
    let main = document.uri;
    let message: string | undefined;
    if (followIncludes && document.uri.scheme === 'file') {
      try {
        // Share main-file discovery; expand inputs from the structure parser's events.
        main = await LaTeXProject.resolveMainFile(document.uri);
      } catch {
        message = 'Main file could not be determined; showing the current file.';
      }
    }
    const files = new Map<string, vscode.Uri>();
    const dependencies = new Map<string, vscode.Uri>();
    const checkedCandidates: { readonly uri: vscode.Uri; readonly exists: boolean }[] = [];
    const compilationDirectory = vscode.Uri.file(path.dirname(main.fsPath));
    const expanded: ExpandedEvent[] = [];
    let sequence = 0;
    const visit = async (uri: vscode.Uri, ancestors: Set<string>, site?: ExpandedEvent): Promise<void> => {
      const key = Workspace.uriKey(uri);
      files.set(key, uri);
      dependencies.set(key, uri);
      if (ancestors.has(key)) {
        if (site) { expanded.push({ ...site, event: { ...site.event, type: 'issue', title: `Circular include: ${path.basename(uri.fsPath)}` } }); }
        return;
      }
      let parsed: ParsedSource;
      try {
        parsed = await this.read(uri);
      } catch {
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
        // Outline input expansion deliberately has no macro lookup. It shares
        // filename syntax and existence checks with LaTeXProject, not its graph.
        const result = await resolveInputFile(parsed.syntax, { ...token, name: token.name }, compilationDirectory);
        checkedCandidates.push(...result.checkedCandidates);
        for (const candidate of result.checkedCandidates) {
          dependencies.set(Workspace.uriKey(candidate.uri), candidate.uri);
        }
        if (result.status === 'resolved') {
          await visit(result.uri, nextAncestors, entry);
        } else if (result.status === 'missing') {
          const target = result.checkedCandidates[0]?.uri;
          if (target) { files.set(Workspace.uriKey(target), target); }
          expanded.push({ ...entry, event: { ...entry.event, type: 'issue',
            title: `Missing include: ${path.basename(target?.fsPath ?? result.filename)}` } });
        } else {
          expanded.push({ ...entry, event: { ...entry.event, type: 'issue', title: `Unresolved include: ${entry.event.path}` } });
        }
      }
    };
    await visit(main, new Set());
    const roots = buildStructure(expanded, theoremSettings(document.uri));
    return { main, followIncludes, roots, labels: labelEntries(roots), files: [...files.values()],
      dependencies: [...dependencies.values()], checkedCandidates, message };
  }

  private updateWatches(files: vscode.Uri[], dependencies: vscode.Uri[]): Set<string> {
    const sources = new Set(files.map(Workspace.uriKey));
    const needed = new Set(dependencies.map(Workspace.uriKey));
    const fresh = new Set<string>();
    for (const key of this.sources.keys()) { if (!sources.has(key)) { this.sources.delete(key); } }
    for (const [key, watcher] of this.watches) {
      if (!needed.has(key)) { watcher.dispose(); this.watches.delete(key); this.sources.delete(key); }
    }
    for (const uri of dependencies) {
      const key = Workspace.uriKey(uri);
      if (this.watches.has(key) || uri.scheme !== 'file') { continue; }
      // Watch a literal directory, then compare URIs so glob characters in a
      // source filename (for example chapter[1].tex) remain literal.
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(
        vscode.Uri.file(path.dirname(uri.fsPath)), '*'));
      const invalidate = (changed: vscode.Uri) => {
        if (Workspace.uriKey(changed) === key) { this.schedule(); }
      };
      const subscriptions = [watcher, watcher.onDidChange(invalidate), watcher.onDidCreate(invalidate), watcher.onDidDelete(invalidate)];
      this.watches.set(key, vscode.Disposable.from(...subscriptions));
      fresh.add(key);
    }
    return fresh;
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    if (this.timer) { clearTimeout(this.timer); }
    for (const watcher of this.watches.values()) { watcher.dispose(); }
    for (const disposable of this.disposables) { disposable.dispose(); }
    this.watches.clear(); this.sources.clear();
  }
}
