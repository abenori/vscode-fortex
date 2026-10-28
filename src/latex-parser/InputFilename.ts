import LaTeXSource from './LaTeXSource';
import { readCommand } from './SourceScanner';
import type { CommandToken, SourceRange } from './SourceScanner';

/** Replacement text is kept in its original immutable source, before expansion. */
export type MacroBinding =
  | { readonly kind: 'replacement'; readonly source: LaTeXSource; readonly body: SourceRange }
  | { readonly kind: 'opaque' };

export type MacroLookup = (name: string) => MacroBinding | undefined;

export type InputToken = CommandToken & { readonly name: 'input' | 'include' };

export type FilenameResult =
  | { readonly status: 'resolved'; readonly filename: string; readonly consumedEnd: number }
  | { readonly status: 'unresolved'; readonly reason: string; readonly consumedEnd: number };

interface FilenameToken {
  readonly kind: 'character' | 'space' | 'command' | 'invalid';
  readonly value: string;
}

const maxExpandedTokens = 100000;
const maxExpansionDepth = 64;
const replacementTokens = new WeakMap<MacroBinding, readonly FilenameToken[]>();

/**
 * A small TeX mouth for filenames and replacement text. Tokenization precedes
 * expansion: source spaces collapse, but spaces from separate macros do not.
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

/** Reads a braced filename; filesystem access belongs to resolveInputFile. */
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
  // LaTeX preserves the final space of an extensionless base name.
  if (/\.[^/]*$/.test(filename)) { filename = filename.replace(/ +$/, ''); }
  if (!filename) { return fail('empty-filename'); }
  return { status: 'resolved', filename, consumedEnd };
}

