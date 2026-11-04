/** 不変ソース内の行頭をUTF-16位置で保持し，1始まりの行番号に対応付ける． */
export default class SourceLineIndex {
  /** 各行頭のUTF-16位置を昇順に保持する配列．先頭行は0． */
  private readonly starts: number[] = [0];
  /** 元のソースのUTF-16単位の長さ． */
  private readonly length: number;

  /**
   * SourceLineIndexの初期状態と所有するリソースを準備する．
   * @param source 解析または読み取りの対象となるソース本文．
   * @returns 新しいインスタンス．コンストラクタから明示的な値は返さない．
   */
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

  /**
   * UTF-16位置を保存した改行索引の行番号へ変換する．
   * @param offset 対象文字列の先頭を0とするUTF-16位置．
   * @returns 1始まりの行番号．位置はソースの範囲内へ補正する．
   */
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
