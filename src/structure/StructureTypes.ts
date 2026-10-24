import * as vscode from 'vscode';

export type StructureKind = 'section' | 'theorem' | 'equation' | 'figure' | 'table' | 'label' | 'issue';

export interface StructureLocation {
  uri: vscode.Uri;
  start: number;
  end: number;
}

export interface StructureLabel {
  key: string;
  location: StructureLocation;
}

export interface StructureNode {
  id: string;
  kind: StructureKind;
  title: string;
  command: string;
  level?: number;
  location: StructureLocation;
  /** End of the structural extent; it may lie in another included file. */
  end: StructureLocation;
  labels: StructureLabel[];
  children: StructureNode[];
}

export interface StructureLabelEntry {
  label: StructureLabel;
  node: StructureNode;
  occurrences: number;
  duplicate: boolean;
}

export interface StructureSnapshot {
  main: vscode.Uri;
  followIncludes: boolean;
  roots: StructureNode[];
  labels: StructureLabelEntry[];
  files: vscode.Uri[];
  message?: string;
}
