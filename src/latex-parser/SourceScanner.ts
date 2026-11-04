/** 元ソースにおけるUTF-16単位の半開区間． */
export interface SourceRange {
  /** 元ソースにおける範囲の開始位置．0始まりのUTF-16単位で，この位置を含む． */
  readonly start: number;
  /** 元ソースにおける範囲の終端．0始まりのUTF-16単位で，この位置を含まない． */
  readonly end: number;
}

/** 名前は先頭のバックスラッシュと直後の星印を含めない． */
export interface CommandToken extends SourceRange {
  /** 先頭のバックスラッシュを除いたコマンド名，または波括弧内の環境名． */
  readonly name: string;
}

export interface IgnoredRange extends SourceRange {
  /** この項目の種別を表す識別値． */
  readonly kind: 'comment' | 'inlineLiteral' | 'literalEnvironment';
  /** 区切り記号を除く本文の開始位置．元ソースのUTF-16単位． */
  readonly contentStart: number;
  /** 区切り記号を除く本文の終端．このUTF-16位置は含まない． */
  readonly contentEnd: number;
  /** 対応する閉じ区切りが見つかった場合はtrue． */
  readonly closed: boolean;
}

const literalEnvironments = new Set([
  'verbatim', 'verbatim*', 'Verbatim', 'Verbatim*',
  'BVerbatim', 'BVerbatim*', 'LVerbatim', 'LVerbatim*',
  'SaveVerbatim', 'SaveVerbatim*', 'VerbatimOut',
  'lstlisting', 'lstlisting*', 'minted', 'minted*', 'comment',
  'filecontents', 'filecontents*'
]);

interface EnvironmentName {
  /** 先頭のバックスラッシュを除いたコマンド名，または波括弧内の環境名． */
  readonly name: string;
  /** 元ソースにおける範囲の終端．0始まりのUTF-16単位で，この位置を含まない． */
  readonly end: number;
  /** 環境名の読み取り中に見つかったコメント範囲． */
  readonly comments: readonly IgnoredRange[];
}

interface RawGroup extends SourceRange {
  /** 区切り記号を除く本文の開始位置．元ソースのUTF-16単位． */
  readonly contentStart: number;
  /** 区切り記号を除く本文の終端．このUTF-16位置は含まない． */
  readonly contentEnd: number;
  /** 対応する閉じ区切りが見つかった場合はtrue． */
  readonly closed: boolean;
}

/**
 * マクロ展開やカテゴリーコードの解釈を行わずに字句を走査する．コメントとインラインリテラルは全体をマスクし，リテラル環境は本文だけをマスクして開始・終了コマンドを残す．
 * 改行とUTF-16位置は保持する．コマンド一覧にはインラインリテラルの開始コマンドを含め，除外範囲の本文内のコマンドは含めない．マクロ定義の本文は，利用側で解釈する通常のソースとして扱う．
 */
export default class SourceScanner {
  /** 解析対象の元のソース本文． */
  public readonly source: string;
  /** コメント・リテラルを空白へ置換し，元と同じUTF-16長と改行を保つソース． */
  public readonly maskedSource: string;
  /** コメント・リテラル外で見つかったコマンドの出現順の配列． */
  public readonly commands: readonly CommandToken[];
  /** 通常の構文解析から除外するコメントとリテラルの範囲． */
  public readonly ignoredRanges: readonly IgnoredRange[];

