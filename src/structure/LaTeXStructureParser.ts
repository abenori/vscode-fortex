import * as LaTeXParser from '../latex-parser';
import { readInputFilename } from '../latex-parser/InputFilename';

/** ソース位置はVS Codeの文書位置と同じUTF-16単位で表す． */
export type StructureEvent =
  | {
    /** この項目がheadingであることを表す識別値． */
    type: 'heading';
    /** 対象のコマンド名または実行ファイル名． */
    command: string;
    /** 表示する題名． */
    title: string;
    /** 見出しの階層の深さ．値が小さい見出しほど上位に置く． */
    level: number;
    /** 元ソースにおける範囲の開始位置．0始まりのUTF-16単位で，この位置を含む． */
    start: number;
    /** 元ソースにおける範囲の終端．0始まりのUTF-16単位で，この位置を含まない． */
    end: number
  }
  | {
    /** この項目がbeginであることを表す識別値． */
    type: 'begin';
    /** 対象の名前． */
    name: string;
    /** 表示する題名． */
    title?: string;
    /** 元ソースにおける範囲の開始位置．0始まりのUTF-16単位で，この位置を含む． */
    start: number;
    /** 元ソースにおける範囲の終端．0始まりのUTF-16単位で，この位置を含まない． */
    end: number
  }
  | {
    /** この項目がendであることを表す識別値． */
    type: 'end';
    /** 対象の名前． */
    name: string;
    /** 元ソースにおける範囲の開始位置．0始まりのUTF-16単位で，この位置を含む． */
    start: number;
    /** 元ソースにおける範囲の終端．0始まりのUTF-16単位で，この位置を含まない． */
    end: number
  }
  | {
    /** この項目がlabelであることを表す識別値． */
    type: 'label';
    /** 参照または検索に使用する識別キー． */
    key: string;
    /** 元ソースにおける範囲の開始位置．0始まりのUTF-16単位で，この位置を含む． */
    start: number;
    /** 元ソースにおける範囲の終端．0始まりのUTF-16単位で，この位置を含まない． */
    end: number
  }
  | {
    /** この項目がcaptionであることを表す識別値． */
    type: 'caption';
    /** 表示する題名． */
    title: string;
    /** 元ソースにおける範囲の開始位置．0始まりのUTF-16単位で，この位置を含む． */
    start: number;
    /** 元ソースにおける範囲の終端．0始まりのUTF-16単位で，この位置を含まない． */
    end: number
  }
  | {
    /** この項目がincludeであることを表す識別値． */
    type: 'include';
    /** 読み込み宣言に書かれたファイル名． */
    path: string;
    /** 元ソースにおける範囲の開始位置．0始まりのUTF-16単位で，この位置を含む． */
    start: number;
    /** 元ソースにおける範囲の終端．0始まりのUTF-16単位で，この位置を含まない． */
    end: number
  }
  | {
    /** この項目がtheoremDefinitionであることを表す識別値． */
    type: 'theoremDefinition';
    /** 対象の名前． */
    name: string;
    /** 表示する題名． */
    title: string;
    /** 元ソースにおける範囲の開始位置．0始まりのUTF-16単位で，この位置を含む． */
    start: number;
    /** 元ソースにおける範囲の終端．0始まりのUTF-16単位で，この位置を含まない． */
    end: number
  };

const headingLevels = new Map([
  ['part', 0], ['chapter', 1], ['section', 2], ['subsection', 3],
  ['subsubsection', 4], ['paragraph', 5], ['subparagraph', 6]
]);
const displayEquationEnvironments = new Set([
  'equation', 'align', 'alignat', 'gather', 'multline', 'flalign', 'displaymath'
]);

/**
 * 利用者定義のマクロを展開せず，共有構文からアウトライン用のイベントを作る．
 * @param input 解析する文字列または共有するLaTeX構文解析結果．
 * @returns 出現順の見出し・環境・ラベル・入力宣言などの構造イベント．
 */
