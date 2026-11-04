import * as assert from 'assert';
import * as LaTeXParser from '../latex-parser';

suite('Shared LaTeX source', () => {
  test('defers argument indexing and parser queries until requested', () => {
    const scanner = new LaTeXParser.SourceScanner(String.raw`\newcommand{\dir}{chapters}\usepackage{amsmath}\label{key}\begin{a}\end{a}`);
    const commands = scanner.commands;
    let commandReads = 0;
    Object.defineProperty(scanner, 'commands', {
      get: () => { commandReads++; return commands; }
    });

    const syntax = new LaTeXParser.LaTeXSource(scanner);
    assert.strictEqual(syntax.sourceScanner, scanner);
    assert.strictEqual(syntax.source, scanner.source);
    assert.strictEqual(commandReads, 0);

    const argumentsScanner = syntax.argumentScanner;
    assert.ok(commandReads > 0);
    const indexedReads = commandReads;
    assert.strictEqual(syntax.argumentScanner, argumentsScanner);
    assert.strictEqual(commandReads, indexedReads);

    let argumentReads = 0;
    const readArgument = argumentsScanner.readArgument.bind(argumentsScanner);
    argumentsScanner.readArgument = (...args) => {
      argumentReads++;
      return readArgument(...args);
    };
    const definitions = syntax.definitionParser;
    assert.strictEqual(definitions.definitions[0].name, 'dir');
    assert.ok(argumentReads > 0);
    const definitionReads = argumentReads;
    assert.strictEqual(syntax.definitionParser, definitions);
    assert.strictEqual(argumentReads, definitionReads);

    const document = syntax.documentParser;
    assert.strictEqual(document.declarations[0].argument?.raw, 'amsmath');
    assert.ok(argumentReads > definitionReads);
    const documentReads = argumentReads;
    assert.strictEqual(syntax.documentParser, document);
    assert.strictEqual(argumentReads, documentReads);

    const references = syntax.referenceParser;
    assert.strictEqual(references.tokens[0].key, 'key');
    assert.ok(argumentReads > documentReads);
    const referenceReads = argumentReads;
    assert.strictEqual(syntax.referenceParser, references);
    assert.strictEqual(argumentReads, referenceReads);

    syntax.createEnvironmentParser();
    assert.ok(argumentReads > referenceReads);
  });

  test('creates independent environment results for each requested configuration', () => {
    const syntax = new LaTeXParser.LaTeXSource(String.raw`\begin{a}$ unfinished \[x\]\end{a}`);
    const all = syntax.createEnvironmentParser();
    const selected = syntax.createEnvironmentParser([], ['named', 'display']);
    assert.deepStrictEqual(all.unclosed.map(token => token.name), ['a', '$']);
    assert.deepStrictEqual(selected.pairs.map(pair => pair.begin.name), ['\\[', 'a']);
    assert.notStrictEqual(syntax.createEnvironmentParser([], ['named', 'display']), selected);
    assert.deepStrictEqual(syntax.createEnvironmentParser([], []).tokens, []);
  });
});
