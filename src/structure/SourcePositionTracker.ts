/** Offsets and lengths use VS Code's UTF-16 document coordinates. */
export interface SourceEditDelta {
  offset: number;
  length: number;
  insertedLength: number;
}

export interface SourceAnchor {
  start: number;
  end: number;
}

export interface MappedSourceAnchor extends SourceAnchor {
  /** Advances when an edit touches the anchor range or inserts at its end. */
  revision: number;
}

/** Tracks captured source anchors without reading text or reparsing on input. */
export default class SourcePositionTracker {
  private readonly anchors = new Map<number, MappedSourceAnchor>();
  private readonly pending: SourceEditDelta[][] = [];
  private projection?: ReadonlyMap<number, MappedSourceAnchor>;

  constructor(anchors: readonly SourceAnchor[]) {
    for (const anchor of anchors) {
      this.anchors.set(anchor.start, { start: anchor.start, end: anchor.end, revision: 0 });
    }
  }

  /** One batch uses offsets from before that TextDocumentChangeEvent. */
  record(changes: readonly SourceEditDelta[]): void {
    const batch = changes.filter(change => change.length !== 0 || change.insertedLength !== 0)
      .map(change => ({ offset: change.offset, length: change.length, insertedLength: change.insertedLength }))
      .sort((left, right) => right.offset - left.offset);
    if (batch.length) { this.pending.push(batch); }
  }

  /** Applies only new batches; previously returned maps and values stay fixed. */
  project(): ReadonlyMap<number, MappedSourceAnchor> {
    if (this.projection && this.pending.length === 0) { return this.projection; }
    for (const batch of this.pending) {
      for (const change of batch) {
        const removedEnd = change.offset + change.length;
        for (const anchor of this.anchors.values()) {
          const removalOverlaps = change.length > 0 && change.offset < anchor.end && removedEnd > anchor.start;
          const insertionInside = change.insertedLength > 0 && anchor.start < change.offset && change.offset < anchor.end;
          // Record boundary edits without moving the left-affine end. A consumer
          // may need to reread a declaration completed by an inserted delimiter.
          const insertionAtEnd = change.insertedLength > 0 && anchor.start < anchor.end && change.offset === anchor.end;
          if (removalOverlaps || insertionInside || insertionAtEnd) {
            anchor.revision++;
          }
          const start = mapPosition(anchor.start, change, true);
          const end = Math.max(start, mapPosition(anchor.end, change, false));
          anchor.start = start;
          anchor.end = end;
        }
      }
    }
    this.pending.length = 0;
    this.projection = new Map([...this.anchors].map(([key, anchor]) => [key, Object.freeze({ ...anchor })]));
    return this.projection;
  }
}

function mapPosition(position: number, change: SourceEditDelta, rightAffinity: boolean): number {
  if (position < change.offset) { return position; }
  const removedEnd = change.offset + change.length;
  if (position > removedEnd) { return position + change.insertedLength - change.length; }
  if (change.length > 0 && position === removedEnd) { return change.offset + change.insertedLength; }
  return change.offset + (rightAffinity ? change.insertedLength : 0);
}