export function parseStructureEvents(input: string | LaTeXParser.LaTeXSource): StructureEvent[] {
  const syntax = typeof input === 'string' ? new LaTeXParser.LaTeXSource(input) : input;
  const source = syntax.source;
  const scanner = syntax.sourceScanner;
  const argumentsScanner = syntax.argumentScanner;
  const definitionParser = syntax.definitionParser;
  const definitions = definitionParser.definitions;
  // 完了した定義の内部は表示対象から除外する．不完全な本文では後続の構文から復帰できるようにする．
  const hidden = mergeRanges(definitionParser.consumedRanges);
  const commands = new Map(scanner.commands.map(command => [command.start, command]));
  const labels = new Map(syntax.referenceParser.tokens
    .filter(token => token.kind === 'label').map(token => [token.commandStart, token]));
  const includes = new Map<number, ReturnType<typeof readInputFilename>>();
  const titles = new Map<number, LaTeXParser.ScannedArgument>();
  const environmentTitles = new Map<number, LaTeXParser.ScannedArgument>();
  const excludedEnvironmentRanges = [...hidden];
  for (const command of scanner.commands) {
    if (rangeEndAt(hidden, command.start) !== undefined) { continue; }
    if (command.name === 'input' || command.name === 'include') {
      // 直接記述された名前はプロジェクト探索と同じファイル名規則で読む．アウトラインではマクロによるファイル名を未解決のままにする．
      // 呼び出し時に本文内でinputを実行するようなマクロ定義も展開しない．
      const group = argumentsScanner.readArgument(command.end);
      if (group?.complete) {
        const result = readInputFilename(syntax, { ...command, name: command.name });
        includes.set(command.start, result);
        excludedEnvironmentRanges.push({ start: command.end, end: result.consumedEnd });
      }
    } else if (headingLevels.has(command.name) || command.name === 'caption') {
      const title = readTitle(argumentsScanner, command.end);
      if (title) {
        titles.set(command.start, title);
        excludedEnvironmentRanges.push({ start: command.end, end: title.end });
      }
    } else if (command.name === 'begin') {
      const nameArgument = argumentsScanner.readArgument(command.end);
      if (!nameArgument?.complete) { continue; }
      const name = scanner.textWithoutComments(nameArgument.contentStart, nameArgument.contentEnd)?.trim() ?? '';
      if (!displayEquationEnvironments.has(name.replace(/\*$/, ''))) {
        const title = argumentsScanner.readArgument(nameArgument.end, '[');
        if (title?.complete) {
          environmentTitles.set(command.start, title);
          excludedEnvironmentRanges.push({ start: title.start, end: title.end });
        }
      }
    }
  }
  // 読み飛ばした引数の本文によって，後続のドル記号の対応状態が変わらないようにする．
  const environments = new Map(syntax.createEnvironmentParser(excludedEnvironmentRanges).tokens
    .map(token => [token.start, token]));
  const events: StructureEvent[] = definitions
    .filter(definition => definition.kind === 'theorem' && definition.complete)
    .map(definition => ({
      type: 'theoremDefinition', name: definition.name,
      title: structurePlainText(definition.title ?? ''), start: definition.start, end: definition.end
    }));

  const collectTitleEvents = (start: number, end: number): void => {
    for (let cursor = start; cursor < end;) {
      const hiddenEnd = rangeEndAt(hidden, cursor);
      if (hiddenEnd !== undefined) {
        cursor = hiddenEnd;
        continue;
      }
      const command = commands.get(cursor);
      if (!command || scanner.maskedSource[cursor] !== '\\') {
        cursor++;
        continue;
      }
      const label = labels.get(cursor);
      if (label && label.commandEnd <= end) {
        events.push({ type: 'label', key: label.key, start: cursor, end: label.commandEnd });
        cursor = label.commandEnd;
        continue;
      }
      if (command.name === 'caption') {
        const title = titles.get(cursor);
        if (title && title.end <= end) {
          events.push({
            type: 'caption', title: structurePlainText(source.slice(title.contentStart, title.contentEnd)),
            start: cursor, end: title.end
          });
        }
      }
      cursor = command.end;
    }
  };

  for (let cursor = 0; cursor < source.length;) {
    const hiddenEnd = rangeEndAt(hidden, cursor);
    if (hiddenEnd !== undefined) {
      cursor = hiddenEnd;
      continue;
    }
    const environment = environments.get(cursor);
    if (environment) {
      const start = cursor;
      cursor = environment.end;
      if (environment.style === 'named' || environment.style === 'display' || environment.style === 'doubleDollar') {
        if (environment.kind === 'end') {
          events.push({ type: 'end', name: environment.name, start, end: cursor });
        } else {
          const title = environmentTitles.get(start);
          cursor = title?.end ?? cursor;
          events.push({
            type: 'begin', name: environment.name, start, end: cursor,
            ...(title ? { title: structurePlainText(source.slice(title.contentStart, title.contentEnd)) } : {})
          });
          if (title) { collectTitleEvents(title.contentStart, title.contentEnd); }
        }
      }
      continue;
    }
    const command = commands.get(cursor);
    if (!command || scanner.maskedSource[cursor] !== '\\') {
      cursor++;
      continue;
    }
    const start = cursor;
    cursor = command.end;
    const title = titles.get(start);
    const level = headingLevels.get(command.name);
    if (title && (level !== undefined || command.name === 'caption')) {
      const text = structurePlainText(source.slice(title.contentStart, title.contentEnd));
      events.push(level !== undefined
        ? { type: 'heading', command: command.name, level, title: text, start, end: title.end }
        : { type: 'caption', title: text, start, end: title.end });
      collectTitleEvents(command.end, title.end);
      cursor = title.end;
    } else if (command.name === 'label') {
      const group = argumentsScanner.readArgument(command.end);
      if (group?.complete) {
        const label = labels.get(start);
        if (label) { events.push({ type: 'label', key: label.key, start, end: group.end }); }
        cursor = group.end;
      }
    } else {
      const include = includes.get(start);
      if (include) {
        if (include.status === 'resolved' && (command.name === 'input' || command.name === 'include')) {
          events.push({ type: 'include', path: include.filename,
            start, end: include.consumedEnd });
        }
        cursor = Math.max(cursor, include.consumedEnd);
      }
    }
  }
  return events.sort((left, right) => left.start - right.start);
}

