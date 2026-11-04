import * as vscode from 'vscode';
import StructureService from './StructureService';
import { StructureKind, StructureLabel, StructureLabelEntry, StructureLocation, StructureNode, StructureSnapshot } from './StructureTypes';
import { uriKey } from '../workspace';

export interface StructureFilterOptions {
  /** 構造ビューへ表示するノード種別の一覧． */
  visibleKinds: readonly StructureKind[];
  /** 数式をすべて表示，ラベル付きだけ表示，または非表示にする設定． */
  equations: 'all' | 'labeled' | 'hidden';
  /** ラベルを持つ構造要素だけを表示する場合はtrue． */
  labeledOnly: boolean;
}

interface StructureViewSettings extends StructureFilterOptions {
  /** 構造名の横へ付属するラベル名を表示する場合はtrue． */
  showLabels: boolean;
  /** structureは構造順，labelsはラベル名順の表示． */
  viewMode: 'structure' | 'labels';
}

const defaultKinds: StructureKind[] = ['section', 'theorem', 'figure', 'table', 'label'];

/**
 * 元の構造ノードを保持して表示用の階層を絞り込む．表示できる子孫は，非表示の親を省略して上位へ移す．
 * @param nodes 順序を保つ一覧．各要素は表示名，構造種別，元の宣言位置，ラベル，および子要素を持つノード．
 * @param options 表示する構造種別，数式の表示条件，およびラベル付きだけを表示するかの設定．
 * @returns 表示条件に合うノードの階層．親が非表示でも表示可能な子は引き上げる．
 */
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
  /** この項目がnodeであることを表す識別値． */
  type: 'node';
  /** VS Codeが展開状態を維持するための表示要素の識別子． */
  itemId: string;
  /** この項目を所有する構造ノード． */
  node: StructureNode;
  /** ソース順に並ぶ直下の構造要素． */
  children: TreeElement[];
}

interface LabelElement {
  /** この項目がlabelであることを表す識別値． */
  type: 'label';
  /** 表示項目に対応する元の解析データ． */
  entry: StructureLabelEntry;
}

type TreeElement = NodeElement | LabelElement;

interface DisplayItem {
  /** 描画済みのVS Codeツリー項目． */
  item: vscode.TreeItem;
  /** 現在のノード名を反映した表示文字列． */
  nodeTitle: string;
  /** 参照先のファイルを示す表示文字列． */
  sourceDescription: string;
  /** 行番号などの表示末尾へ加える文字列． */
  suffix: string;
  /** このファイルの表示情報を計算した更新世代． */
  epoch: number;
}

interface LabelPick extends vscode.QuickPickItem {
  /** 検索項目が対応するラベルと所有ノードの情報． */
  labelEntry: StructureLabelEntry;
}

/** プロジェクトの構造ビューと，ワークスペースごとの表示設定を管理する． */
export default class StructureView implements vscode.TreeDataProvider<TreeElement>, vscode.Disposable {
  /** 構造ビューの表示更新を通知するイベント発火元． */
  private readonly changes = new vscode.EventEmitter<TreeElement | TreeElement[] | undefined>();
  /** ツリーの再描画を要求するイベント． */
  readonly onDidChangeTreeData = this.changes.event;
  /** VS Codeへ登録した構造ツリービュー． */
  private readonly view: vscode.TreeView<TreeElement>;
  /** 終了時にまとめて解除する監視とイベント購読． */
  private readonly disposables: vscode.Disposable[] = [];
  /** 現在の表示階層の基準となる公開済み構造． */
  private structureSnapshot: StructureSnapshot | undefined;
  /** 解析または表示に適用した設定． */
  private settings: StructureViewSettings;
  /** 表示または解析階層のルート要素． */
  private roots: TreeElement[] = [];
  /** ファイルの識別キーから，そのファイルに属する表示要素への表． */
  private readonly elementsByFile = new Map<string, TreeElement[]>();
  /** ファイルごとの表示内容の更新世代． */
  private readonly fileEpochs = new Map<string, number>();
  /** 次の表示更新で再計算するファイルの識別キー． */
  private readonly pendingDisplayFiles = new Set<string>();
  /** 表示要素から描画済みのツリー項目への弱参照キャッシュ． */
  private itemCache = new WeakMap<TreeElement, DisplayItem>();
  /** 表示要素から所属ファイルの識別キーへの弱参照の表． */
  private elementFiles = new WeakMap<TreeElement, string>();
  /** 表示要素から親要素への弱参照の表． */
  private parents = new WeakMap<TreeElement, TreeElement>();
  /** 編集中の見出し表示の更新をまとめるタイマー． */
  private liveTimer?: ReturnType<typeof setTimeout>;
  /** 所有するリソースを解放し，新しい要求を受け付けない場合はtrue． */
  private disposed = false;

