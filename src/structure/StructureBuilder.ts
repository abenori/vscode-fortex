import type * as vscode from 'vscode';
import { structurePlainText, StructureEvent } from './LaTeXStructureParser';
import { StructureKind, StructureLabelEntry, StructureLocation, StructureNode } from './StructureTypes';
import { uriKey } from '../workspace';

/** 読み込み先を展開した構造の組み立てに使う，捕捉済みソースの情報． */
interface StructureSource {
  /** 対象ファイルのURI． */
  uri: vscode.Uri;
  /** 解析対象の元のソース本文． */
  source: string;
  /** 範囲の基準となる不変ソースの識別番号． */
  sourceSnapshotId?: number;
}

export interface SourceStructureEvent {
  /** 範囲と解析の基準となる捕捉済みの不変ソース． */
  sourceSnapshot: StructureSource;
  /** 読み込み経路を含めて，このファイルの出現を識別する文字列． */
  occurrence: string;
  /** 元ソース中の構造イベントまたは通常本文・問題のイベント． */
  event: StructureEvent | {
    /** この項目がtextであることを表す識別値． */
    type: 'text';
    /** 元ソースにおける範囲の開始位置．0始まりのUTF-16単位で，この位置を含む． */
    start: number;
    /** 元ソースにおける範囲の終端．0始まりのUTF-16単位で，この位置を含まない． */
    end: number
  } | {
    /** この項目がissueであることを表す識別値． */
    type: 'issue';
    /** 表示する題名． */
    title: string;
    /** 元ソースにおける範囲の開始位置．0始まりのUTF-16単位で，この位置を含む． */
    start: number;
    /** 元ソースにおける範囲の終端．0始まりのUTF-16単位で，この位置を含まない． */
    end: number
  };
}

const equationEnvironments = new Set(['equation', 'equation*', 'align', 'align*', 'alignat', 'alignat*',
  'gather', 'gather*', 'multline', 'multline*', 'flalign', 'flalign*', 'displaymath', '\\[', '$$']);
const defaultTheorems: Record<string, string> = {
  theorem: 'Theorem', lemma: 'Lemma', proposition: 'Proposition', corollary: 'Corollary',
  definition: 'Definition', remark: 'Remark', example: 'Example', conjecture: 'Conjecture'
};

/**
 * 捕捉したソースの位置から構造の参照先を作る．
 * @param sourceSnapshot 解析の基準となる，捕捉済みの不変ソース．
 * @param start 対象範囲の開始位置．UTF-16単位で，範囲に含む．
 * @param end 対象範囲の終端位置．UTF-16単位で，範囲に含まない．省略時はstart．
 * @returns ファイルURI，半開UTF-16範囲，および捕捉元の識別子．
 */
function location(sourceSnapshot: StructureSource, start: number, end = start): StructureLocation {
  return { uri: sourceSnapshot.uri, start, end, sourceSnapshotId: sourceSnapshot.sourceSnapshotId };
}

/**
 * 読み込み先を展開してから意味上の所属を決め，同じファイルの各出現を区別して保持する．
 * @param events 順序を保つ一覧．各要素は捕捉ソースと読み込みの出現識別子を付けた構造イベント．
 * @param configuredTheorems 定理環境名から表示名への設定．
 * @returns 読み込み先も展開した，ラベルと子要素を持つ構造ノードの階層．
 */
