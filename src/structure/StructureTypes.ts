import * as vscode from 'vscode';

export type StructureKind = 'section' | 'theorem' | 'equation' | 'figure' | 'table' | 'label' | 'issue';

export interface StructureLocation {
  /** 対象ファイルのURI． */
  uri: vscode.Uri;
  /** 捕捉ソースを基準にした範囲の開始UTF-16位置．投影後は現在の文書の位置． */
  start: number;
  /** 捕捉ソースを基準にした範囲の終端UTF-16位置．この位置は含まない． */
  end: number;
  /** 文書の版や保存回数ではなく，捕捉した基準ソースを識別する．編集で位置が動いても元の識別子を保持する． */
  sourceSnapshotId?: number;
}

export interface StructureLabel {
  /** 参照または検索に使用する識別キー． */
  key: string;
  /** ラベルまたは構造宣言のソース位置． */
  location: StructureLocation;
}

export interface StructureNode {
  /** 読み込みの出現も区別する構造ノードの識別文字列． */
  id: string;
  /** 見出し，定理，数式，図，表，独立ラベル，または入力解決の問題を表す種別． */
  kind: StructureKind;
  /** 表示する題名． */
  title: string;
  /** コマンド名，環境名，またはディスプレイ数式の区切り． */
  constructName: string;
  /** 見出しの階層の深さ．値が小さい見出しほど上位に置く． */
  level?: number;
  /** 構造要素を宣言するコマンドまたは開始区切りの範囲． */
  declarationRange: StructureLocation;
  /** 構造上の範囲の終端．別の読み込み先ファイルにある場合もある． */
  extentEnd: StructureLocation;
  /** この構造要素に付属するラベルの宣言． */
  labels: StructureLabel[];
  /** ソース順に並ぶ直下の構造要素． */
  children: StructureNode[];
}

export interface StructureLabelEntry {
  /** この一覧項目が表すラベル宣言． */
  label: StructureLabel;
  /** この項目を所有する構造ノード． */
  node: StructureNode;
  /** 同じラベル宣言が読み込み経路を通して現れる回数． */
  inclusionCount: number;
  /** 同名のラベルが複数の宣言として存在する場合はtrue． */
  duplicate: boolean;
}

/** ファイルごとに捕捉した版から組み立てる階層とラベル．未保存のバッファを含む場合があり，すべてを同時刻に捕捉するとは限らない．
 * 文字編集では公開済みの階層を書き換えず，現在の位置と名前へ対応付けて表示する． */
export interface StructureSnapshot {
  /** プロジェクトのメインTeXファイルのURI． */
  main: vscode.Uri;
  /** 読み込み先のファイルも展開して構造を作成した場合はtrue． */
  followIncludes: boolean;
  /** 表示または解析階層のルート要素． */
  roots: StructureNode[];
  /** 階層全体のラベルと所有ノード，重複の情報をまとめた一覧． */
  labels: StructureLabelEntry[];
  /** 利用者へ表示するメッセージ． */
  message?: string;
}
