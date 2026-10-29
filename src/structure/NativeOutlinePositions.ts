/** Offsets and lengths use VS Code's UTF-16 document coordinates. */
export interface OutlineEdit {
  offset: number;
  length: number;
  insertedLength: number;
}

export interface OutlineHeading {
  start: number;
  end: number;
  extent: number;
}

export interface MappedOutlineHeading extends OutlineHeading {
  valid: boolean;
  /** Advances only when an edit touches this declaration, not its surrounding body. */
  revision: number;
}

/** Moves saved heading positions without reading text or reparsing on input. */
export default class NativeOutlinePositions {
  private readonly headings = new Map<number, MappedOutlineHeading>();
  private readonly pending: OutlineEdit[][] = [];
  private projection?: ReadonlyMap<number, MappedOutlineHeading>;

  constructor(headings: readonly OutlineHeading[]) {
    for (const heading of headings) {
      this.headings.set(heading.start, { start: heading.start, end: heading.end, extent: heading.extent, valid: true, revision: 0 });
    }
  }

  /** One batch uses offsets from before that TextDocumentChangeEvent. */
  record(changes: readonly OutlineEdit[]): void {
    const batch = changes.filter(change => change.length !== 0 || change.insertedLength !== 0)
      .map(change => ({ offset: change.offset, length: change.length, insertedLength: change.insertedLength }))
      .sort((left, right) => right.offset - left.offset);
    if (batch.length) { this.pending.push(batch); }
  }

  /** Applies only new batches; previously returned maps and values stay fixed. */
  project(): ReadonlyMap<number, MappedOutlineHeading> {
    if (this.projection && this.pending.length === 0) { return this.projection; }
    for (const batch of this.pending) {
      for (const change of batch) {
        const removedEnd = change.offset + change.length;
        for (const heading of this.headings.values()) {
          const removalOverlaps = change.length > 0 && change.offset < heading.end && removedEnd > heading.start;
          const insertionInside = change.insertedLength > 0 && heading.start < change.offset && change.offset < heading.end;
          // A missing closing brace may be reinserted at the mapped end. Keep
          // its left affinity, but let the bounded title reader retry there.
          const insertionAtEnd = change.insertedLength > 0 && heading.start < heading.end && change.offset === heading.end;
          if (removalOverlaps || insertionInside) {
            heading.valid = false;
          }
          if (removalOverlaps || insertionInside || insertionAtEnd) {
            heading.revision++;
          }
          const start = mapPosition(heading.start, change, true);
          const end = Math.max(start, mapPosition(heading.end, change, false));
          heading.start = start;
          heading.end = end;
          heading.extent = Math.max(end, mapPosition(heading.extent, change, true));
        }
      }
    }
    this.pending.length = 0;
    this.projection = new Map([...this.headings].map(([key, heading]) => [key, Object.freeze({ ...heading })]));
    return this.projection;
  }
}

function mapPosition(position: number, change: OutlineEdit, rightAffinity: boolean): number {
  if (position < change.offset) { return position; }
  const removedEnd = change.offset + change.length;
  if (position > removedEnd) { return position + change.insertedLength - change.length; }
  if (change.length > 0 && position === removedEnd) { return change.offset + change.insertedLength; }
  return change.offset + (rightAffinity ? change.insertedLength : 0);
}