  /**
   * SourceScannerの初期状態と所有するリソースを準備する．
   * @param source 解析または読み取りの対象となるソース本文．
   * @returns 新しいインスタンス．コンストラクタから明示的な値は返さない．
   */
  constructor(source: string) {
    this.source = source;
    const characters = source.split('');
    const commands: CommandToken[] = [];
    const ignoredRanges: IgnoredRange[] = [];
    const rawGroups = new RawGroupIndex(source);
    const ignore = (range: IgnoredRange): void => {
      ignoredRanges.push(range);
      for (let offset = range.start; offset < range.end; offset++) {
        if (source[offset] !== '\r' && source[offset] !== '\n') {
          characters[offset] = ' ';
        }
      }
    };

    for (let cursor = 0; cursor < source.length;) {
      if (source[cursor] === '%') {
        const range = readComment(source, cursor);
        ignore(range);
        cursor = range.end;
        continue;
      }
      if (source[cursor] !== '\\') {
        cursor++;
        continue;
      }

      // 直前までのコマンドは全体を読み取っているため，このバックスラッシュはエスケープされていない．トークンごとに連続するバックスラッシュを走査し直さない．
      const command = readCommandUnchecked(source, cursor);
      commands.push(command);
      cursor = command.end;
      const inline = readInlineLiteral(source, command, rawGroups);
      if (inline) {
        ignore(inline);
        cursor = inline.end;
        continue;
      }
      if (command.name !== 'begin') {
        continue;
      }
      const environment = readEnvironmentName(source, cursor);
      if (!environment || !literalEnvironments.has(environment.name)) {
        continue;
      }
      for (const comment of environment.comments) {
        ignore(comment);
      }
      const closing = findEnvironmentEnd(source, environment.end, environment.name);
      const end = closing?.start ?? source.length;
      ignore({
        kind: 'literalEnvironment', start: environment.end, end,
        contentStart: environment.end, contentEnd: end, closed: closing !== undefined
      });
      cursor = end;
    }
    this.maskedSource = characters.join('');
    this.commands = commands;
    this.ignoredRanges = ignoredRanges;
  }

  /**
   * 空白とコメントを読み飛ばす．マスクされたリテラルでも，その手前で止まる．不正な位置ではundefinedを返し，EOFは有効な停止位置とする．
   *
   * @param offset 対象文字列の先頭を0とするUTF-16位置．
   * @returns 空白とコメントの直後のUTF-16位置．リテラルの手前では止まり，不正な入力位置ならundefined．
   */
  public skipTrivia(offset: number): number | undefined {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.source.length) {
      return undefined;
    }
    while (offset < this.source.length) {
      const ignored = this.ignoredRanges[this.ignoredIndexAt(offset)];
      if (ignored && ignored.start <= offset) {
        if (ignored.kind !== 'comment') {
          return offset;
        }
        offset = ignored.end;
      } else if (/\s/.test(this.source[offset])) {
        offset++;
      } else {
        break;
      }
    }
    return offset;
  }

  /**
   * コメントとその直後の改行を除いたソース本文を返す．リテラルと他の空白は保持する．範囲はUTF-16単位の半開区間で，不正な場合はundefinedを返す．
   *
   * @param start 対象範囲の開始位置．UTF-16単位で，範囲に含む．省略時は0．
   * @param end 対象範囲の終端位置．UTF-16単位で，範囲に含まない．省略時はthis.source.length．
   * @returns コメントと直後の改行を取り除いた文字列．不正な範囲ならundefined．
   */
  public textWithoutComments(start = 0, end = this.source.length): string | undefined {
    if (!Number.isInteger(start) || !Number.isInteger(end)
      || start < 0 || end < start || end > this.source.length) {
      return undefined;
    }
    const parts: string[] = [];
    let cursor = start;
    for (let index = this.ignoredIndexAt(start); index < this.ignoredRanges.length; index++) {
      const range = this.ignoredRanges[index];
      if (range.start >= end) {
        break;
      }
      if (range.kind !== 'comment') {
        continue;
      }
      parts.push(this.source.slice(cursor, Math.max(cursor, range.start)));
      let afterComment = range.end;
      if (this.source[afterComment] === '\r') {
        afterComment++;
      }
      if (this.source[afterComment] === '\n') {
        afterComment++;
      }
      cursor = Math.min(afterComment, end);
    }
    parts.push(this.source.slice(cursor, end));
    return parts.join('');
  }

  /**
   * 指定位置より終端が後にある最初の除外範囲．
   * @param offset 対象文字列の先頭を0とするUTF-16位置．
   * @returns 指定位置より終端が後にある最初の除外範囲の添字．なければ配列長．
   */
  private ignoredIndexAt(offset: number): number {
    let low = 0;
    let high = this.ignoredRanges.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.ignoredRanges[middle].end <= offset) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }
}

/**
 * このソース位置の直前に奇数個のバックスラッシュが連続するかを表す．
 * @param source 解析または読み取りの対象となるソース本文．
 * @param offset 対象文字列の先頭を0とするUTF-16位置．
 * @returns 位置の直前に奇数個のバックスラッシュが連続している場合はtrue．
 */
export function isEscaped(source: string, offset: number): boolean {
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length) {
    return false;
  }
  let start = offset;
  while (start > 0 && source[start - 1] === '\\') {
    start--;
  }
  return (offset - start) % 2 === 1;
}

