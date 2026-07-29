import * as vscode from 'vscode';

/** A normalized bibliography entry ready for display and searching. */
export interface CitationEntry {
  key: string;
  type: string;
  author: string;
  title: string;
  year?: string;
  sourceUri: vscode.Uri;
}

/** The subset of a BibTeX entry produced by the lightweight parser. */
export interface ParsedBibEntry {
  key: string;
  type: string;
  fields: Readonly<Record<string, string>>;
}

/** The active comma-separated key fragment inside a cite-like command. */
export interface CitationContext {
  query: string;
  queryStart: number;
}
