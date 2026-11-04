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
  /** 同じ不変ソースを共有するLaTeX構文解析結果． */
  syntax?: LaTeXParser.LaTeXSource;
  /** ソース順の構造イベント． */
  events?: StructureEvent[];
  /** ソースのUTF-16位置から行番号を求める索引． */
  lines?: SourceLineIndex;
}

/** 捕捉したファイル本文と識別子は固定し，派生する解析結果を必要になった時点で計算・保存する．最初の捕捉では未保存のエディタ本文を使う場合がある． */
interface SourceSnapshot {
  /** 対象ファイルのURI． */
  uri: vscode.Uri;
  /** 解析対象の元のソース本文． */
  source: string;
  /** 同じ不変ソースを共有するLaTeX構文解析結果． */
  syntax: LaTeXParser.LaTeXSource;
  /** ソース順の構造イベント． */
  events: StructureEvent[];
  /** 範囲の基準となる不変ソースの識別番号． */
  sourceSnapshotId: number;
  /** 構造宣言の間にある通常本文の半開UTF-16範囲． */
  textRanges?: {
    /** 元ソースにおける範囲の開始位置．0始まりのUTF-16単位で，この位置を含む． */
    start: number;
    /** 元ソースにおける範囲の終端．0始まりのUTF-16単位で，この位置を含まない． */
    end: number
  }[];
  /** 同じ捕捉ソースの構文・イベント・行索引の遅延解析結果． */
  analysis: SourceAnalysis;
}

/** 構造の解析結果に，依存先と公開に必要な更新可能な管理情報を加えたもの． */
interface StructureLoadResult extends StructureSnapshot {
  /** この階層の作成に実際に使った基準ソース．結果の公開が確定してから保持する． */
  sourceSnapshots: Map<string, SourceSnapshot>;
  /** 新規作成によって入力先の解決結果が変わる，存在しない候補も含む． */
  checkedCandidates: readonly {
    /** 対象ファイルのURI． */
    readonly uri: vscode.Uri;
    /** 存在確認時点で対象がファイルとして存在した場合はtrue． */
    readonly exists: boolean
  }[];
  /** 次の構造でも監視を続ける依存ファイルの識別キー． */
  neededFiles: Set<string>;
  /** 次の構造でも監視を続けるディレクトリの識別キー． */
  neededDirectories: Set<string>;
  /** メインファイルの探索に使用したディレクトリの識別キー． */
  mainFileSearchDirectoryKeys: Set<string>;
}

interface LiveHeadingTitle {
  /** キャッシュや位置情報の更新を識別する改訂番号． */
  revision: number;
  /** 表示する題名． */
  title: string;
  /** 必要な引数と閉じ区切りがそろっている場合はtrue． */
  complete: boolean;
}

interface LiveSourceState {
  /** 対象の開いている文書． */
  document: vscode.TextDocument;
  /** 読み取り時点のエディタ文書の版番号． */
  documentVersion: number;
  /** 標準の見出しツリーが初めて要求される前から，編集差分を蓄積する． */
  batches: SourceEditDelta[][];
  /** 捕捉済みのソース範囲を編集後の位置へ追従させる計算器． */
  tracker?: SourcePositionTracker;
  /** 元の開始位置をキーとする，編集中の見出し名のキャッシュ． */
  titles?: Map<number, LiveHeadingTitle>;
  /** 現在の文書版に対して計算済みの位置・表示情報． */
  projection?: {
    /** ソースを読み取った時点または投影を計算した時点の文書版番号． */
    version: number;
    /** 元の階層を保つ構造ノードの配列． */
    tree: StructureNode[];
    /** 階層を構成する構造ノードの配列． */
    nodes: StructureNode[]
  };
  /** 保存や再読み取り後に位置対応の基準を結び直す必要がある場合はtrue． */
  needsRebind?: boolean;
}

interface SourceProjection {
  /** 捕捉ソースに対応する現在のエディタ状態． */
  live: LiveSourceState;
  /** 元のアンカー開始位置から現在の範囲への読み取り専用の対応表． */
  positions: ReturnType<SourcePositionTracker['project']>;
}

/**
 * 内部のソース識別子を除き，標準のシンボルプロバイダの表示内容を比較する．
 * @param left 順序を保つ一覧．各要素は表示名，構造種別，元の宣言位置，ラベル，および子要素を持つノード．
 * @param right 順序を保つ一覧．各要素は表示名，構造種別，元の宣言位置，ラベル，および子要素を持つノード．
 * @returns 見出し名・階層・表示位置が等しい場合はtrue．
 */
