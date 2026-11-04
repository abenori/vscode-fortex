import * as vscode from 'vscode';

/** 表示と検索に使用できるよう正規化した文献情報． */
export interface CitationEntry {
  /** 参照または検索に使用する識別キー． */
  key: string;
  /** articleやbookなど，元のBibTeXエントリの種別． */
  type: string;
  /** BibTeXから読み取った著者の表記． */
  author: string;
  /** 表示する題名． */
  title: string;
  /** 出版年．yearフィールドがなければ未設定． */
  year?: string;
  /** この項目を読み取った元ファイルのURI． */
  sourceUri: vscode.Uri;
}

/** 簡易パーサで抽出するBibTeXエントリの情報． */
export interface ParsedBibEntry {
  /** 参照または検索に使用する識別キー． */
  key: string;
  /** 小文字で表したBibTeXエントリの種別． */
  type: string;
  /** 小文字に正規化したフィールド名から，展開済みの文字列値への表． */
  fields: Readonly<Record<string, string>>;
}

/** 引用コマンドのカンマ区切りの引数で，現在入力しているキーの部分． */
export interface CitationContext {
  /** 入力中の検索文字列． */
  query: string;
  /** 検索文字列の先頭のUTF-16位置． */
  queryStart: number;
}
