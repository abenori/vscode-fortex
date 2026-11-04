import LaTeXSource from './LaTeXSource';
import { readCommand } from './SourceScanner';
import type { CommandToken, SourceRange } from './SourceScanner';

/** 展開前の置換本文を，元の不変ソース内の範囲として保持する． */
export type MacroBinding =
  | {
    /** この項目がreplacementであることを表す識別値． */
    readonly kind: 'replacement';
    /** マクロの置換本文を保持する元の不変LaTeXソース． */
    readonly source: LaTeXSource;
    /** 元の不変ソース内にある，マクロの置換本文の範囲． */
    readonly body: SourceRange
  }
  | {
    /** この項目がopaqueであることを表す識別値． */
    readonly kind: 'opaque'
  };

export type MacroLookup = (name: string) => MacroBinding | undefined;

export type InputToken = CommandToken & {
  /** 対象の名前． */
  readonly name: 'input' | 'include'
};

export type FilenameResult =
  | {
    /** この項目がresolvedであることを表す識別値． */
    readonly status: 'resolved';
    /** マクロ展開と引用符の処理を終えた入力ファイル名． */
    readonly filename: string;
    /** 完全に読み取った部分の直後を表すUTF-16位置． */
    readonly consumedEnd: number
  }
  | {
    /** この項目がunresolvedであることを表す識別値． */
    readonly status: 'unresolved';
    /** 入力を解決できなかった理由を識別する文字列． */
    readonly reason: string;
    /** 完全に読み取った部分の直後を表すUTF-16位置． */
    readonly consumedEnd: number
  };

interface FilenameToken {
  /** この項目の種別を表す識別値． */
  readonly kind: 'character' | 'space' | 'command' | 'invalid';
  /** トークンまたは解析項目が保持する値． */
  readonly value: string;
}

const maxExpandedTokens = 100000;
const maxExpansionDepth = 64;
const replacementTokens = new WeakMap<MacroBinding, readonly FilenameToken[]>();

/**
 * ファイル名と置換本文用の簡易的なTeX字句解析．展開より先にトークン化し，ソース中の連続空白はまとめるが，別のマクロから現れた空白はまとめない．
 *
 * @param source 解析または読み取りの対象となるソース本文．
 * @param start 対象範囲の開始位置．UTF-16単位で，範囲に含む．
 * @param end 対象範囲の終端位置．UTF-16単位で，範囲に含まない．
 * @returns 文字・空白・コマンド・不正トークンを元の順序で列挙するGenerator．
 */
function* tokenize(source: string, start: number, end: number): Generator<FilenameToken> {
  let state: 'mid' | 'skip' | 'new' = 'mid';
  for (let cursor = start; cursor < end;) {
    const position = cursor;
    const character = source[cursor];
    if (character === '%') {
      while (cursor < end && source[cursor] !== '\r' && source[cursor] !== '\n') { cursor++; }
      if (source[cursor] === '\r') { cursor++; }
      if (source[cursor] === '\n') { cursor++; }
      state = 'new';
      continue;
    }
    if (character === '\r' || character === '\n') {
      cursor++;
      if (character === '\r' && source[cursor] === '\n') { cursor++; }
      const previous = state;
      state = 'new';
      if (previous === 'new') { yield { kind: 'invalid', value: 'paragraph' }; }
      else if (previous === 'mid') { yield { kind: 'space', value: ' ' }; }
      continue;
    }
    if (character === ' ' || character === '\t') {
      cursor++;
      if (state === 'mid') {
        state = 'skip';
        yield { kind: 'space', value: ' ' };
      }
      continue;
    }
    if (character === '\\') {
      const command = readCommand(source, cursor);
      if (!command || command.end > end || !command.name) {
        cursor++;
        yield { kind: 'invalid', value: 'incomplete-command' };
        continue;
      }
      cursor = command.end;
      state = /^[A-Za-z@]+$/.test(command.name) ? 'skip' : 'mid';
      yield { kind: 'command', value: command.name };
      continue;
    }
    cursor += (source.codePointAt(cursor) ?? 0) > 0xffff ? 2 : 1;
    state = 'mid';
    yield { kind: /[{}#$]/.test(character) ? 'invalid' : 'character',
      value: source.slice(position, cursor) };
  }
}

/**
 * 波括弧内のファイル名を読み取る．ファイルシステムへのアクセスはresolveInputFileで行う．
 * @param source 読み取りと範囲の基準となる共有LaTeXソース．
 * @param command 実行または解析するコマンド．
 * @param macros 現在位置で有効なマクロ定義を名前から引く関数．省略可能．
 * @returns 展開したファイル名または解決できない理由と，読み取り済み部分の終端．
 */
export function readInputFilename(source: LaTeXSource, command: InputToken, macros?: MacroLookup): FilenameResult {
  const group = source.argumentScanner.readArgument(command.end);
  const consumedEnd = group?.end ?? command.end;
  const fail = (reason: string): FilenameResult => ({ status: 'unresolved', reason, consumedEnd });
  if (!group) { return fail('missing-argument'); }
  if (!group.complete) { return fail('incomplete-argument'); }
  let count = 0;
  let quoted = false;
  let filename = '';
  let failure: string | undefined;
  const active = new Set<string>();
  /**
   * 引数なしのマクロの置換本文を再帰的に展開する．
   * @param token 元ソース中の対象トークンとその範囲．
   * @param depth 現在のマクロ展開の深さ．
   * @returns 展開後のファイル名トークンを順に列挙するGenerator．
   */
  function* expand(token: FilenameToken, depth: number): Generator<FilenameToken> {
    if (++count > maxExpandedTokens) { failure = 'expansion-limit'; return; }
    if (token.kind !== 'command' || !macros) { yield token; return; }
    const binding = macros(token.value);
    if (!binding) { yield token; return; }
    if (binding.kind !== 'replacement') { failure = 'unsupported-macro'; return; }
    if (active.has(token.value)) { failure = 'cyclic-expansion'; return; }
    if (depth >= maxExpansionDepth) { failure = 'expansion-limit'; return; }
    let tokens = replacementTokens.get(binding);
    if (!tokens) {
      tokens = [...tokenize(binding.source.source, binding.body.start, binding.body.end)];
      replacementTokens.set(binding, tokens);
    }
    active.add(token.value);
    for (const replacement of tokens) {
      yield* expand(replacement, depth + 1);
      if (failure) { break; }
    }
    active.delete(token.value);
  }
  for (const root of tokenize(source.source, group.contentStart, group.contentEnd)) {
    for (const token of expand(root, 0)) {
      if (token.kind === 'invalid') {
        return fail('invalid-filename');
      }
      if (token.kind === 'command') {
        return fail(macros ? 'undefined-macro' : 'macro-expansion-disabled');
      }
      if (token.value === '"') { quoted = !quoted; continue; }
      filename += token.value;
    }
    if (failure) { return fail(failure); }
  }
  if (quoted) { return fail('unclosed-quote'); }
  filename = filename.replace(/^ +/, '');
  // LaTeXは，拡張子のないファイル名の末尾の空白を保持する．
  if (/\.[^/]*$/.test(filename)) { filename = filename.replace(/ +$/, ''); }
  if (!filename) { return fail('empty-filename'); }
  return { status: 'resolved', filename, consumedEnd };
}

