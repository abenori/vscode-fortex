/**
 * LaTeXLogAnalyzerの検出対象と追加情報の読み取り方．
 * Errorは見出しの形式で検出し，種類に応じて以下の追加処理を行う．
 * 文字列の大文字・小文字は区別する．
 *
 * 【Error】
 *
 * ■ 共通のエラー（LaTeX Error・Package Error・Class Errorなどを含む）
 * 検出：「file:line: 本文」または行頭の「! 本文」．本文のエラー名は限定しない．
 *       file形式はパス区切りか末尾の拡張子を持ち，先頭空白・[・(や，
 *       ファイル名に「->」を含む候補を除く．引用符付きファイル名も扱う．
 * 追加：file・lineがあれば位置に使い，行番号が未取得・無効なら後続の
 *       「l.番号」から補う．本文の通常継続行は改行なしで連結する．
 *       「(名前) 字下げ 本文」は接頭辞を除き，改行付きで追加する．
 *       空行で本文収集を止めた後も，Errorでは文脈の収集を続ける．
 *
 * ■ Undefined control sequence
 * 検出：共通Errorの本文先頭が「Undefined control sequence」．
 * 追加：「l.番号」の行と次の文脈行をソースへ照合し，境界直前の命令を強調する．
 *       マクロ展開中も，ソース側の呼び出し命令を特定できれば強調する．
 *       本文がこの定型文だけなら，展開文脈またはソース文脈から取れた
 *       未定義命令名を本文へ補う．定義された場所の逆引きは行わない．
 *
 * ■ Double subscript
 * 検出：共通Errorの本文先頭が「Double subscript」．
 * 追加：ソース文脈の照合で境界が一意に決まれば，直前の「_」を強調する．
 *
 * ■ Double superscript
 * 検出：共通Errorの本文先頭が「Double superscript」．
 * 追加：ソース文脈の照合で境界が一意に決まれば，直前の「^」を強調する．
 *
 * ■ Runaway argument
 * 検出：行全体が「Runaway argument?」．これだけでは診断を作らない．
 * 追加：その行と続きの行を，次に認識した診断の本文へ付記する．
 *       「! File ended while scanning use of ...」自体は共通Errorとして検出する．
 *
 * ■ Emergency stop・ファイル不足など
 * 検出：「! Emergency stop.」「! LaTeX Error: File ... not found.」などを
 *       共通Errorとして検出する．これらのエラー名による専用判定はない．
 * 追加：収集中の「***」で始まる終了説明を本文へ追加する．
 *       ファイル不足の名前は本文に残すが，対応するソース命令は逆引きしない．
 *
 * ■ Luaエラー
 * 検出：先頭が空白でない行にある「[directlua]:番号: 本文」または
 *       「[latelua]:番号: 本文」．角括弧内の先頭に「\」がある形も許容する．
 * 追加：file:line形式があればその位置を優先し，なければ「l.番号」で補う．
 *       Lua形式内の番号をソース行番号としては使わない．
 *       「stack traceback:」以降のフレームは読み飛ばし，別件の診断にしない．
 *
 * ■ Fatal終了要約
 * 検出：共通Errorの本文が，先頭空白を除いて「==> Fatal error occurred」で始まる．
 * 追加：同じログに要約以外のErrorがあれば省略し，要約しかなければ残す．
 *
 * 【Warning】
 *
 * ■ 一般の警告・フォント警告・再実行要求など
 * 検出：行頭の「LaTeX Warning:」「LaTeX Font Warning:」「LaTeX3 Warning:」，
 *       「Package 名前 Warning:」「Class 名前 Warning:」「Module 名前 Warning:」．
 *       個々の警告内容による限定はしない．
 * 追加：継続行を本文へ取り込み，本文中の最初の「at lines n--m」を優先して，
 *       なければ最初の「on [input] line n」「at line n」から行番号を取得する．
 *
 * ■ 未定義の参照
 * 検出：一般Warningとして取得した本文が，次の定型全体に一致する場合．
 *       「LaTeX Warning: Reference `キー' on page ... undefined on input line n.」
 *       キーの開始引用符は「`」または「'」を許容する．
 * 追加：報告行だけをReferenceParserで解析し，キーが一致するref・eqref・pagerefの
 *       キー部分をすべて強調する．行内のコメント・リテラルを除外し，カンマもキーに含める．
 *       前の行から続く文脈や複数行の引数，マクロ展開は扱わず，
 *       対応する参照がなければ報告行全体を使う．
 *
 * ■ 未定義の引用
 * 検出：「LaTeX Warning: Citation ...」を一般Warningとして検出する．
 * 追加：本文の行番号を使う．引用キーの位置を絞る専用処理はない．
 *
 * ■ Missing character
 * 検出：行頭の「Missing character:」．
 * 追加：本文に上記の行番号形式があれば使い，位置が得られなければログ行を使う．
 *
 * ■ 未定義参照の終了要約
 * 検出：「LaTeX Warning: There were undefined references.」．
 * 追加：個別のReference/Citation未定義警告（undefined on input line ...）が
 *       同じログにあれば省略し，要約しかなければ残す．
 *
 * 【Information】
 *
 * ■ Overfull・Underfull
 * 検出：行頭の「Overfull \hbox」「Overfull \vbox」，
 *       「Underfull \hbox」「Underfull \vbox」．WarningではなくInformationにする．
 * 追加：「at lines n--m」「at line n」などから行・行範囲を取得する．
 *       ページ番号だけの出力はソース行へ変換しない．後続の組版内容は本文に含めない．
 *
 * 【各項目に共通する位置・文脈の扱い】
 * - ファイル名省略時は読み込み表示の括弧から推定し，候補がなければmainを使う．
 *   相対パスはmainの親ディレクトリ基準とし，折り返されたパスの復元も試みる．
 * - 「\命令 -> ...」「<argument>」などの文脈と，続く字下げ行を保持する．
 *   「->」を含む文脈があれば展開情報を本文へ追加し，ソース文脈から
 *   境界直前の呼び出し命令を特定できれば，通常のエラーでもその命令を強調する．
 * - 文脈の照合は報告行と「l.番号」が一致する場合だけ行う．空白差を許し，
 *   先頭・末尾の「...」を省略表示とみなし，U+FFFFFを除いて一意な境界を探す．
 * - ソースは開いた文書の未保存内容を優先し，実パスが同じ別名も照合する．
 *   なければ保存済みファイルをUTF-8で読む．範囲を絞れなければ報告行全体を使う．
 * - 有効なファイル・行番号がなければ，ログの見出し行を使う．ソースが読めない，
 *   または報告行が文書外の場合は，報告されたソース位置を維持する．
 * - URI・範囲・重要度・本文が同じ診断を除去する．
 *   ファイル追跡・文脈照合は形式に基づく推定であり，未実行の条件分岐や
 *   マクロ定義内の参照も，静的な参照照合の候補に含まれ得る．
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as Workspace from '../../workspace';
import ReferenceParser from '../../latex-parser/ReferenceParser';

type Diagnostics = [vscode.Uri, vscode.Diagnostic[]][];
const referenceCommands = new Set(['ref', 'eqref', 'pageref']);

interface SourceContext {
  line: number;
  before: string;
  after: string;
}

interface LogEntry {
  file?: vscode.Uri;
  line?: number;
  endLine?: number;
  logLine: number;
  message: string;
  severity: vscode.DiagnosticSeverity;
  context?: SourceContext;
  frames: string[];
  summary: boolean;
}

interface Header {
  entry: LogEntry;
  end: number;
}

interface Source {
  uri: vscode.Uri;
  lines: string[];
}

/**
 * 一回のLaTeX実行のログを解析し，ソースまたはログ上の診断を生成する．
 * @param main 実行したメインTeXファイル．
 * @param logfile 今回の実行で更新されたログファイル．
 * @returns 対象URIごとの診断一覧．ログを読めない場合は拒否される．
 */
