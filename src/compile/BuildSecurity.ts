/** ソース中の%#指示で実行ファイルを指定する際，既定で許可するプログラム． */
export const DEFAULT_ALLOWED_PROGRAMS = [
  'tex',
  'pdftex',
  'luatex',
  'xetex',
  'ptex',
  'uptex',
  'latex',
  'pdflatex',
  'lualatex',
  'xelatex',
  'platex',
  'uplatex',
  'dvipdfmx',
  'dvipsk',
  'bibtex',
  'upbibtex',
  'biber',
  'mendex',
  'makeindex',
  'upmendex'
] as const;

/** シェルを使わずにコマンド行を解析した結果． */
export interface ParsedCommandLine {
  /** 起動する実行ファイル名またはパス． */
  executable: string;
  /** 実行ファイルへ個別に渡す追加引数．シェル用の引用符は加えない． */
  args: string[];
}

/** 形式が不正な%#!コマンドはビルド開始前に拒否する． */
export class CommandLineParseError extends Error {
  /**
   * CommandLineParseErrorの初期状態と所有するリソースを準備する．
   * @param message 表示または記録するメッセージ．
   * @returns 新しいインスタンス．コンストラクタから明示的な値は返さない．
   */
  constructor(message: string) {
    super(message);
    this.name = 'CommandLineParseError';
  }
}

/**
 * コマンド行を実行ファイル名と引数に分割する．一重・二重引用符は空白をまとめるために使い，結果からは除く．
 * バックスラッシュは対応する引用符だけをエスケープするため，Windowsのパス区切りは保持する．
 *
 * @param commandLine 引用符付きの引数を含むコマンド行．
 * @returns 実行ファイル名と，引用符を除去して分割した引数の配列．
 */
export function parseCommandLine(commandLine: string): ParsedCommandLine {
  const tokens: string[] = [];
  let token = '';
  let tokenStarted = false;
  let quote: '"' | "'" | undefined;

  for (let offset = 0; offset < commandLine.length; offset++) {
    const char = commandLine[offset];
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else if (char === '\\' && commandLine[offset + 1] === quote) {
        token += quote;
        offset++;
      } else {
        token += char;
      }
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(token);
        token = '';
        tokenStarted = false;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (char === '\\' && (commandLine[offset + 1] === '"' || commandLine[offset + 1] === "'")) {
      token += commandLine[offset + 1];
      tokenStarted = true;
      offset++;
      continue;
    }
    token += char;
    tokenStarted = true;
  }

  if (quote) {
    throw new CommandLineParseError(`Unclosed ${quote} quote in command line.`);
  }
  if (tokenStarted) {
    tokens.push(token);
  }
  if (!tokens[0]) {
    throw new CommandLineParseError('The command line does not contain an executable program.');
  }
  return { executable: tokens[0], args: tokens.slice(1) };
}

/**
 * 引用符内のセミコロンを無視し，次の処理区切りの位置を返す．
 * @param commandLine 引用符付きの引数を含むコマンド行．
 * @param start 対象範囲の開始位置．UTF-16単位で，範囲に含む．省略時は0．
 * @returns 引用符の外にある次のセミコロンのUTF-16位置．見つからなければ-1．
 */
export function findCommandSeparator(commandLine: string, start = 0): number {
  let quote: '"' | "'" | undefined;
  for (let offset = start; offset < commandLine.length; offset++) {
    const char = commandLine[offset];
    if (quote) {
      if (char === '\\' && commandLine[offset + 1] === quote) {
        offset++;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ';') {
      return offset;
    }
  }
  if (quote) {
    throw new CommandLineParseError(`Unclosed ${quote} quote in command line.`);
  }
  return -1;
}

/**
 * 1語だけの%#!指示は，標準のビルド手順で使用するエンジンを指定する．
 * @param directive 検証または解析するソース中のビルド指示．
 * @returns 引数を持たない指示の実行ファイル名．それ以外はundefined．
 */
export function singleProgramFromDirective(directive: string): string | undefined {
  if (findCommandSeparator(directive) >= 0 || directive.trimStart().startsWith('$(')) {
    return undefined;
  }
  const parsed = parseCommandLine(directive);
  return parsed.args.length === 0 ? parsed.executable : undefined;
}

/**
 * 名前をそのまま照合する．単独の*だけがすべてのプログラムを許可する．
 * @param program 補助プログラムの種類または実行名．
 * @param allowedPrograms 起動を許可するプログラム名の一覧．単独の*はすべてを許可する．
 * @returns プログラム名が許可される場合はtrue．
 */
export function isProgramAllowed(program: string, allowedPrograms: readonly string[]): boolean {
  const normalized = allowedPrograms.map((entry) => entry.trim()).filter(Boolean);
  return normalized.includes('*') || normalized.includes(program);
}

/**
 * %#指示で許可されていないプログラムを指定した場合，実行前に利用者向けのエラーを送出する．
 * @param program 補助プログラムの種類または実行名．
 * @param allowedPrograms 起動を許可するプログラム名の一覧．単独の*はすべてを許可する．
 * @param directive 検証または解析するソース中のビルド指示．
 * @returns なし．
 */
export function assertProgramAllowed(
  program: string,
  allowedPrograms: readonly string[],
  directive: string
): void {
  if (!isProgramAllowed(program, allowedPrograms)) {
    throw new Error(
      `Program "${program}" from ${directive} is not allowed by vscode-fortex.compile.allowedPrograms.`
    );
  }
}
