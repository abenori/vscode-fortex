import * as assert from 'assert';
import { GREEK_ENTRIES, findGreekCandidates, findGreekPreview } from '../completion/greek/GreekCatalog';

suite('YaTeX Greek catalog', () => {
  test('contains 44 unique abbreviations for 40 standard commands', () => {
    assert.strictEqual(GREEK_ENTRIES.length, 44);
    assert.strictEqual(new Set(GREEK_ENTRIES.map(entry => entry.code)).size, 44);
    assert.strictEqual(new Set(GREEK_ENTRIES.map(entry => entry.command)).size, 40);
    assert.ok(GREEK_ENTRIES.every(entry => /^\\[A-Za-z]+$/.test(entry.command)));
  });

  test('updates previews while retaining longer continuations', () => {
    assert.deepStrictEqual(findGreekCandidates('p').map(entry => entry.code), ['p', 'p-', 'ph', 'ph-', 'ps']);
    assert.deepStrictEqual(findGreekCandidates('ph').map(entry => entry.code), ['ph', 'ph-']);
    for (const [code, command] of [
      ['p', '\\pi'], ['ph', '\\phi'], ['ph-', '\\varphi'], ['ps', '\\psi'],
      ['t', '\\tau'], ['th', '\\theta'], ['e', '\\epsilon'], ['et', '\\eta']
    ]) {
      assert.strictEqual(findGreekPreview(code)?.command, command, code);
    }
    // `th` occurs before `t` in YaTeX's table, so a prefix-only lookup is wrong.
    assert.deepStrictEqual(findGreekCandidates('t').map(entry => entry.code), ['th', 'th-', 't']);
  });

  test('offers a preview for an incomplete uppercase abbreviation', () => {
    assert.deepStrictEqual(findGreekPreview('T'), { code: 'Th', command: '\\Theta' });
    assert.strictEqual(findGreekPreview('Th')?.command, '\\Theta');
    assert.deepStrictEqual(findGreekCandidates('P').map(entry => entry.code), ['P', 'Ph', 'Ps']);
    assert.strictEqual(findGreekPreview('P')?.command, '\\Pi');
    assert.strictEqual(findGreekPreview('Ph')?.command, '\\Phi');
    assert.strictEqual(findGreekPreview('Ps')?.command, '\\Psi');
  });

  test('preserves the six variant letters and four aliases', () => {
    for (const [code, command] of [
      ['e-', '\\varepsilon'], ['th-', '\\vartheta'], ['p-', '\\varpi'],
      ['r-', '\\varrho'], ['s-', '\\varsigma'], ['ph-', '\\varphi']
    ]) {
      assert.strictEqual(findGreekPreview(code)?.command, command, code);
      assert.strictEqual(findGreekCandidates(code).length, 1, code);
    }
    for (const [first, second, command] of [
      ['u', 'y', '\\upsilon'], ['U', 'Y', '\\Upsilon'],
      ['o', 'w', '\\omega'], ['O', 'W', '\\Omega']
    ]) {
      assert.strictEqual(findGreekPreview(first)?.command, command, first);
      assert.strictEqual(findGreekPreview(second)?.command, command, second);
    }
  });

  test('keeps uppercase and lowercase inputs separate', () => {
    for (const [lower, upper, lowerCommand, upperCommand] of [
      ['g', 'G', '\\gamma', '\\Gamma'], ['d', 'D', '\\delta', '\\Delta'],
      ['l', 'L', '\\lambda', '\\Lambda'], ['x', 'X', '\\xi', '\\Xi'],
      ['s', 'S', '\\sigma', '\\Sigma']
    ]) {
      assert.strictEqual(findGreekPreview(lower)?.command, lowerCommand);
      assert.strictEqual(findGreekPreview(upper)?.command, upperCommand);
    }
    for (const code of ['A', 'B', 'TH', 'PH', 'pH', 'PS']) {
      assert.deepStrictEqual(findGreekCandidates(code), [], code);
      assert.strictEqual(findGreekPreview(code), undefined, code);
    }
  });

  test('has no initial preview and rejects unsupported sequences', () => {
    assert.deepStrictEqual(findGreekCandidates(''), GREEK_ENTRIES);
    assert.strictEqual(findGreekPreview(''), undefined);
    for (const code of ['q', 'f', 'foo', 'G-', 'Ph-', 'ph--', '-', ' ', '\\alpha']) {
      assert.deepStrictEqual(findGreekCandidates(code), [], code);
      assert.strictEqual(findGreekPreview(code), undefined, code);
    }
  });
});
