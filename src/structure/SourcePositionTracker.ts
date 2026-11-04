/** 位置と長さはVS Codeの文書と同じUTF-16単位で表す． */
export interface SourceEditDelta {
  /** 編集前の本文における0始まりのUTF-16位置． */
  offset: number;
  /** 編集前の本文から削除または置換するUTF-16単位の長さ． */
  length: number;
  /** 挿入する文字列のUTF-16単位の長さ． */
  insertedLength: number;
}

export interface SourceAnchor {
  /** 捕捉ソースにおけるアンカーの開始UTF-16位置． */
  start: number;
  /** 捕捉ソースにおけるアンカーの終端UTF-16位置．この位置は含まない． */
  end: number;
}

export interface MappedSourceAnchor extends SourceAnchor {
  /** 編集がアンカー範囲に重なるか，範囲の終端に挿入があった場合に進める改訂番号． */
  revision: number;
}

/** 文字入力時に本文を読んだり再解析したりせず，捕捉したソース範囲の位置を追跡する． */
export default class SourcePositionTracker {
  /** 元の開始位置をキーとする，現在のアンカー範囲とリビジョンの表． */
  private readonly anchors = new Map<number, MappedSourceAnchor>();
  /** まだ位置投影に適用していない，編集イベント単位の差分． */
  private readonly pending: SourceEditDelta[][] = [];
  /** 現在の文書版に対して計算済みの位置・表示情報． */
  private projection?: ReadonlyMap<number, MappedSourceAnchor>;

  /**
   * SourcePositionTrackerの初期状態と所有するリソースを準備する．
   * @param anchors 編集に追従させる元ソースの範囲．
   * @returns 新しいインスタンス．コンストラクタから明示的な値は返さない．
   */
  constructor(anchors: readonly SourceAnchor[]) {
    for (const anchor of anchors) {
      this.anchors.set(anchor.start, { start: anchor.start, end: anchor.end, revision: 0 });
    }
  }

  /**
   * 1回の編集イベント内の差分は，すべてそのイベントより前の位置を基準とする．
   * @param changes 順序を保つ一覧．各要素は編集前の開始UTF-16位置，削除文字数，および挿入文字数．
   * @returns なし．
   */
  record(changes: readonly SourceEditDelta[]): void {
    const batch = changes.filter(change => change.length !== 0 || change.insertedLength !== 0)
      .map(change => ({ offset: change.offset, length: change.length, insertedLength: change.insertedLength }))
      .sort((left, right) => right.offset - left.offset);
    if (batch.length) { this.pending.push(batch); }
  }

  /**
   * 新しい差分だけを適用する．以前に返したMapと値は変更しない．
   * 引数はない．
   * @returns 元のアンカー開始位置をキーに，現在の開始・終了位置とリビジョンを対応付けた読み取り専用Map．
   */
  project(): ReadonlyMap<number, MappedSourceAnchor> {
    if (this.projection && this.pending.length === 0) { return this.projection; }
    for (const batch of this.pending) {
      for (const change of batch) {
        const removedEnd = change.offset + change.length;
        for (const anchor of this.anchors.values()) {
          const removalOverlaps = change.length > 0 && change.offset < anchor.end && removedEnd > anchor.start;
          const insertionInside = change.insertedLength > 0 && anchor.start < change.offset && change.offset < anchor.end;
          // 終端と同じ位置への挿入では終端を動かさず，編集されたことだけを記録する．挿入された区切りによって宣言が完成した場合，利用側で読み直す必要がある．
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

/**
 * 1件の文字編集に合わせて位置を移動する．
 * @param position 編集前の本文における0始まりのUTF-16位置．
 * @param change 編集前の開始UTF-16位置，削除文字数，および挿入文字数．
 * @param rightAffinity 位置と同じ場所へ挿入された文字の後ろへ移す場合はtrue．
 * @returns 挿入・削除を適用した後のUTF-16位置．
 */
function mapPosition(position: number, change: SourceEditDelta, rightAffinity: boolean): number {
  if (position < change.offset) { return position; }
  const removedEnd = change.offset + change.length;
  if (position > removedEnd) { return position + change.insertedLength - change.length; }
  if (change.length > 0 && position === removedEnd) { return change.offset + change.insertedLength; }
  return change.offset + (rightAffinity ? change.insertedLength : 0);
}
