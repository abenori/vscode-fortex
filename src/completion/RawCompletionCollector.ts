import {
  CLASSIC_COMMAND_DECLARATIONS, CLASSIC_ENVIRONMENT_DECLARATIONS,
  DOCUMENT_COMMAND_DECLARATIONS, DOCUMENT_ENVIRONMENT_DECLARATIONS, PRIMITIVE_COMMAND_DECLARATIONS
} from '../latex-parser/DefinitionCommands';

/** 補完専用の文字列収集．外側のコメント・リテラル・定義の内部も検索対象にする． */
export interface RawLabel {
  /** 参照または検索に使用する識別キー． */
  key: string;
  /** labelコマンドのバックスラッシュの位置．元ソースのUTF-16単位． */
  offset: number;
  /** ラベル宣言の閉じ括弧の直後のUTF-16位置． */
  end: number
}
export interface RawCommand {
  /** 対象の名前． */
  name: string;
  /** スニペットで挿入する引数の個数．解析対象外の定義形式では0． */
  argumentCount: number;
  /** 先頭の引数に省略可能な既定値がある場合はtrue． */
  optionalFirstArgument: boolean
}
interface Argument {
  /** 元ソースにおける範囲の開始位置．0始まりのUTF-16単位で，この位置を含む． */
  start: number;
  /** 元ソースにおける範囲の終端．0始まりのUTF-16単位で，この位置を含まない． */
  end: number;
  /** 外側の区切りを除いた引数の本文． */
  text: string
}

/** 引数内のコメントとエスケープされた区切りを考慮し，括弧の対応を取る． */
class ArgumentReader {
  /**
   * ArgumentReaderの初期状態と所有するリソースを準備する．
   * @param source 解析または読み取りの対象となるソース本文．
   * @returns 新しいインスタンス．コンストラクタから明示的な値は返さない．
   */
  constructor(/** 解析対象の元のソース本文． */ readonly source: string) {}

  /**
   * コメントと空白を読み飛ばして次の入力位置を求める．
   * @param offset 対象文字列の先頭を0とするUTF-16位置．
   * @returns 次の有効な文字または入力末尾のUTF-16位置．
   */
  trivia(offset: number): number {
    while (offset < this.source.length) {
      if (/\s/.test(this.source[offset])) { offset++; }
      else if (this.source[offset] === '%') { offset = this.afterComment(offset); }
      else { break; }
    }
    return offset;
  }

  /**
   * コメントも候補源に含める読み取り規則で引数を読む．
   * @param offset 対象文字列の先頭を0とするUTF-16位置．
   * @param opening 読み取る引数の開き区切り．{は必須引数，[は省略可能引数．省略時は'{'．
   * @returns 引数の範囲と本文．開き区切りがない場合はundefined．
   */
  argument(offset: number, opening: '{' | '[' = '{'): Argument | undefined {
    const start = this.trivia(offset);
    if (this.source[start] !== opening) { return undefined; }
    const stack: string[] = [opening === '{' ? '}' : ']'];
    const parts: string[] = [];
    let part = start + 1;
    for (let cursor = part; cursor < this.source.length; cursor++) {
      const character = this.source[cursor];
      if (character === '\\') { cursor++; continue; }
      if (character === '%') {
        parts.push(this.source.slice(part, cursor));
        cursor = this.afterComment(cursor) - 1;
        part = cursor + 1;
        continue;
      }
      if (character === '{') { stack.push('}'); }
      else if (opening === '[' && character === '[' && stack.at(-1) !== '}') { stack.push(']'); }
      else if (character === stack.at(-1)) {
        stack.pop();
        if (stack.length === 0) {
          parts.push(this.source.slice(part, cursor));
          return { start, end: cursor + 1, text: parts.join('') };
        }
      }
    }
    return undefined;
  }

  /**
   * コメントとそれに続く改行の直後へ進む．
   * @param offset 対象文字列の先頭を0とするUTF-16位置．
   * @returns 読み飛ばした後のUTF-16位置．
   */
  private afterComment(offset: number): number {
    while (offset < this.source.length && this.source[offset] !== '\r' && this.source[offset] !== '\n') { offset++; }
    if (this.source[offset] === '\r') { offset++; }
    if (this.source[offset] === '\n') { offset++; }
    return offset;
  }
}