export interface StructurePlainTextOptions {
  /** 数式の要約を整形する際，実際の名前付き環境の開始・終了宣言を除く． */
  readonly omitEnvironmentCommands?: boolean;
}

/**
 * 数式マクロなどの未知のコマンドを残し，表示用の文字列を正規化する．
 * @param source 解析または読み取りの対象となるソース本文．
 * @param options 処理の動作を指定するオプション．省略時は{}．
 * @returns 既知の装飾を整理し，未知のコマンドを保持した表示用文字列．
 */
export function structurePlainText(source: string, options: StructurePlainTextOptions = {}): string {
  const syntax = new LaTeXParser.LaTeXSource(source);
  const scanner = syntax.sourceScanner;
  const argumentsScanner = syntax.argumentScanner;
  const commands = new Map(scanner.commands.map(command => [command.start, command]));
  const environmentCommands = options.omitEnvironmentCommands
    ? new Map(syntax.createEnvironmentParser([], ['named']).tokens.map(token => [token.start, token]))
    : undefined;
  const ignored = new Map(scanner.ignoredRanges.filter(range => range.start < range.end)
    .map(range => [range.start, range]));
  const formatting = /^(?:text(?:bf|it|sl|sc|sf|tt|rm|up|normal)|emph|underline|mbox|ensuremath|bfseries|itshape|slshape|scshape|sffamily|ttfamily|rmfamily|normalfont|protect)$/;
  const braces: boolean[] = [];
  let result = '';
  let cursor = 0;
  let math = false;
  let preserveNextGroup = false;
  let stripNextGroup = false;
  while (cursor < source.length) {
    const character = source[cursor];
    const range = ignored.get(cursor);
    if (range) {
      result += range.kind === 'comment' ? ' ' : source.slice(range.contentStart, range.contentEnd);
      cursor = range.end;
      continue;
    }
    const environment = environmentCommands?.get(cursor);
    if (environment) {
      // 元の走査結果とリテラル範囲を保持する．宣言を除去しても，リテラルの再解釈や隣のコマンドとの結合が起きないようにする．
      result += ' ';
      cursor = environment.end;
      preserveNextGroup = false;
      stripNextGroup = false;
      continue;
    }
    const command = commands.get(cursor);
    if (command) {
      if (command.name === 'label') {
        const group = argumentsScanner.readArgument(command.end);
        cursor = group?.complete ? group.end : command.end;
        continue;
      }
      if (formatting.test(command.name)) {
        cursor = command.end;
        preserveNextGroup = false;
        stripNextGroup = true;
        continue;
      }
      if (command.name === 'LaTeX' || command.name === 'TeX') {
        result += command.name;
        cursor = command.end;
        continue;
      }
      if (/^[%&_#$ {}]$/.test(command.name)) {
        result += command.name;
        cursor = command.end;
        preserveNextGroup = false;
        continue;
      }
      if (command.name === '\\' || /^[,;:!>]$/.test(command.name) || command.name === 'quad' || command.name === 'qquad') {
        result += ' ';
        cursor = command.end;
        continue;
      }
      if (/^["'`^~=.uvHckbdtr]$/.test(command.name)) {
        const next = scanner.skipTrivia(command.end)!;
        const group = argumentsScanner.readArgument(next);
        if (group?.complete && group.contentEnd - group.contentStart === 1) {
          result += source[group.contentStart];
          cursor = group.end;
          continue;
        }
        if (/[A-Za-z]/.test(source[next] ?? '')) {
          result += source[next];
          cursor = next + 1;
          continue;
        }
      }
      if (command.name === '(' || command.name === '[') {
        math = true;
      } else if (command.name === ')' || command.name === ']') {
        math = false;
      }
      result += source.slice(cursor, command.end);
      preserveNextGroup = true;
      stripNextGroup = false;
      cursor = command.end;
      continue;
    }
    if (character === '{') {
      const preserve = !stripNextGroup && (math || preserveNextGroup);
      braces.push(preserve);
      if (preserve) { result += character; }
      preserveNextGroup = false;
      stripNextGroup = false;
    } else if (character === '}') {
      const preserve = braces.pop() ?? false;
      if (preserve) { result += character; }
      preserveNextGroup = preserve;
    } else {
      if (character === '$') {
        math = !math;
        if (source[cursor + 1] === '$') {
          result += '$';
          cursor++;
        }
      }
      result += character === '~' ? ' ' : character;
      if (!/\s/.test(character)) {
        preserveNextGroup = false;
        stripNextGroup = false;
      }
    }
    cursor++;
  }
  return result.replace(/\s+/g, ' ').trim();
}

/**
 * 文字列が構造要素間の空白・コメントだけからなるかを調べる．
 * @param source 解析または読み取りの対象となるソース本文．
 * @returns 表示すべき内容を含まない場合はtrue．
 */
export function isStructureTrivia(source: string): boolean {
  return new LaTeXParser.LaTeXSource(source).sourceScanner.skipTrivia(0) === source.length;
}

/**
 * 文書全体の構造を解析せず，単独の見出し宣言を読む．
 * @param source 解析または読み取りの対象となるソース本文．
 * @param expectedCommand 読み取り対象とする見出しコマンド名．
 * @returns 指定コマンドの見出し名．宣言が不完全または別のコマンドならundefined．
 */
export function readHeadingTitle(source: string, expectedCommand: string): string | undefined {
  if (!headingLevels.has(expectedCommand)) { return undefined; }
  const syntax = new LaTeXParser.LaTeXSource(source);
  const command = syntax.sourceScanner.commands[0];
  if (command?.start !== 0 || command.name !== expectedCommand) { return undefined; }
  const title = readTitle(syntax.argumentScanner, command.end);
  if (!title || title.end !== source.length) { return undefined; }
  return structurePlainText(source.slice(title.contentStart, title.contentEnd));
}

/**
 * 星と省略可能引数を読み飛ばして見出し本文の引数を読む．
 * @param scanner 元のソースに対する共有字句解析結果．
 * @param offset 対象文字列の先頭を0とするUTF-16位置．
 * @returns 見出し本文の引数．読めなければundefined．
 */
function readTitle(scanner: LaTeXParser.ArgumentScanner, offset: number): LaTeXParser.ScannedArgument | undefined {
  let cursor = scanner.readStar(offset)?.end ?? offset;
  const optional = scanner.readArgument(cursor, '[');
  if (optional) {
    if (!optional.complete) { return undefined; }
    cursor = optional.end;
  }
  const title = scanner.readArgument(cursor);
  return title?.complete ? title : undefined;
}

/**
 * 重なり合うソース範囲を結合して開始位置順に並べる．
 * @param ranges 開始位置と終端位置で表した半開範囲の一覧．
 * @returns 重複走査を避けるための，互いに重ならない半開範囲の配列．
 */
function mergeRanges(ranges: readonly LaTeXParser.SourceRange[]): LaTeXParser.SourceRange[] {
  const merged: {
    /** 元ソースにおける範囲の開始位置．0始まりのUTF-16単位で，この位置を含む． */
    start: number;
    /** 元ソースにおける範囲の終端．0始まりのUTF-16単位で，この位置を含まない． */
    end: number
  }[] = [];
  for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }
  return merged;
}

/**
 * 位置がいずれかの除外範囲に含まれるかを調べる．
 * @param ranges 開始位置と終端位置で表した半開範囲の一覧．
 * @param offset 対象文字列の先頭を0とするUTF-16位置．
 * @returns 含まれる範囲の終端．範囲外ならundefined．
 */
function rangeEndAt(ranges: readonly LaTeXParser.SourceRange[], offset: number): number | undefined {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (ranges[middle].end <= offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return ranges[low]?.start <= offset ? ranges[low].end : undefined;
}