/**
 * ASCII英字と@からなる制御綴，またはUnicodeの制御記号1文字を読む．末尾のバックスラッシュは，名前が空の不完全なコマンドとして保持する．
 * 指定位置がコメントやリテラルの内部かは判定しない．
 *
 * @param source 解析または読み取りの対象となるソース本文．
 * @param start 対象範囲の開始位置．UTF-16単位で，範囲に含む．
 * @returns コマンドの名前と半開UTF-16範囲．有効な開始位置でなければundefined．
 */
export function readCommand(source: string, start: number): CommandToken | undefined {
  if (!Number.isInteger(start) || start < 0 || start >= source.length
    || source[start] !== '\\' || isEscaped(source, start)) {
    return undefined;
  }
  return readCommandUnchecked(source, start);
}

/**
 * 有効性を確認済みのバックスラッシュからコマンドを読み取る．
 * @param source 解析または読み取りの対象となるソース本文．
 * @param start 対象範囲の開始位置．UTF-16単位で，範囲に含む．
 * @returns コマンドの名前と，バックスラッシュを含む半開UTF-16範囲．
 */
function readCommandUnchecked(source: string, start: number): CommandToken {
  let end = start + 1;
  if (isCommandLetter(source[end])) {
    while (isCommandLetter(source[end])) {
      end++;
    }
  } else if (end < source.length) {
    end += codePointLength(source, end);
  }
  return { start, end, name: source.slice(start + 1, end) };
}

/**
 * 文字が制御綴の名前に使用できるASCII英字または@かを調べる．
 * @param character 判定する1文字．入力末尾ではundefined．
 * @returns コマンド名を構成する文字であればtrue．
 */
function isCommandLetter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z@]/.test(character);
}

/**
 * 指定位置のUnicodeコードポイントのUTF-16単位数を求める．
 * @param source 解析または読み取りの対象となるソース本文．
 * @param offset 対象文字列の先頭を0とするUTF-16位置．
 * @returns サロゲートペアなら2，それ以外なら1．
 */