function sameHeadings(left: readonly StructureNode[], right: readonly StructureNode[]): boolean {
  return left === right || (left.length === right.length && left.every((node, index) => {
    const other = right[index];
    return node.title === other.title && node.constructName === other.constructName
      && node.declarationRange.start === other.declarationRange.start && node.declarationRange.end === other.declarationRange.end
      && node.extentEnd.end === other.extentEnd.end && sameHeadings(node.children, other.children);
  }));
}

/**
 * 対象ファイルに適用される定理環境の表示名を取得する．
 * @param uri 対象ファイルのURI．
 * @returns 環境名から構造表示用の名前への対応表．
 */
function theoremSettings(uri: vscode.Uri): Record<string, string> {
  const configured = vscode.workspace.getConfiguration('vscode-fortex', uri).get<unknown>('outline.theoremEnvironments', {});
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) { return {}; }
  return Object.fromEntries(Object.entries(configured).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

/**
 * 構造イベントの間の通常本文を補い，ファイルの出現情報を付けて追加する．
 * @param sourceSnapshot URI，本文，捕捉識別子，および共有する構文・構造イベントを持つ不変ソース．
 * @param occurrence 読み込みの経路と同一ファイルの出現を識別する文字列．
 * @param append ファイルの出現情報を付けた構造イベントの追加先．
 * @returns なし．
 */
function appendEvents(sourceSnapshot: SourceSnapshot, occurrence: string, append: (entry: SourceStructureEvent) => void): void {
  if (!sourceSnapshot.textRanges) {
    const ranges: {
      /** 元ソースにおける範囲の開始位置．0始まりのUTF-16単位で，この位置を含む． */
      start: number;
      /** 元ソースにおける範囲の終端．0始まりのUTF-16単位で，この位置を含まない． */
      end: number
    }[] = [];
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

/** 捕捉した階層はソース・有効期間・設定の変化で更新する．文字入力時は表示位置と名前の追従だけを更新する． */
export default class StructureService implements vscode.Disposable {
  /** 公開した構造スナップショットの変更を配信するイベント発火元． */
  private readonly changed = new vscode.EventEmitter<StructureSnapshot | undefined>();
  /** 公開した構造スナップショットの変更イベント． */
  readonly onDidChange = this.changed.event;
  /** 保存済みソース，設定，位置の基準の変化による，明示的なシンボル更新の通知．通常の文字編集ではVS Codeが自動的にシンボルを要求する． */
  private readonly documentSymbolsChanged = new vscode.EventEmitter<vscode.Uri>();
  /** 対象ファイルの見出しシンボルを再取得すべきことを通知するイベント． */
  readonly onDidChangeDocumentSymbols = this.documentSymbolsChanged.event;
  /** 文字編集を軽量に通知する．表示中のビューを描き直すかは利用側で決める． */
  private readonly liveSourcesChanged = new vscode.EventEmitter<vscode.Uri>();
  /** 編集中の名前・位置の表示更新が必要なことを通知するイベント． */
  readonly onDidChangeLiveSources = this.liveSourcesChanged.event;
  /** 保存後のソース再読み取りの進行状態を通知するイベント発火元． */
  private readonly sourceUpdatesChanged = new vscode.EventEmitter<void>();
  /** 終了時にまとめて解除する監視とイベント購読． */
  private readonly disposables: vscode.Disposable[] = [this.changed, this.documentSymbolsChanged, this.liveSourcesChanged, this.sourceUpdatesChanged];
  /** 依存するファイルやディレクトリの監視ハンドルの対応表． */
  private readonly watches = new Map<string, vscode.Disposable>();
  /** 監視対象となっている依存ファイルの識別キー． */
  private readonly watchedFiles = new Set<string>();
  /** 入力候補の作成・削除を調べるディレクトリの識別キー． */
  private readonly candidateDirectories = new Set<string>();
  /** ファイルの識別キーから共有するソース読み取り結果への表． */
  private readonly sources = new Map<string, SourceSnapshot>();
  /** 最後に公開した階層が使用している捕捉ソースの対応表． */
  private publishedSources = new Map<string, SourceSnapshot>();
  /** ファイルごとに共有する進行中の読み取り． */
  private readonly sourceReads = new Map<string, Promise<SourceSnapshot>>();
  /** 古い読み取り結果を無視するためのファイルごとの要求世代． */
  private readonly sourceRequestGenerations = new Map<string, number>();
  /** ファイルごとに進行中の保存後の再読み取り． */
  private readonly sourceUpdates = new Map<string, Promise<void>>();
  /** 保存後の再読み取りが失敗したファイルの識別キー． */
  private readonly sourceFailures = new Set<string>();
  /** 不変ソースごとに編集追従の状態を保持する弱参照の表． */
  private liveSourceStates = new WeakMap<SourceSnapshot, LiveSourceState>();
  /** 保存済み本文と編集位置の対応をまだ調整していないファイル． */
  private readonly unreconciledSourceKeys = new Set<string>();
  /** 見出しシンボルの提供対象として記録したファイルの識別キー． */
  private readonly symbolDocumentKeys = new Set<string>();
  /** 文書ごとの捕捉ソース・設定・見出し階層のキャッシュ． */
  private readonly documentHeadingTrees = new Map<string, {
    /** この階層を作成した不変ソースのスナップショット． */
    source: SourceSnapshot;
    /** 解析または表示に適用した設定． */
    settings: string;
    /** 階層を構成する構造ノードの配列． */
    nodes: StructureNode[]
  }>();
  /** 現在の構造表示の対象として選択された文書． */
  private selected?: vscode.TextDocument;
  /** 最後に公開した構造の起点文書． */
  private publishedDocument?: vscode.TextDocument;
  /** 通常の遅延実行または一時表示を終了するタイマー． */
  private timer?: ReturnType<typeof setTimeout>;
  /** 古い非同期結果を識別して無視するための世代番号． */
  private generation = 0;
  /** 次に捕捉する不変ソースへ付ける識別番号． */
  private nextSourceSnapshotId = 0;
  /** 現在進行中のプロジェクト構造更新． */
  private pending?: Promise<void>;
  /** 直前のプロジェクト構造の更新が失敗した場合はtrue． */
  private projectRefreshFailed = false;
  /** 所有するリソースを解放し，新しい要求を受け付けない場合はtrue． */
  private disposed = false;
  /** 最後に公開した構造スナップショット． */
  private state?: StructureSnapshot;
  /**
   * 最後に公開されたプロジェクト構造を取得する．
   * 引数はない．
   * @returns 公開済みの構造スナップショット．未作成ならundefined．
   */
  get snapshot(): StructureSnapshot | undefined { return this.state; }

  /**
   * StructureServiceの初期状態と所有するリソースを準備する．
   * @param watch 文書・ファイル・設定の変更を自動監視する場合はtrue．省略時はtrue．
   * @returns 新しいインスタンス．コンストラクタから明示的な値は返さない．
   */
  constructor(/** 文書・設定・ファイルの変更を自動監視する場合はtrue． */ private readonly watch = true) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(event => {
        const key = Workspace.uriKey(event.document.uri);
        if (event.contentChanges.length === 0) {
          // VS Codeは未保存状態の変化と文字編集を別々に通知する．元に戻す操作で保存済みの本文に戻った場合，不要な再保存を要求しない．
          if (!event.document.isDirty && this.unreconciledSourceKeys.has(key)) { this.reconcileClean(event.document); }
          return;
        }
        const current = this.sources.get(key);
        const published = this.publishedSources.get(key);
        if (!current && !published) { return; }
        const sourceSnapshots = new Set([current, published]);
        let recorded = false;
        // 文字入力時にはgetText，構文解析，プロジェクト探索，ツリーの再構築を行わない．
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
            // 文書のインスタンスが切り替わった場合は，古い範囲を投影する前に本文を確認する．通常の編集では数値による位置追跡だけを使う．
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
        // 保存イベントが持つのは現在の文書で，実際に保存したバイト列ではない．このソースの基準を更新する前に，保存に成功した本文をファイルから読む．
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

  /**
   * 捕捉した階層を保ち，共有する編集中の見出し名とおおよその位置を反映する．
   * @param document 要求の対象となる編集中の文書．
   * @returns 捕捉した階層を保ち，編集中の名前と位置を反映した見出しの配列．Promiseで返す．
   */
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

  /**
   * ソースの確定時に，変更前後の階層を同じ編集版で比較できるよう同期的に処理する．
   * @param document 要求の対象となる編集中の文書．
   * @param sourceSnapshot URI，本文，捕捉識別子，および共有する構文・構造イベントを持つ不変ソース．
   * @param updateSettings 設定が変化していれば見出し階層を作り直す場合はtrue．省略時はtrue．
   * @returns 現在の文書版へ位置と見出し名を投影した見出しノードの配列．
   */
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

  /**
   * 見出し表示が変化した場合に対象文書のシンボル更新を通知する．
   * @param document 要求の対象となる編集中の文書．
   * @param before 変更前の見出しの階層．
   * @param after 変更後の見出しの階層．
   * @returns なし．
   */
  private notifyDocumentSymbolsChange(document: vscode.TextDocument, before: StructureNode[], after: StructureNode[]): void {
    if (!sameHeadings(before, after)) { this.documentSymbolsChanged.fire(document.uri); }
    else if (before[0]?.declarationRange.sourceSnapshotId === after[0]?.declarationRange.sourceSnapshotId) {
      // 内容が変わらない保存では，同じ不変の位置投影とシンボル変換結果を保持する．
      const sourceSnapshot = this.sources.get(Workspace.uriKey(document.uri));
      const live = sourceSnapshot && this.liveSourceStates.get(sourceSnapshot);
      if (live?.projection) { live.projection.nodes = before; }
    }
  }

  /**
   * 構造ノードの階層から見出しだけを取り出す．
   * @param nodes 順序を保つ一覧．各要素は表示名，構造種別，元の宣言位置，ラベル，および子要素を持つノード．
   * @returns 見出しだけを保持する構造の配列．
   */
  private onlyHeadings(nodes: readonly StructureNode[]): StructureNode[] {
    return nodes.flatMap(node => {
      const children = this.onlyHeadings(node.children);
      return node.kind === 'section' ? [{ ...node, children }] : children;
    });
  }

  /**
   * 捕捉済み見出しの位置と名前を現在の文書へ追従させる．
   * @param nodes 順序を保つ一覧．各要素は表示名，構造種別，元の宣言位置，ラベル，および子要素を持つノード．
   * @param sourceSnapshot URI，本文，捕捉識別子，および共有する構文・構造イベントを持つ不変ソース．
   * @param document 要求の対象となる編集中の文書．
   * @param projection 現在のエディタ状態と，元のアンカーから編集後の位置への対応表．
   * @returns 現在の編集内容に合わせた見出しノードの配列．
   */
  private projectHeadings(nodes: readonly StructureNode[], sourceSnapshot: SourceSnapshot,
    document: vscode.TextDocument, projection: SourceProjection): StructureNode[] {
    return nodes.map(node => ({ ...this.projectSourceNode(node, sourceSnapshot, document, projection),
      children: this.projectHeadings(node.children, sourceSnapshot, document, projection) }));
  }

  /**
   * 捕捉ソースごとに1つの位置対応を計算し，現在文書とプロジェクトの両方の表示で共有する．
   * @param sourceSnapshot URI，本文，捕捉識別子，および共有する構文・構造イベントを持つ不変ソース．
   * @param document 要求の対象となる編集中の文書．
   * @returns 捕捉したソースと現在の文書を結ぶ編集状態および位置の対応表．
   */
  private ensureLiveSourceProjection(sourceSnapshot: SourceSnapshot, document: vscode.TextDocument): SourceProjection {
    let live = this.liveSourceStates.get(sourceSnapshot);
    if (!live || live.document !== document || live.needsRebind || live.documentVersion !== document.version) {
      live = this.bindLive(sourceSnapshot, document, document.getText());
    }
    if (!live.tracker) {
      // 構造イベントは捕捉済みソースの解析結果に含まれる．その両端も追跡し，ラベルや別ファイルにまたがる見出しの終端も編集に追従させる．
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

  /**
   * 投影済みの位置ではなく，最初に捕捉した位置を現在の文書へ対応付ける．結果は元の基準識別子を保持し，基準がなければ位置を変えない．
   * @param location ファイルURI，半開UTF-16範囲，および基準となる捕捉ソースの識別子．
   * @returns 元の捕捉識別子を保持し，現在の編集位置へ変換した参照先．
   */
  projectLocation(location: StructureLocation): StructureLocation {
    const sourceSnapshot = this.sourceSnapshotFor(location);
    const document = Workspace.findOpenDocument(location.uri);
    if (this.disposed || !sourceSnapshot || !document) { return location; }
    const { positions } = this.ensureLiveSourceProjection(sourceSnapshot, document);
    return this.mapLocation(location, positions);
  }

  /**
   * 新しい階層が公開されるまでは，以前のプロジェクトノードも編集に追従させる．
   * @param location ファイルURI，半開UTF-16範囲，および基準となる捕捉ソースの識別子．
   * @returns 参照先の基準となったソース．基準を保持していなければundefined．
   */
  private sourceSnapshotFor(location: StructureLocation): SourceSnapshot | undefined {
    const key = Workspace.uriKey(location.uri);
    const current = this.sources.get(key);
    if (current?.sourceSnapshotId === location.sourceSnapshotId) { return current; }
    const published = this.publishedSources.get(key);
    return published?.sourceSnapshotId === location.sourceSnapshotId ? published : undefined;
  }

  /**
   * アンカーの対応表を使ってソース範囲を移動する．
   * @param location ファイルURI，半開UTF-16範囲，および基準となる捕捉ソースの識別子．
   * @param positions 元のアンカー開始位置から現在の範囲への対応表．
   * @returns 現在の開始・終了位置を反映した構造の参照先．
   */
  private mapLocation(location: StructureLocation, positions: SourceProjection['positions']): StructureLocation {
    const mapped = positions.get(location.start);
    const start = mapped?.start ?? location.start;
    const end = location.end === location.start ? start
      : mapped?.end ?? positions.get(location.end)?.start ?? location.end;
    return { ...location, start, end: Math.max(start, end) };
  }

  /**
   * 宣言が不完全または削除済みでも，元のノードの識別子と階層を保って編集後の位置へ対応付ける．入力には捕捉時のノードを渡す．戻り値の位置も元の基準識別子を保持する．
   * @param node 表示名，構造種別，元の宣言位置，ラベル，および子要素を持つノード．
   * @param projectExtentEnd ノードの構造上の終端も現在の文書位置へ変換する場合はtrue．省略時はtrue．
   * @returns 識別子と階層を保ち，現在の位置と見出し名を反映したノード．
   */
  projectNode(node: StructureNode, projectExtentEnd = true): StructureNode {
    const sourceSnapshot = this.sourceSnapshotFor(node.declarationRange);
    const document = Workspace.findOpenDocument(node.declarationRange.uri);
    if (this.disposed || !sourceSnapshot || !document) {
      return { ...node, extentEnd: projectExtentEnd ? this.projectLocation(node.extentEnd) : node.extentEnd };
    }
    return this.projectSourceNode(node, sourceSnapshot, document, this.ensureLiveSourceProjection(sourceSnapshot, document), projectExtentEnd);
  }

  /**
   * 指定した捕捉ソースに属するノードの表示名と位置を現在の文書へ合わせる．
   * @param node 表示名，構造種別，元の宣言位置，ラベル，および子要素を持つノード．
   * @param sourceSnapshot URI，本文，捕捉識別子，および共有する構文・構造イベントを持つ不変ソース．
   * @param document 要求の対象となる編集中の文書．
   * @param { live, positions } 対象文書に対する編集と投影の状態． 元のアンカー開始位置から現在の範囲への対応表．
   * @param projectExtentEnd ノードの構造上の終端も現在の文書位置へ変換する場合はtrue．省略時はtrue．
   * @returns 位置と，必要に応じて見出し名を更新したノード．
   */
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
      // 引数が未完了でも，コマンドの開始位置を移動先として使える．削除されたコマンドにもおおよその移動先を保持する．
      projected.declarationRange.end = projected.declarationRange.start + node.constructName.length + 1;
    }
    return projected;
  }

  /**
   * 編集中の見出し宣言をアンカーの改訂単位で読み直す．
   * @param node 表示名，構造種別，元の宣言位置，ラベル，および子要素を持つノード．
   * @param document 要求の対象となる編集中の文書．
   * @param live 対象文書に対する編集と投影の状態．
   * @param position 編集後のアンカー範囲と，範囲が変更されたリビジョン．
   * @returns 現在の見出し名，宣言の完全性，および読み取ったリビジョン．
   */
  private liveHeadingTitle(node: StructureNode, document: vscode.TextDocument, live: LiveSourceState,
    position: MappedSourceAnchor): LiveHeadingTitle {
    live.titles ??= new Map();
    let title = live.titles.get(node.declarationRange.start);
    if (!title) {
      title = { revision: 0, title: node.title, complete: true };
      live.titles.set(node.declarationRange.start, title);
    }
    if (title.revision !== position.revision) {
      // 極端に大きい宣言や不完全な宣言の貼り付けに対し，解析量を制限する．文書全体に相当する範囲を走査せず，最後に読めた名前を保持する．
      const fragment = position.end - position.start <= 16_384
        ? document.getText(new vscode.Range(document.positionAt(position.start), document.positionAt(position.end))) : undefined;
      let updated = fragment === undefined ? undefined : readHeadingTitle(fragment, node.constructName);
      if (updated === undefined && fragment !== undefined && fragment.length < 16_384) {
        // 削除した閉じ波括弧を再挿入すると，保存済み宣言の移動しない終端の直後に位置する．後続の本文まで読まず，1文字だけ追加で確認する．
        const suffix = document.getText(new vscode.Range(document.positionAt(position.end), document.positionAt(position.end + 1)));
        if (suffix === '}') { updated = readHeadingTitle(fragment + suffix, node.constructName); }
      }
      title = { revision: position.revision, title: updated === undefined ? title.title : updated || `\\${node.constructName}`,
        complete: updated !== undefined };
      live.titles.set(node.declarationRange.start, title);
    }
    return title;
  }

  /**
   * 説明の表示に伴って文書を新しく開くことはしない．
   * @param location ファイルURI，半開UTF-16範囲，および基準となる捕捉ソースの識別子．
   * @returns 参照先の1始まりの行番号．使用できるソースがなければundefined．
   */
  lineNumber(location: StructureLocation): number | undefined {
    const document = Workspace.findOpenDocument(location.uri);
    if (document) { return document.positionAt(this.projectLocation(location).start).line + 1; }
    const sourceSnapshot = this.sourceSnapshotFor(location);
    if (!sourceSnapshot) { return undefined; }
    const analysis = sourceSnapshot.analysis;
    const lines = analysis.lines ??= new SourceLineIndex(sourceSnapshot.source);
    return lines.lineNumberAt(location.start);
  }

  /**
   * ファイルが現在の構造または見出し表示に関係するかを調べる．
   * @param uri 対象ファイルのURI．
   * @returns 再読み取りや表示更新が必要なファイルであればtrue．
   */
  private relevant(uri: vscode.Uri): boolean {
    const key = Workspace.uriKey(uri);
    return this.sources.has(key) || this.watchedFiles.has(key)
      || (uri.scheme === 'file' && path.extname(uri.path).toLowerCase() === '.tex'
        && this.candidateDirectories.has(Workspace.uriKey(vscode.Uri.joinPath(uri, '..'))));
  }

  /**
   * 保存済みの文書と捕捉ソースの位置対応を再調整する．
   * @param document 要求の対象となる編集中の文書．
   * @returns なし．
   */
  private reconcileClean(document: vscode.TextDocument): void {
    const key = Workspace.uriKey(document.uri);
    const sourceSnapshot = this.sources.get(key);
    if (!sourceSnapshot || document.isClosed) { return; }
    const source = document.getText();
    if (source !== sourceSnapshot.source) {
      // 保存通知では変更なしとされても，それより新しいバッファが未保存の場合がある．異なる捕捉済みの基準を置き換える際は，確認済みのディスク本文だけを使う．
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

  /**
   * 連続する構造更新要求をまとめて遅延実行する．
   * 引数はない．
   * @returns なし．
   */
  private schedule(): void {
    if (this.disposed) { return; }
    this.generation++;
    if (this.timer) { clearTimeout(this.timer); }
    // ここで扱うのは，保存，ファイルシステムや文書の有効期間の変化，意味上の構造に関わる設定変更だけ．
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, 0);
  }

  /**
   * 現在の文書のプロジェクト構造を再取得して公開する．
   * @param document 要求の対象となる編集中の文書．省略可能．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
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
      // 入力先の探索直後から監視登録までの間に候補が作成される場合がある．監視が始まってから存在状態を再確認する．
      const changed = await Promise.all(loadResult.checkedCandidates.map(async candidate => {
        try {
          const stat = await vscode.workspace.fs.stat(candidate.uri);
          return ((stat.type & vscode.FileType.File) !== 0) !== candidate.exists;
        } catch (error) {
          if ((error as {
            /** FileNotFoundなど，失敗の種類を識別するエラーコード． */
            code?: string
          }).code !== 'FileNotFound') { throw error; }
          return candidate.exists;
        }
      }));
      if (this.disposed || generation !== this.generation) { return; }
      if (changed.some(Boolean)) { this.schedule(); return; }
      // 非同期の存在確認を待つ間に，標準アウトラインの要求によって別の開いた文書が追加される場合がある．
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

  /**
   * 現在文書の構造を必要に応じて更新して取得する．
   * 引数はない．
   * @returns 現在の構造スナップショット．対象文書がなければundefined．Promiseで返す．
   */
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

  /**
   * ソース本文を不変の解析用スナップショットとして記憶する．
   * @param uri 対象ファイルのURI．
   * @param source 解析または読み取りの対象となるソース本文．
   * @returns 本文，識別子，および遅延評価する構文・イベントを持つ捕捉ソース．
   */
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
      /**
       * 捕捉したソースの構文を遅延解析して取得する．
       * 引数はない．
       * @returns 同じ不変本文から作った共有LaTeX構文解析結果．
       */
      get syntax() { return analysis.syntax ??= new LaTeXParser.LaTeXSource(source); },
      /**
       * 捕捉したソースの構造イベントを遅延解析して取得する．
       * 引数はない．
       * @returns 同じ不変本文の出現順の構造イベント．
       */
      get events() { return analysis.events ??= parseStructureEvents(this.syntax); } };
    this.sources.set(key, sourceSnapshot);
    this.documentHeadingTrees.delete(key);
    this.unreconciledSourceKeys.delete(key);
    return sourceSnapshot;
  }

  /**
   * 開いている文書の現在の本文を捕捉する．
   * @param document 要求の対象となる編集中の文書．
   * @returns その文書版の本文に対応するソーススナップショット．
   */
  private capture(document: vscode.TextDocument): SourceSnapshot {
    const key = Workspace.uriKey(document.uri);
    this.sourceRequestGenerations.set(key, (this.sourceRequestGenerations.get(key) ?? 0) + 1);
    const source = document.getText();
    const sourceSnapshot = this.remember(document.uri, source);
    this.bindLive(sourceSnapshot, document, source);
    return sourceSnapshot;
  }

  /**
   * 捕捉したソースと編集中の文書を編集差分によって結び付ける．
   * @param sourceSnapshot URI，本文，捕捉識別子，および共有する構文・構造イベントを持つ不変ソース．
   * @param document 要求の対象となる編集中の文書．
   * @param liveSource 捕捉した時点のエディタ本文．
   * @returns 対象文書，版番号，編集差分，および投影用の状態．
   */
  private bindLive(sourceSnapshot: SourceSnapshot, document: vscode.TextDocument, liveSource: string): LiveSourceState {
    const key = Workspace.uriKey(sourceSnapshot.uri);
    const edits = sourceTextChanges(sourceSnapshot.source, liveSource);
    const live: LiveSourceState = { document, documentVersion: document.version,
      batches: edits.length ? [edits] : [] };
    this.liveSourceStates.set(sourceSnapshot, live);
    // 保持中のプロジェクトの基準本文が保存済み本文と異なる場合がある．その位置投影によって，最新のソースを再調整が必要な状態へ戻さない．
    if (this.sources.get(key) === sourceSnapshot) {
      if (sourceSnapshot.source === liveSource) { this.unreconciledSourceKeys.delete(key); }
      else { this.unreconciledSourceKeys.add(key); }
    }
    return live;
  }

  /**
   * 指定ファイルまたは全ファイルの保存後の再読み取り完了を待つ．
   * @param key 検索または設定の項目を識別するキー．省略可能．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
  private async waitForSourceUpdates(key?: string): Promise<void> {
    while (!this.disposed) {
      let subscription: vscode.Disposable | undefined;
      const changed = new Promise<void>(resolve => { subscription = this.sourceUpdatesChanged.event(() => resolve()); });
      try {
        const requests = key ? [this.sourceUpdates.get(key)].filter((value): value is Promise<void> => value !== undefined)
          : [...this.sourceUpdates.values()];
        if (!requests.length) { return; }
        // 新しい保存は，止まっている古い読み取りを置き換えられる．待機側は古い読み取りに留まらず，最新のソース要求の完了を待つ．
        await Promise.race([Promise.all(requests), changed]);
      } finally { subscription?.dispose(); }
    }
  }

  /**
   * 保存済みのバイト列を読み，途中に別の非同期処理を挟まず1つの編集版へ対応付ける．
   * @param uri 対象ファイルのURI．
   * @param expectedDocument 保存時点の対象文書．省略可能．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
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
      // 現在の本文の捕捉，位置対応の作成，新しいソースの登録の間にはawaitを挟まない．その後の編集イベントは新しい差分履歴へ加える．
      const liveSource = document?.getText();
      const previous = this.sources.get(key);
      const changed = previous?.source !== source;
      const before = previous && document && this.symbolDocumentKeys.has(key) ? this.projectDocumentHeadings(document, previous) : undefined;
      const live = previous && this.liveSourceStates.get(previous);
      if (document && source === previous?.source && liveSource !== source
        && live?.document === document && live.documentVersion === document.version && !live.needsRebind) {
        // 本文が変わっていないディスク通知で，正確な編集履歴を曖昧な大きな範囲の差分計算に置き換えない．
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
      // 保存通知とファイル監視通知が同じ本文を示す場合がある．位置対応は更新するが，プロジェクト探索と階層の組み立ては繰り返さない．
      if (this.selected && (changed || recovered || this.projectRefreshFailed)) { this.schedule(); }
    })().catch(error => {
      if (!current()) { return; }
      // 失敗した場合は，以前の階層と数値による位置投影の両方を保持する．
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

  /**
   * 指定ファイルの解析・位置対応を無効にする．
   * @param key 検索または設定の項目を識別するキー．
   * @returns なし．
   */
  private invalidateSource(key: string): void {
    this.sourceRequestGenerations.set(key, (this.sourceRequestGenerations.get(key) ?? 0) + 1);
    this.sources.delete(key);
    this.sourceFailures.delete(key);
    this.documentHeadingTrees.delete(key);
    this.unreconciledSourceKeys.delete(key);
    if (this.sourceUpdates.delete(key)) { this.sourceUpdatesChanged.fire(); }
  }

  /**
   * ファイルの捕捉ソースを取得し，同じファイルの読み取りを共有する．
   * @param uri 対象ファイルのURI．
   * @param preferOpenBufferOnFirstRead 初回の読み取りで未保存のエディタ本文を優先する場合はtrue．省略時はtrue．
   * @returns 元の本文と解析情報を保持する不変のソーススナップショット．Promiseで返す．
   */
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
          // ファイルの読み取り中に文書が開かれた場合は，最初のアウトライン用の本文を捕捉する．
          const opened = Workspace.findOpenDocument(uri);
          if (opened && preferOpenBufferOnFirstRead) { return this.capture(opened); }
          const sourceSnapshot = this.remember(uri, source);
          // 保存を契機に未取得の未保存文書を依存先として見つけた場合は，その文書の編集内容を取り込まず，ディスク上の本文を基準にする．
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

  /**
   * 関連ファイルの更新や入力候補の作成・削除をディレクトリ単位で監視する．
   * @param directory 処理の基準となるディレクトリ．
   * @param candidate 入力候補の存在状態を調べる監視であればtrue．
   * @returns なし．
   */
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
      // ファイルの作成・削除はメインや入力先の選択を変える．読み込み先の削除などで以前のソースを読めなくなった場合も再探索する．
      if (existence) { this.schedule(); }
    };
    this.watches.set(key, vscode.Disposable.from(watcher,
      watcher.onDidChange(uri => changed(uri)), watcher.onDidCreate(uri => changed(uri, true)),
      watcher.onDidDelete(uri => changed(uri, true))));
  }

  /**
   * 依存ファイルを一覧へ記録し，その親ディレクトリの監視を確保する．
   * @param uri 対象ファイルのURI．
   * @param dependencies 要求が参照した依存ファイルを登録する集合または対応表．
   * @returns なし．
   */
  private dependency(uri: vscode.Uri, dependencies: Map<string, vscode.Uri>): void {
    if (this.disposed) { throw new vscode.CancellationError(); }
    const key = Workspace.uriKey(uri);
    dependencies.set(key, uri);
    this.watchedFiles.add(key);
    this.watchDirectory(vscode.Uri.joinPath(uri, '..'));
  }

  /**
   * メインファイルから読み込み先を展開してプロジェクト構造を組み立てる．
   * @param document 要求の対象となる編集中の文書．
   * @param generation 新しい要求との競合を検出する世代番号．
   * @returns 構造スナップショットと，使用した捕捉ソース・候補・監視先の情報．Promiseで返す．
   */
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
    const checkedCandidates: {
      /** 対象ファイルのURI． */
      readonly uri: vscode.Uri;
      /** 存在確認時点で対象がファイルとして存在した場合はtrue． */
      readonly exists: boolean
    }[] = [];
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
        if ((error as {
          /** FileNotFoundなど，失敗の種類を識別するエラーコード． */
          code?: string
        }).code !== 'FileNotFound') { throw error; }
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
        // 厳密なアウトライン展開では，ファイル名のマクロを展開しない．
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
    // 監視の所有範囲は公開済みの構造に合わせる．現在文書のアウトライン用の捕捉ソースは，プロジェクトの階層とは独立して，文書が開いている間保持する．
    const neededFiles = new Set([...dependencies.keys(), ...this.symbolDocumentKeys]);
    const neededDirectories = new Set(mainFileSearchDirectoryKeys);
    for (const uri of dependencies.values()) { neededDirectories.add(Workspace.uriKey(vscode.Uri.joinPath(uri, '..'))); }
    for (const key of this.symbolDocumentKeys) {
      const source = this.sources.get(key);
      if (source) { neededDirectories.add(Workspace.uriKey(vscode.Uri.joinPath(source.uri, '..'))); }
    }
    // 古い要求では後始末を行わず，結果を公開する要求が確定してから実施する．
    return { main, followIncludes, roots, labels: labelEntries(roots),
      sourceSnapshots, checkedCandidates, message,
      neededFiles, neededDirectories, mainFileSearchDirectoryKeys };
  }

  /**
   * 所有する監視・購読・表示などのリソースを解放する．
   * 引数はない．
   * @returns なし．
   */
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