  /**
   * StructureViewの初期状態と所有するリソースを準備する．
   * @param context リソースの場所と拡張機能の有効期間を持つVS Codeコンテキスト．
   * @param service 関連情報の取得や更新を担当するサービス．
   * @returns 新しいインスタンス．コンストラクタから明示的な値は返さない．
   */
  constructor(/** リソースの場所と拡張機能の有効期間を持つVS Codeコンテキスト． */ private readonly context: vscode.ExtensionContext, /** 情報の取得と変更通知を担当するサービス． */ private readonly service: StructureService) {
    this.structureSnapshot = service.snapshot;
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
      service.onDidChange(structureSnapshot => {
        this.structureSnapshot = structureSnapshot;
        this.settings = this.readSettings();
        this.rebuild();
      }),
      service.onDidChangeLiveSources(uri => {
        const key = uriKey(uri);
        if (!this.elementsByFile.has(key)) { return; }
        this.fileEpochs.set(key, (this.fileEpochs.get(key) ?? 0) + 1);
        this.pendingDisplayFiles.add(key);
        this.scheduleLiveTitleRefresh();
      }),
      this.view.onDidChangeVisibility(event => {
        if (!event.visible) {
          if (this.liveTimer) { clearTimeout(this.liveTimer); this.liveTimer = undefined; }
        } else { this.refreshLiveTitles(); }
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('vscode-fortex.outline')) {
          this.settings = this.readSettings();
          this.rebuild();
        }
      })
    );
    this.rebuild();
    void service.current().then(structureSnapshot => {
      if (!this.disposed) {
        this.structureSnapshot = structureSnapshot;
        this.settings = this.readSettings();
        this.rebuild();
      }
    }, () => {
      // 探索失敗の理由は，サービスが構造スナップショットのメッセージで通知する．
    });
  }

  /**
   * 構造ビューのルートまたは指定要素の子を取得する．
   * @param element 構造ビューで操作するツリー要素．省略可能．
   * @returns 指定要素の直下に表示するツリー要素の配列．
   */
  getChildren(element?: TreeElement): TreeElement[] {
    return element?.type === 'node' ? element.children : element ? [] : this.roots;
  }

  /**
   * 構造要素の最新表示をVS Codeのツリー項目へ変換する．
   * @param element 構造ビューで操作するツリー要素．
   * @returns 名前，説明，アイコン，および移動コマンドを設定したツリー項目．
   */
  getTreeItem(element: TreeElement): vscode.TreeItem {
    const key = this.elementFiles.get(element) ?? uriKey(this.elementLocation(element).uri);
    const epoch = this.fileEpochs.get(key) ?? 0;
    const previous = this.itemCache.get(element);
    if (previous?.epoch === epoch) { return previous.item; }
    const nodeTitle = this.displayNodeTitle(element);
    if (previous) {
      previous.epoch = epoch;
      if (previous.nodeTitle === nodeTitle) { return previous.item; }
    }
    // 行番号は表示時点の値を保持する．文字位置だけが変わる編集では描画し直さず，クリック時に最新の移動先を求める．
    const suffix = previous?.suffix ?? this.lineSuffix(this.elementLocation(element));
    const sourceDescription = previous?.sourceDescription ?? `${this.fileName(this.elementLocation(element).uri)}${suffix}`;
    const item = this.makeTreeItem(element, nodeTitle, sourceDescription, suffix);
    this.itemCache.set(element, { item, nodeTitle, sourceDescription, suffix, epoch });
    return item;
  }

  /**
   * 構造要素に対応するソース位置を取得する．
   * @param element 構造ビューで操作するツリー要素．
   * @returns ラベルの位置または構造ノードの宣言位置．
   */
  private elementLocation(element: TreeElement): StructureLocation {
    return element.type === 'label' ? element.entry.label.location : element.node.declarationRange;
  }

  /**
   * 編集中の見出しを考慮して要素の表示名を求める．
   * @param element 構造ビューで操作するツリー要素．
   * @returns 現在の編集内容を反映したノード名．
   */
  private displayNodeTitle(element: TreeElement): string {
    const node = element.type === 'label' ? element.entry.node : element.node;
    if (element.type === 'label' && uriKey(node.declarationRange.uri) !== uriKey(element.entry.label.location.uri)) {
      return node.title; // 別ファイルのラベル説明は，表示全体を作り直す場合だけ更新する．
    }
    // 題名を読むだけの場合は，別の読み込み先にある見出し終端まで位置投影しない．
    return node.kind === 'section' ? this.service.projectNode(node, false).title : node.title;
  }

  /**
   * 構造要素の表示文字列と操作をツリー項目へ設定する．
   * @param element 構造ビューで操作するツリー要素．
   * @param nodeTitle 現在の見出し名を反映した表示名．
   * @param sourceDescription ファイルなどの移動先を示す説明．
   * @param suffix 確定したコマンドの後へ挿入する文字列．
   * @returns 表示用の名前・説明・状態・コマンドを持つツリー項目．
   */
  private makeTreeItem(element: TreeElement, nodeTitle: string, sourceDescription: string, suffix: string): vscode.TreeItem {
    if (element.type === 'label') {
      const { entry } = element;
      const item = new vscode.TreeItem(entry.label.key, vscode.TreeItemCollapsibleState.None);
      item.id = `label:${entry.label.location.uri.toString()}:${entry.label.location.start}:${entry.label.key}`;
      item.description = [entry.duplicate ? 'Duplicate key' : '', entry.node.kind === 'label' ? '' : nodeTitle, sourceDescription,
        entry.inclusionCount > 1 ? `${entry.inclusionCount} inclusions` : ''].filter(Boolean).join(' · ');
      item.tooltip = `${entry.label.key}\n${entry.node.kind === 'label' ? 'Standalone label' : nodeTitle}\n${entry.label.location.uri.fsPath || entry.label.location.uri.toString()}${suffix}${entry.duplicate ? '\nThis key is declared at more than one source location.' : ''}`;
      item.iconPath = new vscode.ThemeIcon(entry.duplicate ? 'warning' : 'tag');
      item.contextValue = 'fortex.structure.label';
      item.command = { command: 'vscode-fortex.outline.open', title: 'Go to Label', arguments: [element] };
      return item;
    }
    const node = element.node;
    const item = new vscode.TreeItem(nodeTitle || `\\${node.constructName}`,
      element.children.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = element.itemId;
    item.description = [
      this.settings.showLabels && node.kind !== 'label' ? node.labels.map(label => label.key).join(', ') : '',
      sourceDescription
    ].filter(Boolean).join(' · ');
    item.tooltip = [nodeTitle, node.constructName ? `\\${node.constructName}` : '',
      ...node.labels.map(label => `Label: ${label.key}`),
      `${node.declarationRange.uri.fsPath || node.declarationRange.uri.toString()}${suffix}`].filter(Boolean).join('\n');
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

  /**
   * VS Codeの展開状態を識別する値を，保存済みの文字位置や表示フィルタに依存させない．
   * 引数はない．
   * @returns 構造ノードの識別子から，展開状態を維持する表示用識別子へのMap．
   */
  private nodeItemIds(): Map<string, string> {
    const itemIds = new Map<string, string>();
    const structureSnapshot = this.structureSnapshot;
    if (!structureSnapshot) { return itemIds; }
    const occurrences = new Map<string, number>();
    const visit = (nodes: readonly StructureNode[]) => {
      for (const node of nodes) {
        const signature = JSON.stringify([uriKey(structureSnapshot.main), structureSnapshot.followIncludes,
          uriKey(node.declarationRange.uri), node.kind, node.constructName, node.title]);
        const occurrence = occurrences.get(signature) ?? 0;
        occurrences.set(signature, occurrence + 1);
        itemIds.set(node.id, `node:${signature}:${occurrence}`);
        visit(node.children);
      }
    };
    visit(structureSnapshot.roots);
    return itemIds;
  }

  /**
   * 構造スナップショットと設定から表示ツリーと検索用の索引を作り直す．
   * 引数はない．
   * @returns なし．
   */
  private rebuild(): void {
    if (this.disposed) {
      return;
    }
    if (this.liveTimer) { clearTimeout(this.liveTimer); this.liveTimer = undefined; }
    this.pendingDisplayFiles.clear();
    this.elementsByFile.clear();
    this.fileEpochs.clear();
    this.itemCache = new WeakMap();
    this.elementFiles = new WeakMap();
    this.parents = new WeakMap();
    if (this.settings.viewMode === 'labels') {
      this.roots = [...(this.structureSnapshot?.labels ?? [])]
        .sort((left, right) => left.label.key.localeCompare(right.label.key)
          || left.label.location.uri.toString().localeCompare(right.label.location.uri.toString())
          || left.label.location.start - right.label.location.start)
        .map(entry => this.registerElement({ type: 'label', entry }));
    } else {
      const itemIds = this.nodeItemIds();
      const wrap = (node: StructureNode, parent?: TreeElement): NodeElement => {
        const element: NodeElement = { type: 'node', itemId: itemIds.get(node.id)!, node, children: [] };
        this.registerElement(element, parent);
        element.children = node.children.map(child => wrap(child, element));
        return element;
      };
      this.roots = filterStructure(this.structureSnapshot?.roots ?? [], this.settings).map(node => wrap(node));
    }
    this.view.title = this.settings.viewMode === 'labels' ? 'LaTeX Structure: Labels' : 'LaTeX Structure';
    this.updateStatus();
    void vscode.commands.executeCommand('setContext', 'fortex.structure.showLabels', this.settings.showLabels);
    void vscode.commands.executeCommand('setContext', 'fortex.structure.labeledOnly', this.settings.labeledOnly);
    void vscode.commands.executeCommand('setContext', 'fortex.structure.labelMode', this.settings.viewMode === 'labels');
    this.changes.fire(undefined);
  }

  /**
   * 表示要素の親と関連ファイルを索引へ登録する．
   * @param element 構造ビューで操作するツリー要素．
   * @param parent 表示上の親要素．ルートならundefined．省略可能．
   * @returns 登録したものと同じツリー要素．
   */
  private registerElement<T extends TreeElement>(element: T, parent?: TreeElement): T {
    const key = uriKey(this.elementLocation(element).uri);
    const elements = this.elementsByFile.get(key) ?? [];
    elements.push(element);
    this.elementsByFile.set(key, elements);
    this.elementFiles.set(element, key);
    if (parent) { this.parents.set(element, parent); }
    return element;
  }

  /**
   * 編集中の見出し名や行番号を表示中のツリーへ反映する．
   * 引数はない．
   * @returns なし．
   */
  private refreshLiveTitles(): void {
    if (this.disposed || !this.view.visible) { return; }
    const files = [...this.pendingDisplayFiles];
    this.pendingDisplayFiles.clear();
    const changed = new Set<TreeElement>();
    for (const key of files) {
      for (const element of this.elementsByFile.get(key) ?? []) {
        const cached = this.itemCache.get(element);
        if (cached && this.getTreeItem(element) !== cached.item) { changed.add(element); }
      }
    }
    // VS Codeでは親の表示を更新すると，その下に表示されている子孫も更新される．
    const roots = [...changed].filter(element => {
      for (let parent = this.parents.get(element); parent; parent = this.parents.get(parent)) {
        if (changed.has(parent)) { return false; }
      }
      return true;
    });
    if (roots.length) { this.changes.fire(roots.length === 1 ? roots[0] : roots); }
  }

  /**
   * 文字入力中の描画要求をまとめる．入力が終わるまで更新を待ち続けない．
   * 引数はない．
   * @returns なし．
   */
  private scheduleLiveTitleRefresh(): void {
    if (this.disposed || !this.view.visible || this.liveTimer) { return; }
    this.liveTimer = setTimeout(() => {
      this.liveTimer = undefined;
      this.refreshLiveTitles();
    }, 100);
  }

  /**
   * 構造ビューの説明とコマンドの有効状態を現在の表示設定に合わせる．
   * 引数はない．
   * @returns なし．
   */
  private updateStatus(): void {
    this.view.description = this.structureSnapshot
      ? `${this.fileName(this.structureSnapshot.main)}${this.structureSnapshot.followIncludes ? '' : ' · Current file only'}`
      : undefined;
    this.view.message = this.structureSnapshot?.message
      || (!this.structureSnapshot ? 'Open a LaTeX document to see its structure.'
        : this.roots.length > 0 ? undefined : this.settings.viewMode === 'labels' ? 'No labels found.' : 'No structure items match the current filter.');
  }

  /**
   * 構造ビューのフィルタと表示モードを読み取る．
   * 引数はない．
   * @returns ノード種別，数式・ラベルの表示条件，および表示モード．
   */
  private readSettings(): StructureViewSettings {
    const config = vscode.workspace.getConfiguration('vscode-fortex', this.structureSnapshot?.main);
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

  /**
   * 構造ビューの設定値を適切な設定範囲へ保存する．
   * @param name 更新する構造ビュー設定のキー．
   * @param value 変換または検証する値．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
  private async updateSetting<K extends keyof StructureViewSettings>(name: K, value: StructureViewSettings[K]): Promise<void> {
    if (vscode.workspace.workspaceFolders?.length) {
      await vscode.workspace.getConfiguration('vscode-fortex').update(`outline.${name}`, value, vscode.ConfigurationTarget.Workspace);
    } else {
      await this.context.workspaceState.update(`outline.${name}`, value);
    }
    this.settings = this.readSettings();
    this.rebuild();
  }

  /**
   * 構造ビューに表示する種別と数式の条件を選択する画面を開く．
   * 引数はない．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
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
    const equationItems: (vscode.QuickPickItem & {
      /** トークンまたは解析項目が保持する値． */
      value: StructureViewSettings['equations']
    })[] = [
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

  /**
   * プロジェクトのラベルを検索して選択した宣言へ移動する．
   * 引数はない．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
  private async searchLabels(): Promise<void> {
    const structureSnapshot = await this.service.current();
    if (!structureSnapshot || structureSnapshot.labels.length === 0) {
      void vscode.window.showInformationMessage('No labels found in the current LaTeX structure.');
      return;
    }
    const items = await Promise.all([...structureSnapshot.labels].sort((left, right) => left.label.key.localeCompare(right.label.key))
      .map(async (entry): Promise<LabelPick> => ({
        label: entry.label.key,
        description: [entry.node.kind === 'label' ? '' : this.displayNodeTitle({ type: 'label', entry }), entry.duplicate ? 'Duplicate key' : ''].filter(Boolean).join(' · '),
        detail: `${await this.sourceDescription(entry.label.location)}${entry.inclusionCount > 1 ? ` · ${entry.inclusionCount} inclusions` : ''}`,
        labelEntry: entry
      })));
    const selected = await vscode.window.showQuickPick(items, {
      title: 'Go to LaTeX Label', placeHolder: 'Search all labels in the current scope', matchOnDescription: true, matchOnDetail: true
    });
    if (selected) {
      await this.openLocation(selected.labelEntry.label.location);
    }
  }

  /**
   * 選択した構造要素の宣言位置をエディタで開く．
   * @param element 構造ビューで操作するツリー要素．省略可能．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
  private async openElement(element?: TreeElement): Promise<void> {
    if (element) {
      await this.openLocation(element.type === 'label' ? element.entry.label.location : element.node.declarationRange);
    }
  }

  /**
   * 選択した要素に付いたラベルの宣言へ移動する．
   * @param element 構造ビューで操作するツリー要素．省略可能．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
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

  /**
   * 現在の編集位置を考慮してソースの参照先を開く．
   * @param location ファイルURI，半開UTF-16範囲，および基準となる捕捉ソースの識別子．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
  private async openLocation(location: StructureLocation): Promise<void> {
    const document = await vscode.workspace.openTextDocument(location.uri);
    // 文書を開く間の編集で位置が動く場合があるため，開いた後で保存していた参照先を現在の位置へ対応付ける．
    const current = this.service.projectLocation(location);
    const range = new vscode.Range(document.positionAt(current.start), document.positionAt(current.end));
    const editor = await vscode.window.showTextDocument(document, { selection: range, preview: true });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /**
   * 構造ビューに表示するファイル名を求める．
   * @param uri 対象ファイルのURI．
   * @returns URIのパスの最後の要素．取得できなければURIの文字列表現．
   */
  private fileName(uri: vscode.Uri): string {
    return uri.path.split('/').filter(Boolean).at(-1) || uri.toString();
  }

  /**
   * 構造要素のソースを示す表示文字列を作る．
   * @param location ファイルURI，半開UTF-16範囲，および基準となる捕捉ソースの識別子．
   * @returns ファイル名と，取得できる場合はコロンで区切った1始まりの行番号．
   */
  private sourceDescription(location: StructureLocation): string {
    return `${this.fileName(location.uri)}${this.lineSuffix(location)}`;
  }

  /**
   * 参照先の行番号を表示用の接尾辞へ変換する．
   * @param location ファイルURI，半開UTF-16範囲，および基準となる捕捉ソースの識別子．
   * @returns 行番号を取得できれば「:行番号」，取得できなければ空文字列．
   */
  private lineSuffix(location: StructureLocation): string {
    const line = this.service.lineNumber(location);
    return line === undefined ? '' : `:${line}`;
  }

  /**
   * 所有する監視・購読・表示などのリソースを解放する．
   * 引数はない．
   * @returns なし．
   */
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