/**
 * コメントや例中の記述も含めてラベル宣言を収集する．
 * @param source 解析または読み取りの対象となるソース本文．
 * @returns ラベル名と元のソース中のUTF-16範囲の配列．
 */
export function collectRawLabels(source: string): RawLabel[] {
  const reader = new ArgumentReader(source);
  const pattern = /\\label(?![A-Za-z@])/g;
  const labels: RawLabel[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const argument = reader.argument(pattern.lastIndex);
    const key = argument?.text.trim();
    if (argument && key) { labels.push({ key, offset: match.index, end: argument.end }); }
  }
  return labels;
}

const classicCommands = new Set<string>(CLASSIC_COMMAND_DECLARATIONS);
const documentCommands = new Set<string>(DOCUMENT_COMMAND_DECLARATIONS);
const primitiveCommands = new Set<string>(PRIMITIVE_COMMAND_DECLARATIONS);
const environmentCommands = new Set([
  ...CLASSIC_ENVIRONMENT_DECLARATIONS, ...DOCUMENT_ENVIRONMENT_DECLARATIONS, 'newtheorem'
]);

/**
 * 文字列上で最後に現れた定義を採用する．xparse形式では名前だけを補完する．
 * @param source 解析または読み取りの対象となるソース本文．
 * @returns ソースで宣言されたコマンド名と，取得できた引数の情報．
 */
export function collectRawCommands(source: string): RawCommand[] {
  const reader = new ArgumentReader(source);
  const pattern = /\\([A-Za-z@]+)/g;
  const commands = new Map<string, RawCommand>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const declaration = match[1];
    if (!classicCommands.has(declaration) && !documentCommands.has(declaration)
      && !primitiveCommands.has(declaration) && declaration !== 'DeclareMathOperator') { continue; }
    let cursor = reader.trivia(pattern.lastIndex);
    if (source[cursor] === '*') { cursor = reader.trivia(cursor + 1); }
    const grouped = !primitiveCommands.has(declaration) ? reader.argument(cursor) : undefined;
    const rawName = grouped?.text.trim() ?? source.slice(cursor).match(/^\\[A-Za-z@]+/)?.[0];
    if (!rawName || !/^\\[A-Za-z@]+$/.test(rawName)) { continue; }
    const name = rawName.slice(1);
    cursor = grouped?.end ?? cursor + rawName.length;
    let argumentCount = 0;
    let optionalFirstArgument = false;
    if (classicCommands.has(declaration)) {
      const count = reader.argument(cursor, '[');
      if (count) {
        if (!/^[0-9]$/.test(count.text.trim())) { continue; }
        argumentCount = Number(count.text.trim());
        cursor = count.end;
        const defaultArgument = reader.argument(cursor, '[');
        optionalFirstArgument = Boolean(defaultArgument && argumentCount > 0);
      }
    } else if (primitiveCommands.has(declaration)) {
      let parameters = '';
      cursor = reader.trivia(cursor);
      while (cursor < source.length && source[cursor] !== '{') {
        const next = reader.trivia(cursor);
        if (next !== cursor) { cursor = next; continue; }
        parameters += source[cursor++];
      }
      for (const parameter of parameters.matchAll(/#([1-9])/g)) { argumentCount = Math.max(argumentCount, Number(parameter[1])); }
    }
    commands.set(name, { name, argumentCount, optionalFirstArgument });
  }
  return [...commands.values()];
}

/**
 * 例やコメント内も含め，名前付き環境の使用箇所と対応する定義を収集する．
 * @param source 解析または読み取りの対象となるソース本文．
 * @returns ソースに使用または宣言されている環境名の配列．
 */
export function collectRawEnvironments(source: string): string[] {
  const reader = new ArgumentReader(source);
  const names = new Set<string>();
  const pattern = /\\([A-Za-z@]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    if (match[1] !== 'begin' && match[1] !== 'end' && !environmentCommands.has(match[1])) { continue; }
    let cursor = reader.trivia(pattern.lastIndex);
    if (source[cursor] === '*') { cursor++; }
    const argument = reader.argument(cursor);
    const name = argument?.text.trim();
    if (name && !/[\\{}\s]/.test(name)) { names.add(name); }
  }
  return [...names];
}