export default async function analyzeLaTeXLog(main: vscode.Uri, logfile: vscode.Uri): Promise<Diagnostics> {
  const lines = Buffer.from(await vscode.workspace.fs.readFile(logfile)).toString('utf8').split(/\r?\n/);
  const entries = parseLog(lines, main);
  const sources = new Map<string, Source | undefined>();
  const diagnostics = new Map<string, [vscode.Uri, vscode.Diagnostic[]]>();
  const seen = new Set<string>();
  const hasDetailedError = entries.some(entry => !entry.summary && entry.severity === vscode.DiagnosticSeverity.Error);
  const hasUndefinedReference = entries.some(entry => /^LaTeX Warning: (?:Reference|Citation) .+ undefined on input line /.test(entry.message));
  for (const entry of entries) {
    if (entry.summary && hasDetailedError) { continue; }
    if (hasUndefinedReference && entry.message.trim() === 'LaTeX Warning: There were undefined references.') { continue; }
    const hasLocation = entry.file && validLine(entry.line);
    const uri = hasLocation ? entry.file! : logfile;
    const key = Workspace.uriKey(uri);
    if (hasLocation && !sources.has(key)) { sources.set(key, await readSource(uri)); }
    const source = sources.get(key);
    const target = source?.uri ?? uri;
    const ranges = hasLocation ? sourceRanges(entry, source) : [wholeLine(entry.logLine)];
    const message = entryMessage(entry);
    for (const range of ranges) {
      const diagnostic = new vscode.Diagnostic(range, message, entry.severity);
      const identity = JSON.stringify([Workspace.uriKey(target), range.start, range.end, diagnostic.severity, diagnostic.message]);
      if (seen.has(identity)) { continue; }
      seen.add(identity);
      const targetKey = Workspace.uriKey(target);
      let group = diagnostics.get(targetKey);
      if (!group) { group = [target, []]; diagnostics.set(targetKey, group); }
      group[1].push(diagnostic);
    }
  }
  return [...diagnostics.values()];
}

