import * as vscode from 'vscode';
import StructureService from './StructureService';
import { StructureKind, StructureLabel, StructureLabelEntry, StructureLocation, StructureNode, StructureSnapshot } from './StructureTypes';
import { uriKey } from '../workspace';

export interface StructureFilterOptions {
  visibleKinds: readonly StructureKind[];
  equations: 'all' | 'labeled' | 'hidden';
  labeledOnly: boolean;
}

interface StructureViewSettings extends StructureFilterOptions {
  showLabels: boolean;
  viewMode: 'structure' | 'labels';
}

const defaultKinds: StructureKind[] = ['section', 'theorem', 'figure', 'table', 'label'];

/** Filters a display projection, preserving source nodes and promoting visible descendants. */
export function filterStructure(nodes: readonly StructureNode[], options: StructureFilterOptions): StructureNode[] {
  const visibleKinds = new Set(options.visibleKinds);
  const visit = (node: StructureNode): StructureNode[] => {
    const children = node.children.flatMap(visit);
    const categoryVisible = node.kind === 'issue' || (node.kind === 'equation'
      ? options.equations === 'all' || (options.equations === 'labeled' && node.labels.length > 0)
      : visibleKinds.has(node.kind));
    const labelVisible = !options.labeledOnly || node.kind === 'issue' || node.labels.length > 0
      || (node.kind === 'section' && children.length > 0);
    return categoryVisible && labelVisible ? [{ ...node, children }] : children;
  };
  return nodes.flatMap(visit);
}

interface NodeElement {
  type: 'node';
  node: StructureNode;
  children: TreeElement[];
}

interface LabelElement {
  type: 'label';
  entry: StructureLabelEntry;
}

type TreeElement = NodeElement | LabelElement;

interface DisplayItem {
  item: vscode.TreeItem;
  title: string;
  source: string;
  suffix: string;
  epoch: number;
}

interface LabelPick extends vscode.QuickPickItem {
  labelEntry: StructureLabelEntry;
}

