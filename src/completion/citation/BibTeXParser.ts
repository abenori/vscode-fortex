import { ParsedBibEntry } from './Citation';

interface ParsedValue {
  /** 引用符や外側の波括弧を除き，文字列定義を展開したフィールド値． */
  value: string;
  /** 値の読み取り後，次に解析を開始するUTF-16位置． */
  next: number;
}

/**
 * 引用補完に必要なBibTeXの情報を解析する．括弧の入れ子と引用符を追跡し，題名中のカンマでフィールドを誤って分割しないようにする．
 *
 * @param text 処理対象の文字列．
 * @returns 引用キー，エントリ種別，および展開済みフィールドを持つ文献の配列．
 */
export function parseBibTeX(text: string): ParsedBibEntry[] {
  const entries: ParsedBibEntry[] = [];
  const strings = new Map<string, string>();
  let offset = 0;

  while (offset < text.length) {
    const at = findNextEntryStart(text, offset);
    if (at < 0) {
      break;
    }

    let cursor = skipWhitespace(text, at + 1);
    const typeStart = cursor;
    while (cursor < text.length && /[A-Za-z]/.test(text[cursor])) {
      cursor++;
    }
    const type = text.slice(typeStart, cursor).toLowerCase();
    cursor = skipWhitespace(text, cursor);
    const open = text[cursor];
    if (!type || (open !== '{' && open !== '(')) {
      offset = at + 1;
      continue;
    }

    const end = findEntryEnd(text, cursor, open === '{' ? '}' : ')');
    if (end < 0) {
      break;
    }

    const body = text.slice(cursor + 1, end);
    if (type === 'string') {
      parseStringDefinition(body, strings);
    } else if (type !== 'comment' && type !== 'preamble') {
      const entry = parseRegularEntry(type, body, strings);
      if (entry) {
        entries.push(entry);
      }
    }
    offset = end + 1;
  }

  return entries;
}

/**
 * コメントを読み飛ばして次のBibTeXエントリの開始を探す．
 * @param text 処理対象の文字列．
 * @param start 対象範囲の開始位置．UTF-16単位で，範囲に含む．
 * @returns 次の@のUTF-16位置．見つからなければ-1．
 */
function findNextEntryStart(text: string, start: number): number {
  let inComment = false;
  for (let cursor = start; cursor < text.length; cursor++) {
    const char = text[cursor];
    if (inComment) {
      if (char === '\n' || char === '\r') {
        inComment = false;
      }
    } else if (char === '%') {
      inComment = true;
    } else if (char === '@') {
      return cursor;
    }
  }
  return -1;
}

/**
 * 入れ子の括弧と引用符を考慮してBibTeXエントリの終端を探す．
 * @param text 処理対象の文字列．
 * @param openOffset 開き区切りのUTF-16位置．
 * @param close 対応する閉じ区切り文字．
 * @returns 閉じ区切りのUTF-16位置．見つからなければ-1．
 */
function findEntryEnd(text: string, openOffset: number, close: string): number {
  const open = text[openOffset];
  let outerDepth = 1;
  let braceDepth = 0;
  let quoted = false;

  for (let i = openOffset + 1; i < text.length; i++) {
    const char = text[i];
    if (char === '"' && !isEscaped(text, i)) {
      quoted = !quoted;
      continue;
    }
    if (quoted) {
      continue;
    }

    if (open === '{') {
      if (char === '{' && !isEscaped(text, i)) {
        outerDepth++;
      } else if (char === '}' && !isEscaped(text, i)) {
        outerDepth--;
        if (outerDepth === 0) {
          return i;
        }
      }
    } else {
      if (char === '{' && !isEscaped(text, i)) {
        braceDepth++;
      } else if (char === '}' && !isEscaped(text, i) && braceDepth > 0) {
        braceDepth--;
      } else if (char === '(' && braceDepth === 0 && !isEscaped(text, i)) {
        outerDepth++;
      } else if (char === close && braceDepth === 0 && !isEscaped(text, i)) {
        outerDepth--;
        if (outerDepth === 0) {
          return i;
        }
      }
    }
  }
  return -1;
}

/**
 * BibTeXの文字列定義を読み取り，後続のフィールド値の展開に使用する表へ登録する．
 * @param body BibTeXエントリの外側の区切りを除いた本文．
 * @param strings BibTeXの文字列名から展開済みの値への対応表．
 * @returns なし．
 */
