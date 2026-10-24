import * as vscode from 'vscode';
import * as path from 'path';
import LaTeXProject from '../project/LaTeXProject';
import { isStructureTrivia, parseStructureEvents, StructureEvent, structurePlainText } from './LaTeXStructureParser';
import { StructureKind, StructureLabelEntry, StructureLocation, StructureNode, StructureSnapshot } from './StructureTypes';
import * as Workspace from '../workspace';

interface ParsedSource {
  uri: vscode.Uri;
  source: string;
  events: StructureEvent[];
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
          const content = parsed.source.slice(env.contentStart, event.start)
            .replace(/\\(?:begin|end)\s*\{[^{}]*\}/g, '');
          env.node.title = structurePlainText(content).slice(0, 100) || env.name;
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
  const parsed = { uri: document.uri, source, events: parseStructureEvents(source) };
  const expanded: ExpandedEvent[] = [];
  appendEvents(parsed, 'local', entry => expanded.push(entry));
  return buildStructure(expanded, theoremSettings(document.uri));
}

function projectSignature(source: string): string {
  return JSON.stringify([source.match(/^%#main\b[^\r\n]*/gm),
    source.match(/\\(?:documentclass|input|include)\b\s*(?:\[[^\]]*\])?\s*\{[^{}]*\}/g)]);
}

export default class StructureService implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<StructureSnapshot | undefined>();
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [this.changed];
  private readonly watches = new Map<string, vscode.Disposable>();
  private readonly sources = new Map<string, ParsedSource>();
  private readonly parents = new Map<string, { signature: string; main: vscode.Uri }>();
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
    const invalidate = () => { this.parents.clear(); this.schedule(); };
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.tex');
    this.disposables.push(watcher, watcher.onDidChange(invalidate), watcher.onDidCreate(invalidate), watcher.onDidDelete(invalidate),
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor?.document.languageId === 'latex') { this.selected = editor.document; this.schedule(); }
      }),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document.languageId !== 'latex') { return; }
        const key = Workspace.uriKey(event.document.uri);
        const old = this.sources.get(key);
        if (!old || projectSignature(old.source) !== projectSignature(event.document.getText())) { this.parents.clear(); }
        if (key === (this.selected && Workspace.uriKey(this.selected.uri)) || this.watches.has(key)) { this.schedule(); }
      }),
      vscode.workspace.onDidCloseTextDocument(document => {
        if (this.watches.has(Workspace.uriKey(document.uri))) { this.parents.clear(); this.schedule(); }
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('vscode-fortex.mainFileOrder')
          || event.affectsConfiguration('vscode-fortex.outline.followIncludes')
          || event.affectsConfiguration('vscode-fortex.outline.theoremEnvironments')) {
          this.parents.clear(); schedule();
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
    const request = this.load(active).then(snapshot => {
      if (this.disposed || generation !== this.generation) { return; }
      this.state = snapshot;
      if (this.watch) { this.updateWatches(snapshot.files); }
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
    const source = await Workspace.readDocumentText(uri);
    const key = Workspace.uriKey(uri);
    const cached = this.sources.get(key);
    if (cached?.source === source) { return cached; }
    const parsed = { uri, source, events: parseStructureEvents(source) };
    this.sources.set(key, parsed);
    return parsed;
  }

  private async load(document: vscode.TextDocument): Promise<StructureSnapshot> {
    const config = vscode.workspace.getConfiguration('vscode-fortex', document.uri);
    const followIncludes = config.get('outline.followIncludes', true) && document.uri.scheme === 'file';
    let main = document.uri;
    let message: string | undefined;
    if (followIncludes && document.uri.scheme === 'file') {
      const key = Workspace.uriKey(document.uri);
      const signature = projectSignature(document.getText()) + JSON.stringify(config.get('mainFileOrder'));
      const cached = this.parents.get(key);
      try {
        // Deliberately use the exact entry point used by BuildManager.build.
        main = cached?.signature === signature ? cached.main : (await LaTeXProject.generate_project(document.uri, true))[1];
        this.parents.set(key, { signature, main });
      } catch {
        message = 'Main file could not be determined; showing the current file.';
      }
    }
    const files = new Map<string, vscode.Uri>();
    const expanded: ExpandedEvent[] = [];
    let sequence = 0;
    const visit = async (uri: vscode.Uri, ancestors: Set<string>, site?: ExpandedEvent): Promise<void> => {
      const key = Workspace.uriKey(uri);
      files.set(key, uri);
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
        const target = LaTeXProject.resolveIncludedFile(uri, entry.event.path);
        if (target) { await visit(target, nextAncestors, entry); }
        else { expanded.push({ ...entry, event: { ...entry.event, type: 'issue', title: `Unresolved include: ${entry.event.path}` } }); }
      }
    };
    await visit(main, new Set());
    const roots = buildStructure(expanded, theoremSettings(document.uri));
    return { main, followIncludes, roots, labels: labelEntries(roots), files: [...files.values()], message };
  }

  private updateWatches(files: vscode.Uri[]): void {
    const needed = new Set(files.map(Workspace.uriKey));
    for (const key of this.sources.keys()) { if (!needed.has(key)) { this.sources.delete(key); } }
    for (const [key, watcher] of this.watches) {
      if (!needed.has(key)) { watcher.dispose(); this.watches.delete(key); this.sources.delete(key); }
    }
    for (const uri of files) {
      const key = Workspace.uriKey(uri);
      if (this.watches.has(key) || uri.scheme !== 'file') { continue; }
      // Watch a literal directory, then compare URIs so glob characters in a
      // source filename (for example chapter[1].tex) remain literal.
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(
        vscode.Uri.file(path.dirname(uri.fsPath)), '*'));
      const invalidate = (changed: vscode.Uri) => {
        if (Workspace.uriKey(changed) === key) { this.parents.clear(); this.schedule(); }
      };
      const subscriptions = [watcher, watcher.onDidChange(invalidate), watcher.onDidCreate(invalidate), watcher.onDidDelete(invalidate)];
      this.watches.set(key, vscode.Disposable.from(...subscriptions));
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    if (this.timer) { clearTimeout(this.timer); }
    for (const watcher of this.watches.values()) { watcher.dispose(); }
    for (const disposable of this.disposables) { disposable.dispose(); }
    this.watches.clear(); this.sources.clear(); this.parents.clear();
  }
}
