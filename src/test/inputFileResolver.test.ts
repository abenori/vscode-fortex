import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import LaTeXSource from '../latex-parser/LaTeXSource';
import { readInputFilename } from '../latex-parser/InputFilename';
import type { InputToken } from '../latex-parser/InputFilename';
import { resolveInputFile } from '../project/InputFileResolver';
import { MacroState } from '../project/InputMacros';

async function withFiles(names: readonly string[], run: (directory: vscode.Uri) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fortex-input-resolver-'));
  try {
    for (const name of names) {
      const file = path.join(directory, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, '');
    }
    await run(vscode.Uri.file(directory));
  } finally {
    assert.strictEqual(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('fortex-input-resolver-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function input(source: LaTeXSource): InputToken {
  const command = source.sourceScanner.commands.filter(item => item.name === 'input' || item.name === 'include').at(-1);
  assert.ok(command);
  return command as InputToken;
}

function macrosBeforeInput(source: LaTeXSource): MacroState {
  const state = new MacroState();
  const command = input(source);
  for (const definition of source.definitionParser.definitions) {
    if (definition.end <= command.start) { state.apply(source, definition); }
  }
  return state;
}

suite('Input filename resolution', () => {
  test('shares braced quoting, TeX source whitespace and comment rules', async () => {
    await withFiles(['with space.tex', 'withspace.tex', 'with space .tex'], async directory => {
      const examples: [string, string][] = [
        [String.raw`\input{with space}`, 'with space.tex'],
        [String.raw`\input{"with space"}`, 'with space.tex'],
        [String.raw`\input {"with space"}`, 'with space.tex'],
        [String.raw`\include{"with space"}`, 'with space.tex'],
        ['\\input % comment\r\n { with  space}', 'with space.tex'],
        ['\\input{with\r\n    space}', 'with space.tex'],
        ['\\input{with% comment\r\n    space}', 'withspace.tex'],
        [String.raw`\input{with space }`, 'with space .tex'],
        [String.raw`\input{with space.tex }`, 'with space.tex']
      ];
      for (const [text, expected] of examples) {
        const source = new LaTeXSource(text);
        const result = await resolveInputFile(source, input(source), directory);
        assert.strictEqual(result.status, 'resolved', text);
        if (result.status === 'resolved') { assert.strictEqual(path.basename(result.uri.fsPath), expected, text); }
      }
    });
  });

  test('prefers .tex for unknown extensions while preserving known input extensions', async () => {
    await withFiles(['x.foo', 'x.foo.tex', 'x.tex', 'x.tex.tex', 'x.sty', 'x.sty.tex'], async directory => {
      for (const [text, expected] of [
        [String.raw`\input{x.foo}`, 'x.foo.tex'],
        [String.raw`\include{x.foo}`, 'x.foo.tex'],
        [String.raw`\input{x.tex}`, 'x.tex'],
        [String.raw`\include{x.tex}`, 'x.tex'],
        [String.raw`\input{x.sty}`, 'x.sty'],
        [String.raw`\include{x.sty}`, 'x.sty.tex']
      ]) {
        const source = new LaTeXSource(text);
        const result = await resolveInputFile(source, input(source), directory);
        assert.strictEqual(result.status, 'resolved', text);
        if (result.status === 'resolved') { assert.strictEqual(path.basename(result.uri.fsPath), expected); }
      }
    });
  });

  test('retains missing priority candidates and limits include to its .tex candidate', async () => {
    await withFiles(['x.foo', 'x.tex.tex', 'x.sty.tex'], async directory => {
      const source = new LaTeXSource(String.raw`\input{x.foo}`);
      const result = await resolveInputFile(source, input(source), directory);
      assert.strictEqual(result.status, 'resolved');
      assert.deepStrictEqual(result.checkedCandidates.map(item => [path.basename(item.uri.fsPath), item.exists]), [
        ['x.foo.tex', false], ['x.foo', true]
      ]);
      for (const text of [String.raw`\include{x.foo}`, String.raw`\input{x.tex}`, String.raw`\input{x.sty}`]) {
        const syntax = new LaTeXSource(text);
        const missing = await resolveInputFile(syntax, input(syntax), directory);
        assert.strictEqual(missing.status, 'missing', text);
        assert.strictEqual(missing.checkedCandidates.length, 1, text);
      }
    });
  });

  test('expands supported definitions only when explicitly given a macro lookup', async () => {
    await withFiles(['mydir/x.tex'], async directory => {
      const source = new LaTeXSource(String.raw`\newcommand{\base}{mydir}\newcommand{\dir}{\base}\input{\dir /x.tex}`);
      const state = macrosBeforeInput(source);
      const literal = await resolveInputFile(source, input(source), directory);
      assert.strictEqual(literal.status, 'unresolved');
      assert.deepStrictEqual(literal.checkedCandidates, []);
      const expanded = await resolveInputFile(source, input(source), directory, name => state.lookup(name));
      assert.strictEqual(expanded.status, 'resolved');
      if (expanded.status === 'resolved') { assert.strictEqual(expanded.uri.fsPath, path.join(directory.fsPath, 'mydir/x.tex')); }
    });
  });

  test('preserves separate expanded spaces and quoted macros inside braces', async () => {
    await withFiles(['a  b.tex', 'with space.tex', 'mydir/x.tex'], async directory => {
      const examples: [string, string][] = [
        [String.raw`\newcommand{\pathleft}{a }\newcommand{\pathright}{ b}\input{\pathleft\pathright}`, 'a  b.tex'],
        [String.raw`\newcommand{\file}{"with space"}\input{\file}`, 'with space.tex'],
        [String.raw`\newcommand{\file}{with space}\input{\file}`, 'with space.tex'],
        [String.raw`\newcommand{\dir}{mydir}\input{\dir /x.tex}`, 'x.tex']
      ];
      for (const [text, expected] of examples) {
        const source = new LaTeXSource(text);
        const state = macrosBeforeInput(source);
        const result = await resolveInputFile(source, input(source), directory, name => state.lookup(name));
        assert.strictEqual(result.status, 'resolved', text);
        if (result.status === 'resolved') { assert.strictEqual(path.basename(result.uri.fsPath), expected, text); }
      }
    });
  });

  test('rejects incomplete syntax, unknown and cyclic expansion without probing files', async () => {
    await withFiles([], async directory => {
      for (const text of [String.raw`\input{x`, String.raw`\input{"x}`, String.raw`\input{\unknown}`,
        String.raw`\newcommand{\dir}{\dir}\input{\dir}`,
        String.raw`\newcommand{\dir}{\dir\dir}\input{\dir}`]) {
        const source = new LaTeXSource(text);
        const state = macrosBeforeInput(source);
        const result = await resolveInputFile(source, input(source), directory, name => state.lookup(name));
        assert.strictEqual(result.status, 'unresolved', text);
        assert.deepStrictEqual(result.checkedCandidates, [], text);
      }
    });
  });

  test('returns original source boundaries for braced arguments', () => {
    for (const text of [String.raw`\input{"with space"} \section{x}`, String.raw`\input{with space}\section{x}`]) {
      const source = new LaTeXSource(text);
      const result = readInputFilename(source, input(source));
      assert.strictEqual(result.status, 'resolved');
      assert.strictEqual(result.consumedEnd, text.indexOf(' \\section') >= 0 ? text.indexOf(' \\section') : text.indexOf('\\section'));
    }
  });

  test('rejects unbraced filenames without expanding macros or checking files', async () => {
    await withFiles(['x.tex', 'with space.tex'], async directory => {
      for (const text of [String.raw`\input x.tex`, String.raw`\input "with space"`,
        String.raw`\input\file`, String.raw`\include x.tex`]) {
        const source = new LaTeXSource(text);
        const command = input(source);
        const result = await resolveInputFile(source, command, directory,
          () => assert.fail('Unbraced arguments must not request macro expansion'));
        assert.deepStrictEqual(result, { status: 'unresolved', reason: 'missing-argument',
          consumedEnd: command.end, checkedCandidates: [] });
      }
    });
  });
});

suite('Input macro state', () => {
  test('respects providecommand, redefinitions and unsupported shadowing', () => {
    const source = new LaTeXSource(String.raw`\newcommand{\dir}{a}\providecommand{\dir}{b}\renewcommand{\dir}{c}\renewcommand{\dir}[1]{#1}\input{\dir}`);
    const state = new MacroState();
    const values: string[] = [];
    for (const definition of source.definitionParser.definitions) {
      state.apply(source, definition);
      const binding = state.lookup('dir');
      values.push(binding?.kind === 'replacement' ? binding.source.source.slice(binding.body.start, binding.body.end) : 'opaque');
    }
    assert.deepStrictEqual(values, ['a', 'a', 'c', 'opaque']);
  });

  test('distinguishes simple primitive definitions from delimited or eager definitions', () => {
    for (const [text, expected] of [
      [String.raw`\def\dir{a}`, 'replacement'],
      [String.raw`\def\dir prefix{a}`, 'opaque'],
      [String.raw`\edef\dir{a}`, 'opaque'],
      [String.raw`\DeclareRobustCommand{\dir}{a}`, 'opaque']
    ]) {
      const source = new LaTeXSource(text);
      const state = new MacroState();
      state.apply(source, source.definitionParser.definitions[0]);
      assert.strictEqual(state.lookup('dir')?.kind, expected, text);
    }
  });

  test('restores local definitions but retains global assignments through nested groups', () => {
    const source = new LaTeXSource(String.raw`\def\dir{a}\def\dir{b}\gdef\dir{c}`);
    const state = new MacroState();
    const definitions = source.definitionParser.definitions;
    state.apply(source, definitions[0]);
    state.pushScope();
    state.apply(source, definitions[1]);
    state.popScope();
    assert.deepStrictEqual(state.lookup('dir'), { kind: 'replacement', source, body: definitions[0].bodyRanges[0] });
    state.pushScope();
    state.apply(source, definitions[1]);
    state.pushScope();
    state.apply(source, definitions[2]);
    state.popScope();
    state.popScope();
    assert.deepStrictEqual(state.lookup('dir'), { kind: 'replacement', source, body: definitions[2].bodyRanges[0] });
  });
});