function parseStringDefinition(body: string, strings: Map<string, string>): void {
  let cursor = skipSeparators(body, 0);
  const nameStart = cursor;
  while (cursor < body.length && /[A-Za-z0-9_:\-.]/.test(body[cursor])) {
    cursor++;
  }
  const name = body.slice(nameStart, cursor).trim().toLowerCase();
  cursor = skipWhitespace(body, cursor);
  if (!name || body[cursor] !== '=') {
    return;
  }
  const parsed = parseValue(body, cursor + 1, strings);
  strings.set(name, parsed.value);
}

/**
 * 通常のBibTeXエントリから引用キーとフィールドを抽出する．
 * @param type 項目の種別．
 * @param body BibTeXエントリの外側の区切りを除いた本文．
 * @param strings BibTeXの文字列名から展開済みの値への対応表．
 * @returns 引用キー，エントリ種別，フィールドの対応表．キーを読めなければundefined．
 */
function parseRegularEntry(type: string, body: string, strings: ReadonlyMap<string, string>): ParsedBibEntry | undefined {
  const comma = findTopLevelComma(body, 0);
  if (comma < 0) {
    return undefined;
  }
  const key = body.slice(0, comma).trim();
  if (!key) {
    return undefined;
  }

  const fields: Record<string, string> = {};
  let cursor = comma + 1;
  while (cursor < body.length) {
    cursor = skipSeparators(body, cursor);
    if (cursor >= body.length) {
      break;
    }

    const nameStart = cursor;
    while (cursor < body.length && /[A-Za-z0-9_:\-.]/.test(body[cursor])) {
      cursor++;
    }
    const name = body.slice(nameStart, cursor).trim().toLowerCase();
    cursor = skipWhitespace(body, cursor);
    if (!name || body[cursor] !== '=') {
      const next = findTopLevelComma(body, cursor);
      if (next < 0) {
        break;
      }
      cursor = next + 1;
      continue;
    }

    const parsed = parseValue(body, cursor + 1, strings);
    fields[name] = parsed.value.trim();
    cursor = parsed.next;
  }

  return { key, type, fields };
}

/**
 * BibTeXの値を読み取り，#で連結された文字列を展開する．
 * @param text 処理対象の文字列．
 * @param start 対象範囲の開始位置．UTF-16単位で，範囲に含む．
 * @param strings BibTeXの文字列名から展開済みの値への対応表．
 * @returns 展開後の文字列と，次に読み取るUTF-16位置．
 */
function parseValue(text: string, start: number, strings: ReadonlyMap<string, string>): ParsedValue {
  const parts: string[] = [];
  let cursor = start;

  while (cursor < text.length) {
    cursor = skipWhitespaceAndComments(text, cursor);
    const char = text[cursor];
    let part: ParsedValue;
    if (char === '{') {
      part = parseBracedValue(text, cursor);
    } else if (char === '"') {
      part = parseQuotedValue(text, cursor);
    } else {
      part = parseBareValue(text, cursor, strings);
    }
    parts.push(part.value);
    cursor = skipWhitespaceAndComments(text, part.next);
    if (text[cursor] !== '#') {
      break;
    }
    cursor++;
  }

  return { value: parts.join(''), next: cursor };
}

/**
 * 波括弧で囲まれたBibTeXの値を，入れ子を保ちながら読み取る．
 * @param text 処理対象の文字列．
 * @param start 対象範囲の開始位置．UTF-16単位で，範囲に含む．
 * @returns 外側の括弧を除いた値と，読み取り後のUTF-16位置．
 */
function parseBracedValue(text: string, start: number): ParsedValue {
  let depth = 1;
  for (let cursor = start + 1; cursor < text.length; cursor++) {
    const char = text[cursor];
    if (char === '{' && !isEscaped(text, cursor)) {
      depth++;
    } else if (char === '}' && !isEscaped(text, cursor)) {
      depth--;
      if (depth === 0) {
        return { value: text.slice(start + 1, cursor), next: cursor + 1 };
      }
    }
  }
  return { value: text.slice(start + 1), next: text.length };
}

/**
 * 二重引用符で囲まれたBibTeXの値を読み取る．
 * @param text 処理対象の文字列．
 * @param start 対象範囲の開始位置．UTF-16単位で，範囲に含む．
 * @returns 外側の引用符を除いた値と，読み取り後のUTF-16位置．
 */