/**
 * 1始まりの行番号がVS Codeの位置へ安全に変換できるか調べる．
 * @param line 確認する行番号．
 * @returns 正の安全な整数ならtrue．
 */
function validLine(line: number | undefined): line is number {
  return line !== undefined && Number.isSafeInteger(line) && line > 0;
}

/**
 * ログを走査し，メッセージ・展開文脈・ソース文脈をエラーごとに集める．
 * @param lines 元ログの物理行．
 * @param main 初期の入力ファイルと相対パスの基準を与えるURI．
 * @returns ログ位置を保持した診断候補．解析状態は呼び出し内だけで使用する．
 */
function parseLog(lines: string[], main: vscode.Uri): LogEntry[] {
  const directory = path.dirname(main.fsPath);
  const files: (vscode.Uri | undefined)[] = [];
  const existence = new Map<string, boolean>();
  const entries: LogEntry[] = [];
  let current: LogEntry | undefined;
  let body = false;
  let tail = false;
  let luaTrace = false;
  let runaway: string[] | undefined;
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index];
    // Luaの長いフレームの折り返しも，別のファイル付き見出しとして登録しない．
    if (luaTrace && !/^l\.\d+\s|^!|==>\s*Fatal error occurred/.test(text)) { continue; }
    const lua = text.search(/\[(?:\\?directlua|\\?latelua)\]:\d+:/);
    if (lua > 0 && text.startsWith('(')) { updateFileStack(text.slice(0, lua), files, directory, existence); }
    const file = [...files].reverse().find(candidate => candidate !== undefined) ?? main;
    const header = readHeader(lines, index, directory, file);
    if (header) {
      current = header.entry;
      if (runaway) { current.message += '\n' + runaway.join('\n'); runaway = undefined; }
      entries.push(current);
      index = header.end;
      body = current.severity !== vscode.DiagnosticSeverity.Information;
      tail = false;
      luaTrace = false;
      continue;
    }
    if (text === 'Runaway argument?') {
      current = undefined;
      runaway = [text];
      continue;
    }
    if (runaway) { runaway.push(text); continue; }
    if (current) {
      const context = /^l\.(\d+)[ \t](.*)$/.exec(text);
      if (context) {
        const line = Number(context[1]);
        let after = '';
        if (index + 1 < lines.length && !readHeader(lines, index + 1, directory, file)
          && !/^l\.\d+\s|^Here is how much|^\*\*\*/.test(lines[index + 1])) {
          after = lines[++index];
        }
        current.context = { line, before: context[2], after };
        if (!validLine(current.line) && validLine(line)) { current.line = line; }
        current = undefined;
        tail = true;
        luaTrace = false;
        continue;
      }
      if (/^(?:<[^>]+>|\\.*?->)/.test(text)) {
        current.frames.push(text.trimEnd());
        if (index + 1 < lines.length && /^[ \t]/.test(lines[index + 1])) {
          const rest = lines[++index].trim();
          if (rest) { current.frames.push(rest); }
        }
        body = false;
        continue;
      }
      if (/^\*\*\*/.test(text)) { current.message += '\n' + text; continue; }
      if (/^Here is how much|^Output written|^Transcript written|^stack traceback:/.test(text)) {
        body = false;
        if (text.startsWith('stack traceback:')) { luaTrace = true; }
        else { current = undefined; }
        continue;
      }
      if (text.trim() === '') {
        body = false;
        if (current.severity !== vscode.DiagnosticSeverity.Error) {
          current = undefined;
        }
        continue;
      }
      if (body) {
        const continuation = /^\([^)]*\)[ \t]+(.*)$/.exec(text);
        current.message += continuation ? '\n' + continuation[1] : text;
      }
      continue;
    }
    if (tail) { if (text.trim() === '') { tail = false; } continue; }
    const input = readInputLines(lines, index, directory, existence);
    updateFileStack(input.text, files, directory, existence);
    index = input.end;
  }
  for (const entry of entries) { finishEntry(entry); }
  return entries;
}

