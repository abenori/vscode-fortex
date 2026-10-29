/** Line starts in an immutable source, using UTF-16 offsets and 1-based lines. */
export default class SourceLineIndex {
  private readonly starts: number[] = [0];
  private readonly length: number;

  constructor(source: string) {
    this.length = source.length;
    for (let offset = 0; offset < source.length; offset++) {
      const code = source.charCodeAt(offset);
      if (code === 13) {
        if (source.charCodeAt(offset + 1) === 10) { offset++; }
        this.starts.push(offset + 1);
      } else if (code === 10) {
        this.starts.push(offset + 1);
      }
    }
  }

  lineNumberAt(offset: number): number {
    const position = Math.max(0, Math.min(this.length, Math.trunc(offset) || 0));
    let low = 0;
    let high = this.starts.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.starts[middle] <= position) { low = middle + 1; }
      else { high = middle; }
    }
    return low;
  }
}