/** Owns the native project Structure view and its workspace-local display preferences. */
export default class StructureView implements vscode.TreeDataProvider<TreeElement>, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<TreeElement | TreeElement[] | undefined>();
  readonly onDidChangeTreeData = this.changes.event;
  private readonly view: vscode.TreeView<TreeElement>;
  private readonly disposables: vscode.Disposable[] = [];
  private snapshot: StructureSnapshot | undefined;
  private settings: StructureViewSettings;
  private roots: TreeElement[] = [];
  private readonly elementsByFile = new Map<string, TreeElement[]>();
  private readonly fileEpochs = new Map<string, number>();
  private readonly dirtyFiles = new Set<string>();
  private itemCache = new WeakMap<TreeElement, DisplayItem>();
  private elementFiles = new WeakMap<TreeElement, string>();
  private parents = new WeakMap<TreeElement, TreeElement>();
  private liveTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext, private readonly service: StructureService) {
    this.snapshot = service.snapshot;
    this.settings = this.readSettings();
    this.view = vscode.window.createTreeView('fortex.structure', { treeDataProvider: this, showCollapseAll: true });
    const register = (name: string, action: (element?: TreeElement) => unknown) => {
      this.disposables.push(vscode.commands.registerCommand(`vscode-fortex.outline.${name}`, async (element?: TreeElement) => {
        try {
          await action(element);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          void vscode.window.showErrorMessage(`Unable to update LaTeX structure: ${message}`);
        }
      }));
    };
    register('filter', () => this.chooseFilter());
    register('toggleLabels', () => this.updateSetting('showLabels', !this.settings.showLabels));
    register('toggleLabeledOnly', () => this.updateSetting('labeledOnly', !this.settings.labeledOnly));
    register('toggleMode', () => this.updateSetting('viewMode', this.settings.viewMode === 'structure' ? 'labels' : 'structure'));
    register('searchLabels', () => this.searchLabels());
    register('open', element => this.openElement(element ?? this.view.selection[0]));
    register('goToLabel', element => this.goToLabel(element ?? this.view.selection[0]));
    this.disposables.push(
      service.onDidChange(snapshot => {
        this.snapshot = snapshot;
        this.settings = this.readSettings();
        this.rebuild();
      }),
      service.onDidChangeLiveSources(uri => {
        const key = uriKey(uri);
        if (!this.elementsByFile.has(key)) { return; }
        this.fileEpochs.set(key, (this.fileEpochs.get(key) ?? 0) + 1);
        this.dirtyFiles.add(key);
        this.scheduleLiveDisplay();
      }),
      this.view.onDidChangeVisibility(event => {
        if (!event.visible) {
          if (this.liveTimer) { clearTimeout(this.liveTimer); this.liveTimer = undefined; }
        } else { this.refreshLiveDisplay(); }
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('vscode-fortex.outline')) {
          this.settings = this.readSettings();
          this.rebuild();
        }
      })
    );
    this.rebuild();
    void service.current().then(snapshot => {
      if (!this.disposed) {
        this.snapshot = snapshot;
        this.settings = this.readSettings();
        this.rebuild();
      }
    }, () => {
      // The service exposes discovery failures through its snapshot message.
    });
  }

  getChildren(element?: TreeElement): TreeElement[] {
    return element?.type === 'node' ? element.children : element ? [] : this.roots;
  }

  getTreeItem(element: TreeElement): vscode.TreeItem {
    const key = this.elementFiles.get(element) ?? uriKey(this.elementLocation(element).uri);
    const epoch = this.fileEpochs.get(key) ?? 0;
    const previous = this.itemCache.get(element);
    if (previous?.epoch === epoch) { return previous.item; }
    const title = this.displayTitle(element);
    if (previous) {
      previous.epoch = epoch;
      if (previous.title === title) { return previous.item; }
    }
    // Line numbers are display snapshots. Offset-only edits need no redraw;
    // navigation independently resolves the latest position when clicked.
    const suffix = previous?.suffix ?? this.lineSuffix(this.elementLocation(element));
    const source = previous?.source ?? `${this.fileName(this.elementLocation(element).uri)}${suffix}`;
    const item = this.makeTreeItem(element, title, source, suffix);
    this.itemCache.set(element, { item, title, source, suffix, epoch });
    return item;
  }

  private elementLocation(element: TreeElement): StructureLocation {
    return element.type === 'label' ? element.entry.label.location : element.node.location;
  }

  private displayTitle(element: TreeElement): string {
    const node = element.type === 'label' ? element.entry.node : element.node;
    if (element.type === 'label' && uriKey(node.location.uri) !== uriKey(element.entry.label.location.uri)) {
      return node.title; // Cross-file label descriptions advance only on full rebuilds.
    }
    // Reading a title must not project a section end in another included file.
    return node.kind === 'section' ? this.service.projectNode(node, false).title : node.title;
  }

  private makeTreeItem(element: TreeElement, title: string, source: string, suffix: string): vscode.TreeItem {
    if (element.type === 'label') {
      const { entry } = element;
      const item = new vscode.TreeItem(entry.label.key, vscode.TreeItemCollapsibleState.None);
      item.id = `label:${entry.label.location.uri.toString()}:${entry.label.location.start}:${entry.label.key}`;
      item.description = [entry.duplicate ? 'Duplicate key' : '', entry.node.kind === 'label' ? '' : title, source,
        entry.occurrences > 1 ? `${entry.occurrences} inclusions` : ''].filter(Boolean).join(' · ');
      item.tooltip = `${entry.label.key}\n${entry.node.kind === 'label' ? 'Standalone label' : title}\n${entry.label.location.uri.fsPath || entry.label.location.uri.toString()}${suffix}${entry.duplicate ? '\nThis key is declared at more than one source location.' : ''}`;
      item.iconPath = new vscode.ThemeIcon(entry.duplicate ? 'warning' : 'tag');
      item.contextValue = 'fortex.structure.label';
      item.command = { command: 'vscode-fortex.outline.open', title: 'Go to Label', arguments: [element] };
      return item;
    }
    const node = element.node;
    const item = new vscode.TreeItem(title || `\\${node.command}`,
      element.children.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    item.id = `node:${node.id}`;
    item.description = [
      this.settings.showLabels && node.kind !== 'label' ? node.labels.map(label => label.key).join(', ') : '',
      source
    ].filter(Boolean).join(' · ');
    item.tooltip = [title, node.command ? `\\${node.command}` : '',
      ...node.labels.map(label => `Label: ${label.key}`),
      `${node.location.uri.fsPath || node.location.uri.toString()}${suffix}`].filter(Boolean).join('\n');
    const icons: Record<StructureKind, string> = {
      section: 'symbol-namespace', theorem: 'symbol-class', equation: 'symbol-operator',
      figure: 'file-media', table: 'table', label: 'tag', issue: 'warning'
    };
    item.iconPath = new vscode.ThemeIcon(icons[node.kind]);
    item.contextValue = node.kind === 'issue' ? 'fortex.structure.issue'
      : node.labels.length > 0 ? 'fortex.structure.node.labeled' : 'fortex.structure.node';
    item.command = { command: 'vscode-fortex.outline.open', title: 'Go to Source', arguments: [element] };
    return item;
  }

  private rebuild(): void {
    if (this.disposed) {
      return;
    }
    if (this.liveTimer) { clearTimeout(this.liveTimer); this.liveTimer = undefined; }
    this.dirtyFiles.clear();
    this.elementsByFile.clear();
    this.fileEpochs.clear();
    this.itemCache = new WeakMap();
    this.elementFiles = new WeakMap();
    this.parents = new WeakMap();
    if (this.settings.viewMode === 'labels') {
      this.roots = [...(this.snapshot?.labels ?? [])]
        .sort((left, right) => left.label.key.localeCompare(right.label.key)
          || left.label.location.uri.toString().localeCompare(right.label.location.uri.toString())
          || left.label.location.start - right.label.location.start)
        .map(entry => this.registerElement({ type: 'label', entry }));
    } else {
      const wrap = (node: StructureNode, parent?: TreeElement): NodeElement => {
        const element: NodeElement = { type: 'node', node, children: [] };
        this.registerElement(element, parent);
        element.children = node.children.map(child => wrap(child, element));
        return element;
      };
      this.roots = filterStructure(this.snapshot?.roots ?? [], this.settings).map(node => wrap(node));
    }
    this.view.title = this.settings.viewMode === 'labels' ? 'LaTeX Structure: Labels' : 'LaTeX Structure';
    this.updateStatus();
    void vscode.commands.executeCommand('setContext', 'fortex.structure.showLabels', this.settings.showLabels);
    void vscode.commands.executeCommand('setContext', 'fortex.structure.labeledOnly', this.settings.labeledOnly);
    void vscode.commands.executeCommand('setContext', 'fortex.structure.labelMode', this.settings.viewMode === 'labels');
    this.changes.fire(undefined);
  }

  private registerElement<T extends TreeElement>(element: T, parent?: TreeElement): T {
    const key = uriKey(this.elementLocation(element).uri);
    const elements = this.elementsByFile.get(key) ?? [];
    elements.push(element);
    this.elementsByFile.set(key, elements);
    this.elementFiles.set(element, key);
    if (parent) { this.parents.set(element, parent); }
    return element;
  }

  private refreshLiveDisplay(): void {
    if (this.disposed || !this.view.visible) { return; }
    const files = [...this.dirtyFiles];
    this.dirtyFiles.clear();
    const changed = new Set<TreeElement>();
    for (const key of files) {
      for (const element of this.elementsByFile.get(key) ?? []) {
        const cached = this.itemCache.get(element);
        if (cached && this.getTreeItem(element) !== cached.item) { changed.add(element); }
      }
    }
    // A changed parent already refreshes its shown descendants in VS Code.
    const roots = [...changed].filter(element => {
      for (let parent = this.parents.get(element); parent; parent = this.parents.get(parent)) {
        if (changed.has(parent)) { return false; }
      }
      return true;
    });
    if (roots.length) { this.changes.fire(roots.length === 1 ? roots[0] : roots); }
  }

  /** Coalesce redraws while typing without delaying them until typing stops. */
  private scheduleLiveDisplay(): void {
    if (this.disposed || !this.view.visible || this.liveTimer) { return; }
    this.liveTimer = setTimeout(() => {
      this.liveTimer = undefined;
      this.refreshLiveDisplay();
    }, 100);
  }

  private updateStatus(): void {
    this.view.description = this.snapshot
      ? `${this.fileName(this.snapshot.main)}${this.snapshot.followIncludes ? '' : ' · Current file only'}`
      : undefined;
    this.view.message = this.snapshot?.message
      || (!this.snapshot ? 'Open a LaTeX document to see its structure.'
        : this.roots.length > 0 ? undefined : this.settings.viewMode === 'labels' ? 'No labels found.' : 'No structure items match the current filter.');
  }

  private readSettings(): StructureViewSettings {
    const config = vscode.workspace.getConfiguration('vscode-fortex', this.snapshot?.main);
    const read = <T>(name: string, fallback: T): T => {
      const value = config.get<T>(`outline.${name}`, fallback);
      return vscode.workspace.workspaceFolders?.length ? value : this.context.workspaceState.get<T>(`outline.${name}`, value);
    };
    const kinds = read<StructureKind[]>('visibleKinds', defaultKinds);
    const equations = read<string>('equations', 'labeled');
    return {
      visibleKinds: Array.isArray(kinds) ? kinds.filter(kind => defaultKinds.includes(kind)) : defaultKinds,
      equations: equations === 'all' || equations === 'hidden' ? equations : 'labeled',
      showLabels: read<boolean>('showLabels', true),
      labeledOnly: read<boolean>('labeledOnly', false),
      viewMode: read<string>('viewMode', 'structure') === 'labels' ? 'labels' : 'structure'
    };
  }

  private async updateSetting<K extends keyof StructureViewSettings>(name: K, value: StructureViewSettings[K]): Promise<void> {
    if (vscode.workspace.workspaceFolders?.length) {
      await vscode.workspace.getConfiguration('vscode-fortex').update(`outline.${name}`, value, vscode.ConfigurationTarget.Workspace);
    } else {
      await this.context.workspaceState.update(`outline.${name}`, value);
    }
    this.settings = this.readSettings();
    this.rebuild();
  }

  private async chooseFilter(): Promise<void> {
    const labels: Record<string, string> = {
      section: 'Headings', theorem: 'Theorems', figure: 'Figures', table: 'Tables', label: 'Standalone labels'
    };
    const categories = await vscode.window.showQuickPick(defaultKinds.map(kind => ({
      label: labels[kind], structureKind: kind, picked: this.settings.visibleKinds.includes(kind)
    })), { title: 'Filter Structure (1/2)', placeHolder: 'Choose the categories to show', canPickMany: true });
    if (!categories) {
      return;
    }
    const equationItems: (vscode.QuickPickItem & { value: StructureViewSettings['equations'] })[] = [
      { label: 'Labeled equations', value: 'labeled' },
      { label: 'All equations', value: 'all' },
      { label: 'Hide equations', value: 'hidden' }
    ];
    const equations = await vscode.window.showQuickPick(equationItems.map(item => ({ ...item,
      description: item.value === this.settings.equations ? 'Current' : undefined
    })), { title: 'Filter Structure (2/2)', placeHolder: 'Choose which equations to show' });
    if (!equations) {
      return;
    }
    await this.updateSetting('visibleKinds', categories.map(category => category.structureKind));
    await this.updateSetting('equations', equations.value);
  }

  private async searchLabels(): Promise<void> {
    const snapshot = await this.service.current();
    if (!snapshot || snapshot.labels.length === 0) {
      void vscode.window.showInformationMessage('No labels found in the current LaTeX structure.');
      return;
    }
    const items = await Promise.all([...snapshot.labels].sort((left, right) => left.label.key.localeCompare(right.label.key))
      .map(async (entry): Promise<LabelPick> => ({
        label: entry.label.key,
        description: [entry.node.kind === 'label' ? '' : this.displayTitle({ type: 'label', entry }), entry.duplicate ? 'Duplicate key' : ''].filter(Boolean).join(' · '),
        detail: `${await this.sourceDescription(entry.label.location)}${entry.occurrences > 1 ? ` · ${entry.occurrences} inclusions` : ''}`,
        labelEntry: entry
      })));
    const selected = await vscode.window.showQuickPick(items, {
      title: 'Go to LaTeX Label', placeHolder: 'Search all labels in the current scope', matchOnDescription: true, matchOnDetail: true
    });
    if (selected) {
      await this.openLocation(selected.labelEntry.label.location);
    }
  }

  private async openElement(element?: TreeElement): Promise<void> {
    if (element) {
      await this.openLocation(element.type === 'label' ? element.entry.label.location : element.node.location);
    }
  }

  private async goToLabel(element?: TreeElement): Promise<void> {
    if (!element) {
      return;
    }
    if (element.type === 'label') {
      await this.openLocation(element.entry.label.location);
      return;
    }
    const labels = element.node.labels;
    let selected: StructureLabel | undefined = labels[0];
    if (labels.length > 1) {
      const item = await vscode.window.showQuickPick(await Promise.all(labels.map(async label => ({
        label: label.key, description: await this.sourceDescription(label.location), target: label
      }))), { title: 'Go to Label', placeHolder: 'Choose a label attached to this item' });
      selected = item?.target;
    }
    if (selected) {
      await this.openLocation(selected.location);
    }
  }

  private async openLocation(location: StructureLocation): Promise<void> {
    const document = await vscode.workspace.openTextDocument(location.uri);
    // Resolve the saved location after opening; edits during I/O may move it.
    const current = this.service.projectLocation(location);
    const range = new vscode.Range(document.positionAt(current.start), document.positionAt(current.end));
    const editor = await vscode.window.showTextDocument(document, { selection: range, preview: true });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private fileName(uri: vscode.Uri): string {
    return uri.path.split('/').filter(Boolean).at(-1) || uri.toString();
  }

  private sourceDescription(location: StructureLocation): string {
    return `${this.fileName(location.uri)}${this.lineSuffix(location)}`;
  }

  private lineSuffix(location: StructureLocation): string {
    const line = this.service.lineNumber(location);
    return line === undefined ? '' : `:${line}`;
  }

  dispose(): void {
    this.disposed = true;
    if (this.liveTimer) { clearTimeout(this.liveTimer); this.liveTimer = undefined; }
    this.view.dispose();
    this.changes.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