function parseQuotedValue(text: string, start: number): ParsedValue {
  let braceDepth = 0;
  for (let cursor = start + 1; cursor < text.length; cursor++) {
    const char = text[cursor];
    if (char === '{' && !isEscaped(text, cursor)) {
      braceDepth++;
    } else if (char === '}' && !isEscaped(text, cursor) && braceDepth > 0) {
      braceDepth--;
    } else if (char === '"' && braceDepth === 0 && !isEscaped(text, cursor)) {
      return { value: text.slice(start + 1, cursor), next: cursor + 1 };
    }
  }
  return { value: text.slice(start + 1), next: text.length };
}

/**
 * 括弧や引用符のないBibTeXの値を読み取り，文字列定義を展開する．
 * @param text 処理対象の文字列．
 * @param start 対象範囲の開始位置．UTF-16単位で，範囲に含む．
 * @param strings BibTeXの文字列名から展開済みの値への対応表．
 * @returns 展開した値と，読み取り後のUTF-16位置．
 */
function parseBareValue(text: string, start: number, strings: ReadonlyMap<string, string>): ParsedValue {
  let cursor = start;
  while (cursor < text.length && text[cursor] !== ',' && text[cursor] !== '#') {
    cursor++;
  }
  const token = text.slice(start, cursor).trim();
  return { value: strings.get(token.toLowerCase()) ?? token, next: cursor };
}

/**
 * 括弧の入れ子と引用符の外にあるカンマを探す．
 * @param text 処理対象の文字列．
 * @param start 対象範囲の開始位置．UTF-16単位で，範囲に含む．
 * @returns 区切りカンマのUTF-16位置．見つからなければ-1．
 */
function findTopLevelComma(text: string, start: number): number {
  let braceDepth = 0;
  let quoted = false;
  for (let cursor = start; cursor < text.length; cursor++) {
    const char = text[cursor];
    if (char === '"' && !isEscaped(text, cursor)) {
      quoted = !quoted;
    } else if (!quoted && char === '{' && !isEscaped(text, cursor)) {
      braceDepth++;
    } else if (!quoted && char === '}' && !isEscaped(text, cursor) && braceDepth > 0) {
      braceDepth--;
    } else if (!quoted && braceDepth === 0 && char === ',') {
      return cursor;
    }
  }
  return -1;
}

/**
 * BibTeXフィールド間の空白とカンマを読み飛ばす．
 * @param text 処理対象の文字列．
 * @param start 対象範囲の開始位置．UTF-16単位で，範囲に含む．
 * @returns 区切りを読み飛ばした後のUTF-16位置．
 */
function skipSeparators(text: string, start: number): number {
  let cursor = start;
  while (cursor < text.length) {
    cursor = skipWhitespaceAndComments(text, cursor);
    if (text[cursor] !== ',') {
      break;
    }
    cursor++;
  }
  return cursor;
}

/**
 * 空白文字を読み飛ばす．
 * @param text 処理対象の文字列．
 * @param start 対象範囲の開始位置．UTF-16単位で，範囲に含む．
 * @returns 次の空白以外の文字または入力末尾のUTF-16位置．
 */
function skipWhitespace(text: string, start: number): number {
  let cursor = start;
  while (cursor < text.length && /\s/.test(text[cursor])) {
    cursor++;
  }
  return cursor;
}

/**
 * 空白とBibTeXコメントを読み飛ばす．
 * @param text 処理対象の文字列．
 * @param start 対象範囲の開始位置．UTF-16単位で，範囲に含む．
 * @returns 次の有効な文字または入力末尾のUTF-16位置．
 */
function skipWhitespaceAndComments(text: string, start: number): number {
  let cursor = skipWhitespace(text, start);
  while (text[cursor] === '%') {
    const newline = text.indexOf('\n', cursor + 1);
    cursor = newline < 0 ? text.length : skipWhitespace(text, newline + 1);
  }
  return cursor;
}

/**
 * 位置の直前に連続するバックスラッシュが奇数個かを調べる．
 * @param text 処理対象の文字列．
 * @param offset 対象文字列の先頭を0とするUTF-16位置．
 * @returns 位置の直前に奇数個のバックスラッシュが連続している場合はtrue．
 */
function isEscaped(text: string, offset: number): boolean {
  let slashCount = 0;
  for (let cursor = offset - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) {
    slashCount++;
  }
  return slashCount % 2 === 1;
}