function codePointLength(source: string, offset: number): number {
  return (source.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1;
}

/**
 * 現在行の改行開始位置を求める．
 * @param source 解析または読み取りの対象となるソース本文．
 * @param start 対象範囲の開始位置．UTF-16単位で，範囲に含む．
 * @returns CR・LFの位置，または入力末尾のUTF-16位置．
 */
function lineEnd(source: string, start: number): number {
  while (start < source.length && source[start] !== '\r' && source[start] !== '\n') {
    start++;
  }
  return start;
}

/**
 * パーセント記号から改行直前までのコメントを読み取る．
 * @param source 解析または読み取りの対象となるソース本文．
 * @param start 対象範囲の開始位置．UTF-16単位で，範囲に含む．
 * @returns 記号と本文の範囲を持つコメント情報．改行は範囲に含めない．
 */
function readComment(source: string, start: number): IgnoredRange {
  const end = lineEnd(source, start);
  return {
    kind: 'comment', start, end, contentStart: start + 1,
    contentEnd: end, closed: true
  };
}

/**
 * 空白文字を読み飛ばす．
 * @param source 解析または読み取りの対象となるソース本文．
 * @param start 対象範囲の開始位置．UTF-16単位で，範囲に含む．
 * @returns 次の空白以外の文字または入力末尾のUTF-16位置．
 */
function skipWhitespace(source: string, start: number): number {
  while (start < source.length && /\s/.test(source[start])) {
    start++;
  }
  return start;
}

/**
 * 波括弧の前後や内部のコメントを許容する，単純な環境名．
 * @param source 解析または読み取りの対象となるソース本文．
 * @param start 対象範囲の開始位置．UTF-16単位で，範囲に含む．
 * @returns 環境名，閉じ括弧の直後の位置，および途中のコメント．不正な名前ならundefined．
 */
function readEnvironmentName(source: string, start: number): EnvironmentName | undefined {
  const comments: IgnoredRange[] = [];
  let cursor = start;
  const skipTrivia = (): void => {
    cursor = skipWhitespace(source, cursor);
    while (source[cursor] === '%') {
      const comment = readComment(source, cursor);
      comments.push(comment);
      cursor = skipWhitespace(source, comment.end);
    }
  };
  skipTrivia();
  if (source[cursor] !== '{') {
    return undefined;
  }
  cursor++;
  let name = '';
  while (cursor < source.length && source[cursor] !== '}') {
    if (source[cursor] === '%') {
      const comment = readComment(source, cursor);
      comments.push(comment);
      cursor = comment.end;
      if (source[cursor] === '\r') {
        cursor++;
      }
      if (source[cursor] === '\n') {
        cursor++;
      }
    } else if (source[cursor] === '{' || source[cursor] === '\\') {
      return undefined;
    } else {
      name += source[cursor++];
    }
  }
  name = name.trim();
  return source[cursor] === '}' && name.length > 0 && !/\s/.test(name)
    ? { name, end: cursor + 1, comments }
    : undefined;
}

/**
 * リテラル環境と同名の終了宣言を探す．
 * @param source 解析または読み取りの対象となるソース本文．
 * @param start 対象範囲の開始位置．UTF-16単位で，範囲に含む．
 * @param name 対象を識別する名前．
 * @returns 対応するendコマンド．見つからなければundefined．
 */
function findEnvironmentEnd(source: string, start: number, name: string): CommandToken | undefined {
  let cursor = source.indexOf('\\end', start);
  while (cursor !== -1) {
    // リテラル環境の本文には，通常のエスケープやコメントの規則を適用しない．
    const command = readCommandUnchecked(source, cursor);
    if (command.name === 'end' && readEnvironmentName(source, command.end)?.name === name) {
      return command;
    }
    cursor = source.indexOf('\\end', command.end);
  }
  return undefined;
}

/**
 * verb系コマンドのオプションと区切りからリテラル範囲を読み取る．
 * @param source 解析または読み取りの対象となるソース本文．
 * @param command バックスラッシュを除いたコマンド名と，元ソース中の半開UTF-16範囲．
 * @param rawGroups リテラル引数の区切りを再利用する索引．
 * @returns リテラルの本文・全体範囲と閉じているかの情報．対象外ならundefined．
 */
function readInlineLiteral(source: string, command: CommandToken, rawGroups: RawGroupIndex): IgnoredRange | undefined {
  if (!['verb', 'Verb', 'lstinline', 'mintinline'].includes(command.name)) {
    return undefined;
  }
  let cursor = source[command.end] === '*' ? command.end + 1 : command.end;
  if (command.name !== 'verb') {
    cursor = skipInlineWhitespace(source, cursor);
    if (source[cursor] === '[') {
      const optional = rawGroups.read(cursor);
      if (!optional.closed) {
        return undefined;
      }
      cursor = skipInlineWhitespace(source, optional.end);
    }
  }
  if (command.name === 'mintinline') {
    if (source[cursor] !== '{') {
      return undefined;
    }
    const language = rawGroups.read(cursor);
    if (!language.closed) {
      return undefined;
    }
    cursor = skipInlineWhitespace(source, language.end);
  }
  // オプションや言語指定の引数が未完了なら，リテラル本文はまだ始まっていない．区切りが始まった後の未完了なリテラルは，次の行末で終わる．
  if ((command.name === 'lstinline' || command.name === 'mintinline') && source[cursor] === '{') {
    return { kind: 'inlineLiteral', ...rawGroups.read(cursor), start: command.start };
  }
  if (cursor >= source.length || /\s/.test(source[cursor])) {
    return undefined;
  }
  const delimiterLength = codePointLength(source, cursor);
  const delimiter = source.slice(cursor, cursor + delimiterLength);
  const contentStart = cursor + delimiterLength;
  let end = contentStart;
  while (end < source.length && source[end] !== '\r' && source[end] !== '\n'
    && !source.startsWith(delimiter, end)) {
    end += codePointLength(source, end);
  }
  const contentEnd = end;
  const closed = source.startsWith(delimiter, end);
  if (closed) {
    end += delimiterLength;
  }
  return { kind: 'inlineLiteral', start: command.start, end, contentStart, contentEnd, closed };
}

/**
 * 改行を越えずに空白文字を読み飛ばす．
 * @param source 解析または読み取りの対象となるソース本文．
 * @param start 対象範囲の開始位置．UTF-16単位で，範囲に含む．
 * @returns 次の非空白文字，改行，または入力末尾のUTF-16位置．
 */
function skipInlineWhitespace(source: string, start: number): number {
  while (start < source.length && source[start] !== '\r' && source[start] !== '\n' && /\s/.test(source[start])) {
    start++;
  }
  return start;
}

/**
 * 生の引数内の%は通常文字とし，未完了なら次の行末で復帰する．同じ行に未完了の開始指定が多数あっても，残りを繰り返し走査しないよう行ごとに一度だけ索引を作る．
 * 波括弧内の角括弧は区切りとして扱わない．
 */
class RawGroupIndex {
  /** 開き区切りの位置をキーとする生の引数範囲のキャッシュ． */
  private readonly groups = new Map<number, RawGroup>();

  /**
   * RawGroupIndexの初期状態と所有するリソースを準備する．
   * @param source 解析または読み取りの対象となるソース本文．
   * @returns 新しいインスタンス．コンストラクタから明示的な値は返さない．
   */
  constructor(/** 解析対象の元のソース本文． */ private readonly source: string) { }

  /**
   * 現在行の生の引数を索引から取得する．
   * @param start 対象範囲の開始位置．UTF-16単位で，範囲に含む．
   * @returns 区切りと本文の範囲，および閉じているかの情報．
   */
  public read(start: number): RawGroup {
    let group = this.groups.get(start);
    if (!group) {
      this.indexLine(start);
      group = this.groups.get(start);
    }
    // 呼び出し側が要求するのは，インラインコマンドまたは完了済みのオプション・言語指定引数の後にある，エスケープされていない開き波括弧・角括弧だけ．
    return group!;
  }

  /**
   * 指定位置を含む行の生の引数区切りを索引へ登録する．
   * @param start 対象範囲の開始位置．UTF-16単位で，範囲に含む．
   * @returns なし．
   */
  private indexLine(start: number): void {
    const source = this.source;
    let lineStart = start;
    while (lineStart > 0 && source[lineStart - 1] !== '\r' && source[lineStart - 1] !== '\n') {
      lineStart--;
    }
    const end = lineEnd(source, start);
    const tokens: {
      /** 元ソースにおける範囲の開始位置．0始まりのUTF-16単位で，この位置を含む． */
      start: number;
      /** 索引に記録した区切りまたは通常の1文字． */
      character: string
    }[] = [];
    for (let cursor = lineStart; cursor < end;) {
      const character = source[cursor];
      tokens.push({ start: cursor, character });
      cursor++;
      if (character === '\\' && cursor < end) {
        cursor += codePointLength(source, cursor);
      }
    }

    const braces: number[] = [];
    const closingBraces = new Map<number, number>();
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.character === '{') {
        braces.push(index);
      } else if (token.character === '}' && braces.length > 0) {
        const opening = braces.pop()!;
        closingBraces.set(opening, index);
        this.record(tokens[opening].start, token.start);
      }
    }
    for (const opening of braces) {
      this.record(tokens[opening].start, undefined, end);
    }

    // nextClosing[i]はトークンi以降で保護されていない最初の閉じ角括弧を指す．閉じた入れ子は，その直後の結果へ飛ばす．逆順に計算することで，波括弧内の開き角括弧も独立して処理する．
    const nextClosing: (number | undefined)[] = new Array(tokens.length + 1);
    for (let index = tokens.length - 1; index >= 0; index--) {
      const token = tokens[index];
      if (token.character === ']') {
        nextClosing[index] = index;
      } else if (token.character === '[') {
        const closing = nextClosing[index + 1];
        this.record(token.start, closing === undefined ? undefined : tokens[closing].start, end);
        nextClosing[index] = closing === undefined ? undefined : nextClosing[closing + 1];
      } else if (token.character === '{') {
        const closing = closingBraces.get(index);
        nextClosing[index] = closing === undefined ? undefined : nextClosing[closing + 1];
      } else {
        nextClosing[index] = nextClosing[index + 1];
      }
    }
  }

  /**
   * 生の引数の範囲と閉鎖状態を索引へ記録する．
   * @param start 対象範囲の開始位置．UTF-16単位で，範囲に含む．
   * @param closing 閉じ区切りのUTF-16位置．未閉鎖ならundefined．
   * @param lineEnd 対象行の改行開始または入力末尾のUTF-16位置．省略時はthis.source.length．
   * @returns なし．
   */
  private record(start: number, closing: number | undefined, lineEnd = this.source.length): void {
    this.groups.set(start, {
      start, end: closing === undefined ? lineEnd : closing + 1,
      contentStart: start + 1, contentEnd: closing ?? lineEnd, closed: closing !== undefined
    });
  }
}
