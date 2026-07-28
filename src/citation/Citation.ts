import * as vscode from 'vscode';

export interface CitationEntry {
  key: string;
  type: string;
  author: string;
  title: string;
  year?: string;
  sourceUri: vscode.Uri;
}

export interface ParsedBibEntry {
  key: string;
  type: string;
  fields: Readonly<Record<string, string>>;
}

export interface CitationContext {
  query: string;
  queryStart: number;
}