/**
 * エラー・警告の見出しを読み，折り返されたファイル名も復元する．
 * @param lines ログの物理行．
 * @param index 見出し候補の0始まりの行位置．
 * @param directory LaTeXの作業ディレクトリ．
 * @param file 見出しを読んだ時点の入力ファイル．
 * @returns 見出しと消費した最終行．見出しでなければundefined．
 */
function readHeader(lines: string[], index: number, directory: string, file: vscode.Uri): Header | undefined {
  let text = lines[index];
  let end = index;
  let filename: string | undefined;
  let line: number | undefined;
  let message: string | undefined;
  let severity = vscode.DiagnosticSeverity.Error;
  const lua = /\[(?:\\?directlua|\\?latelua)\]:\d+:[ \t]*(.*)$/.exec(text);
  if (lua && !fileLineHeader(text) && !/^\s/.test(text)) {
    message = lua[1];
  } else if (/^!\s?/.test(text)) {
    message = text.replace(/^!\s?/, '');
  } else if (/^(?:(?:LaTeX(?: Font|3)?|(?:Package|Class|Module)\s+\S+)\s+Warning:|Missing character:)/.test(text)) {
    message = text;
    severity = vscode.DiagnosticSeverity.Warning;
  } else if (/^(?:Overfull|Underfull) \\[hv]box\b/.test(text)) {
    message = text;
    severity = vscode.DiagnosticSeverity.Information;
  } else {
    let match = fileLineHeader(text);
    if (!match && /^(?:\.?\.?[\\/]|[A-Za-z]:[\\/]|"[./\\])/.test(text)) {
      while (end + 1 < lines.length && pathContinuation(lines[end + 1])) {
        text += lines[++end];
        match = fileLineHeader(text);
        if (match) { break; }
      }
    }
    if (match) { filename = match[1]; line = Number(match[2]); message = match[3]; }
  }
  if (message === undefined) { return undefined; }
  return { end, entry: {
    file: filename ? vscode.Uri.file(path.resolve(directory, filename)) : file,
    line, logLine: index, message, severity, frames: [],
    summary: /^\s*==>\s*Fatal error occurred/.test(message)
  } };
}

/**
 * 通常のファイル名付き見出しを，Luaのフレームや説明文と区別する．
 * @param text 改行を復元済みの見出し候補．
 * @returns ファイル名・行番号・本文の正規表現一致．該当しなければnull．
 */
function fileLineHeader(text: string): RegExpExecArray | null {
  if (/^\s|^\[|^\(/.test(text)) { return null; }
  const match = /^"?(.+?)"?:(\d+):[ \t]?(.*)$/.exec(text);
  if (!match || match[1].includes('->') || !/(?:[\\/]|\.[^ .\\/]+$)/.test(match[1])) { return null; }
  return match;
}

/**
 * 次の物理行をファイルパスの続きとして読むことができるか調べる．
 * @param text 次の物理行．
 * @returns 新しいメッセージや文脈の見出しを含まない非空行ならtrue．
 */
function pathContinuation(text: string): boolean {
  return text.length > 0 && !/^[\s!()]|^l\.\d+\s|^(?:LaTeX|Package|Class|Module)\s|^<|^Here is how much/.test(text);
}

/**
 * 本文全体から警告の行番号や組版警告の行範囲を補う．
 * @param entry 本文の収集を終えた診断候補．
 * @returns なし．候補の位置情報を更新する．
 */
function finishEntry(entry: LogEntry): void {
  if (entry.severity === vscode.DiagnosticSeverity.Error) { return; }
  const range = /\bat lines (\d+)--(\d+)/.exec(entry.message);
  const line = /\b(?:on (?:input )?line|at line) (\d+)/.exec(entry.message);
  if (range) { entry.line = Number(range[1]); entry.endLine = Number(range[2]); }
  else if (line) { entry.line = Number(line[1]); }
}

/**
 * 読み込み表示で折り返されたファイル名を，ファイル候補として復元する．
 * @param lines ログの物理行．
 * @param index 読み込み表示の候補行．
 * @param directory 相対ファイル名の基準ディレクトリ．
 * @param existence この解析内だけで使用する存在確認の結果．
 * @returns 読み込み表示と消費した最終行．
 */
function readInputLines(lines: string[], index: number, directory: string, existence: Map<string, boolean>): { text: string; end: number } {
  let text = lines[index];
  let end = index;
  const opening = text.lastIndexOf('(');
  if (opening < 0 || !/^"?(?:\.?\.?[\\/]|[A-Za-z]:[\\/])/.test(text.slice(opening + 1))) { return { text, end }; }
  while (!inputFilename(text.slice(opening + 1), directory, existence) && end + 1 < lines.length && pathContinuation(lines[end + 1])) {
    text += lines[++end];
  }
  return { text, end };
}

/**
 * 読み込み表示の括弧を追跡し，文字列中の括弧とファイルの入れ子を区別する．
 * @param text 読み込み表示を含むログ行．
 * @param stack 現在開かれているファイルと通常の括弧のスタック．
 * @param directory 相対パスの基準ディレクトリ．
 * @param existence この解析内だけで使用する存在確認の結果．
 * @returns なし．スタックを更新する．
 */
function updateFileStack(text: string, stack: (vscode.Uri | undefined)[], directory: string, existence: Map<string, boolean>): void {
  for (let index = 0; index < text.length; index++) {
    if (text[index] === ')') { stack.pop(); }
    else if (text[index] === '(') {
      const filename = inputFilename(text.slice(index + 1), directory, existence);
      stack.push(filename ? vscode.Uri.file(path.resolve(directory, filename.name)) : undefined);
      if (filename) { index += filename.length; }
    }
  }
}

/**
 * 読み込み表示からファイル名を取り出し，空白・括弧を含む実在パスを優先する．
 * @param text 開き括弧の直後からの文字列．
 * @param directory 相対パスの基準ディレクトリ．
 * @param existence この解析内の存在確認キャッシュ．
 * @returns ファイル名と表示上の長さ．識別できなければundefined．
 */
function inputFilename(text: string, directory: string, existence: Map<string, boolean>): { name: string; length: number } | undefined {
  if (text.startsWith('"')) {
    const end = text.indexOf('"', 1);
    if (end > 1) { return { name: text.slice(1, end), length: end + 1 }; }
  }
  const ends = [text.length];
  for (let index = text.length - 1; index > 0; index--) {
    if (/[\s()[\]]/.test(text[index])) { ends.push(index); }
  }
  for (const end of ends) {
    const name = text.slice(0, end);
    if (!/(?:[\\/]|\.[^ .\\/]+$)/.test(name)) { continue; }
    const absolute = path.resolve(directory, name);
    if (!existence.has(absolute)) {
      try { existence.set(absolute, fs.statSync(absolute).isFile()); }
      catch { existence.set(absolute, false); }
    }
    if (existence.get(absolute)) { return { name, length: end }; }
  }
  const fallback = /^((?:\.?\.?[\\/]|[A-Za-z]:[\\/])?[^\s()[\]]+\.[A-Za-z0-9]+)(?=[\s()[\]]|$)/.exec(text);
  return fallback ? { name: fallback[1], length: fallback[1].length } : undefined;
}

/**
 * 正確なURIを優先し，実パスの別名も含めて開いた文書を探す．
 * @param uri ログが示す対象ファイル．
 * @returns 対応する開いた文書．見つからなければundefined．
 */
function findErrorDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  const document = Workspace.findOpenDocument(uri);
  if (document || uri.scheme !== 'file') { return document; }
  let realPathKey: string;
  try { realPathKey = Workspace.uriKey(vscode.Uri.file(fs.realpathSync(uri.fsPath))); }
  catch { return undefined; }
  const active = vscode.window.activeTextEditor?.document;
  const candidates = active ? [active, ...vscode.workspace.textDocuments] : vscode.workspace.textDocuments;
  for (const candidate of candidates) {
    if (candidate.isClosed || candidate.uri.scheme !== 'file') { continue; }
    try {
      if (Workspace.uriKey(vscode.Uri.file(fs.realpathSync(candidate.uri.fsPath))) === realPathKey) { return candidate; }
    } catch {
      // 無関係な新規・削除済みバッファで解析を中断しない．
    }
  }
  return undefined;
}

/**
 * 開いた文書を優先して，この解析で照合するソースの内容を取得する．
 * @param uri ログが示すソースファイル．
 * @returns 表示先URIとソースの行配列．読めなければundefined．
 */
async function readSource(uri: vscode.Uri): Promise<Source | undefined> {
  const document = findErrorDocument(uri);
  if (document) { return { uri: document.uri, lines: document.getText().split(/\r?\n/) }; }
  try {
    return { uri, lines: Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8').split(/\r?\n/) };
  } catch { return undefined; }
}

/**
 * 0始まりの行または行範囲を，全体を指す診断範囲へ変換する．
 * @param start 最初の行．
 * @param end 最後の行．省略時は同じ行．
 * @returns 行末までを含むVS Codeの範囲．
 */
function wholeLine(start: number, end = start): vscode.Range {
  return new vscode.Range(start, 0, end, Number.MAX_SAFE_INTEGER);
}

/**
 * 参照キーまたはソース文脈が示す境界から，強調する範囲をすべて求める．
 * @param entry 有効なソース行を持つ診断候補．
 * @param source 照合する文書の内容．読めなければundefined．
 * @returns 一致する参照キー，原因トークン，または報告行全体の範囲を含む空でない配列．
 */
function sourceRanges(entry: LogEntry, source: Source | undefined): vscode.Range[] {
  const line = entry.line! - 1;
  const end = validLine(entry.endLine) && entry.endLine >= entry.line! ? entry.endLine - 1 : line;
  const text = source?.lines[line];
  if (text === undefined || end !== line) { return [wholeLine(line, end)]; }
  const references = referenceRanges(entry, text, line);
  if (references.length) { return references; }
  const context = entry.context;
  if (context && context.line === entry.line) {
    const boundary = contextBoundary(text, context);
    if (boundary !== undefined) {
      const before = text.slice(0, boundary);
      let token: RegExpExecArray | null = null;
      if (/^Double subscript/.test(entry.message)) { token = /(_)[ \t]*$/.exec(before); }
      else if (/^Double superscript/.test(entry.message)) { token = /(\^)[ \t]*$/.exec(before); }
      if (!token && (/^Undefined control sequence/.test(entry.message) || entry.frames.some(frame => frame.includes('->')))) {
        token = /(\\(?:[\p{L}\p{N}@:_]+|[^\s]))[ \t]*$/u.exec(before);
      }
      if (token) { return [new vscode.Range(line, token.index, line, token.index + token[1].length)]; }
    }
  }
  return [new vscode.Range(line, 0, line, text.length)];
}

/**
 * 報告行だけを解析し，未定義参照の警告に一致する参照キーの範囲をすべて求める．
 * @param entry キーと報告行を含む警告候補．
 * @param text 警告が報告するソース行の本文．改行を含まない．
 * @param line 警告が報告する0始まりの行番号．
 * @returns ref・eqref・pagerefの一致するキーの範囲．対応しない警告や一致がない場合は空配列．
 */
function referenceRanges(entry: LogEntry, text: string, line: number): vscode.Range[] {
  if (entry.severity !== vscode.DiagnosticSeverity.Warning) { return []; }
  const warning = /^LaTeX Warning: Reference [`'](.*)' on page .+ undefined on input line \d+\.$/s.exec(entry.message.trim());
  if (!warning) { return []; }
  const ranges: vscode.Range[] = [];
  for (const token of new ReferenceParser(text).tokens) {
    if (token.kind !== 'reference' || !referenceCommands.has(token.command) || token.key !== warning[1]) { continue; }
    ranges.push(new vscode.Range(line, token.keyStart, line, token.keyEnd));
  }
  return ranges;
}

/**
 * ログの読み取り済み・未読の両断片を同じソース行に照合する．
 * @param text ソースの対象行．
 * @param context ログに表示された2行のソース文脈．
 * @returns 一意に決まった境界のUTF-16位置．一致しない・曖昧な場合はundefined．
 */
function contextBoundary(text: string, context: SourceContext): number | undefined {
  let before = context.before.replace(/\u{FFFFF}/gu, '').trimEnd();
  let after = context.after.replace(/\u{FFFFF}/gu, '').trim();
  const croppedBefore = before.startsWith('...');
  const croppedAfter = after.endsWith('...');
  if (croppedBefore) { before = before.slice(3); }
  if (croppedAfter) { after = after.slice(0, -3); }
  if (!before && !after) { return undefined; }
  const pattern = `${croppedBefore ? '' : '^'}(?=(${snippetPattern(before)})[ \\t]*${snippetPattern(after)}${croppedAfter ? '' : '$'})`;
  const boundaries = new Set<number>();
  for (const match of text.matchAll(new RegExp(pattern, 'g'))) { boundaries.add(match.index! + match[1].length); }
  return boundaries.size === 1 ? [...boundaries][0] : undefined;
}

/**
 * ソースの断片を，空白の表現差を許す正規表現へ変換する．
 * @param text 表示用の省略記号などを除いた断片．
 * @returns 正規表現へ埋め込める文字列．
 */
function snippetPattern(text: string): string {
  return text.split(/([ \t]+)/).map(part => /^[ \t]+$/.test(part) ? '[ \\t]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
}

/**
 * 未定義命令と展開の文脈を補い，Problemsに表示する本文を作る．
 * @param entry 解析済みの診断候補．
 * @returns 元の説明と，取得できた命令名・展開情報を含む本文．
 */
function entryMessage(entry: LogEntry): string {
  let message = entry.message.trim();
  if (/^Undefined control sequence\.?$/.test(message)) {
    const frame = entry.frames[0]?.replace(/^.*?->|^<[^>]+>\s*/, '') ?? entry.context?.before ?? '';
    const command = /(\\(?:[\p{L}\p{N}@:_]+|[^\s]))[ \t]*$/u.exec(frame);
    if (command) { message = `Undefined control sequence: ${command[1]}.`; }
  }
  if (entry.frames.some(frame => frame.includes('->'))) { message += '\n' + entry.frames.join('\n'); }
  return message;
}
