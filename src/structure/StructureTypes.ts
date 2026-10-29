import * as vscode from 'vscode';

export type StructureKind = 'section' | 'theorem' | 'equation' | 'figure' | 'table' | 'label' | 'issue';

export interface StructureLocation {
  uri: vscode.Uri;
  start: number;
  end: number;
  /** Identifies the captured source baseline, not an editor version or save count.
   * Projected locations retain this original ID even when their offsets move. */
  sourceSnapshotId?: number;
}

export interface StructureLabel {
  key: string;
  location: StructureLocation;
}

export interface StructureNode {
  id: string;
  kind: StructureKind;
  title: string;
  /** Command name, environment name, or display-math delimiter. */
  constructName: string;
  level?: number;
  declarationRange: StructureLocation;
  /** End of the structural extent; it may lie in another included file. */
  extentEnd: StructureLocation;
  labels: StructureLabel[];
  children: StructureNode[];
}

export interface StructureLabelEntry {
  label: StructureLabel;
  node: StructureNode;
  inclusionCount: number;
  duplicate: boolean;
}

/** Hierarchy and labels assembled from individual captured file versions.
 * These may include unsaved buffers and need not share one capture time.
 * Editing uses live projections without rewriting the published hierarchy. */
export interface StructureSnapshot {
  main: vscode.Uri;
  followIncludes: boolean;
  roots: StructureNode[];
  labels: StructureLabelEntry[];
  message?: string;
}