export function buildStructure(events: SourceStructureEvent[], configuredTheorems: Record<string, string>): StructureNode[] {
  const theoremNames = { ...defaultTheorems, ...configuredTheorems };
  for (const { event } of events) {
    if (event.type === 'theoremDefinition') { theoremNames[event.name] = event.title; }
  }
  const roots: StructureNode[] = [];
  const sections: StructureNode[] = [];
  const environments: {
    /** 対象の名前． */
    name: string;
    /** この項目を所有する構造ノード． */
    node?: StructureNode;
    /** 範囲と解析の基準となる捕捉済みの不変ソース． */
    sourceSnapshot: StructureSource;
    /** 区切り記号を除く本文の開始位置．元ソースのUTF-16単位． */
    contentStart: number
  }[] = [];
  let pendingHeading: StructureNode | undefined;
  const environmentOwner = () => [...environments].reverse().find(entry => entry.node)?.node;
  const add = (node: StructureNode) => (environmentOwner()?.children ?? sections.at(-1)?.children ?? roots).push(node);
  const make = (entry: SourceStructureEvent, kind: StructureKind, title: string, constructName: string): StructureNode => ({
    id: `${entry.occurrence}:${entry.event.start}:${kind}`,
    kind, title, constructName,
    declarationRange: location(entry.sourceSnapshot, entry.event.start, entry.event.end),
    extentEnd: location(entry.sourceSnapshot, entry.sourceSnapshot.source.length),
    labels: [], children: []
  });

  for (const entry of events) {
    const { event, sourceSnapshot } = entry;
    if (event.type === 'text') { pendingHeading = undefined; continue; }
    if (event.type === 'heading') {
      while (sections.length && sections.at(-1)!.level! >= event.level) {
        sections.pop()!.extentEnd = location(sourceSnapshot, event.start);
      }
      const node = make(entry, 'section', event.title || `\\${event.command}`, event.command);
      node.level = event.level;
      add(node);
      sections.push(node);
      pendingHeading = node;
      continue;
    }
    if (event.type === 'label') {
      const label = { key: event.key, location: location(sourceSnapshot, event.start, event.end) };
      const owner = environmentOwner() ?? pendingHeading;
      if (owner) { owner.labels.push(label); }
      else {
        const node = make(entry, 'label', event.key, 'label');
        node.extentEnd = node.declarationRange;
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
      environments.push({ name: event.name, node, sourceSnapshot, contentStart: event.end });
    } else if (event.type === 'end') {
      let index = environments.length - 1;
      while (index >= 0 && environments[index].name !== event.name) { index--; }
      if (index < 0) { continue; }
      for (const env of environments.splice(index)) {
        if (!env.node) { continue; }
        env.node.extentEnd = location(sourceSnapshot, event.end);
        if (env.node.kind === 'equation' && uriKey(env.sourceSnapshot.uri) === uriKey(sourceSnapshot.uri)) {
          const content = sourceSnapshot.source.slice(env.contentStart, event.start);
          env.node.title = structurePlainText(content, { omitEnvironmentCommands: true }).slice(0, 100) || env.name;
        }
      }
    } else if (event.type === 'caption') {
      const owner = [...environments].reverse().find(env => env.node?.kind === 'figure' || env.node?.kind === 'table')?.node;
      if (owner && (owner.title === 'Figure' || owner.title === 'Table')) { owner.title = event.title || owner.title; }
    } else if (event.type === 'issue') {
      const node = make(entry, 'issue', event.title, 'input');
      node.extentEnd = node.declarationRange;
      add(node);
    }
  }
  const last = events.at(-1);
  if (last) {
    for (const node of sections) { node.extentEnd = location(last.sourceSnapshot, last.sourceSnapshot.source.length); }
  }
  return roots;
}

/**
 * 構造の階層をたどり，各ラベルと所有ノードの対応を集める．
 * @param roots 順序を保つ一覧．各要素は表示名，構造種別，元の宣言位置，ラベル，および子要素を持つノード．
 * @returns 同一名の重複と読み込み回数の情報を含むラベル一覧．
 */
export function labelEntries(roots: StructureNode[]): StructureLabelEntry[] {
  const declarations = new Map<string, StructureLabelEntry>();
  const keys = new Map<string, Set<string>>();
  const visit = (nodes: StructureNode[]) => {
    for (const node of nodes) {
      for (const label of node.labels) {
        const id = `${uriKey(label.location.uri)}:${label.location.start}`;
        const existing = declarations.get(id);
        if (existing) { existing.inclusionCount++; }
        else { declarations.set(id, { label, node, inclusionCount: 1, duplicate: false }); }
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
