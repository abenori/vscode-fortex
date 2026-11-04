import * as assert from 'assert';
import { findDocumentationQuery } from '../documentation/DocumentationContext';

function queryAtCursor(source: string): string | undefined {
  const offset = source.indexOf('|');
  assert.notStrictEqual(offset, -1, 'A cursor marker is required');
  return findDocumentationQuery(source.slice(0, offset) + source.slice(offset + 1), offset);
}

suite('Documentation query context', () => {
  test('uses shared comment continuation and keeps literals from becoming package names', () => {
    assert.strictEqual(queryAtCursor('\\usepackage{ams% comment\r\nma|th}'), 'amsmath');
    assert.strictEqual(queryAtCursor('\\usepackage{ams|\\verb+text+}'), undefined);
    assert.strictEqual(queryAtCursor('\\begin{LVerbatim*}\\usepackage{ams|math}\\end{LVerbatim*}'), undefined);
    assert.strictEqual(queryAtCursor('\\documentclass{arti|cle}[unfinished'), 'article');
  });

  test('recognizes package and class declarations, including optional arguments', () => {
    for (const command of ['usepackage', 'RequirePackage', 'documentclass']) {
      assert.strictEqual(queryAtCursor(`\\${command}[option={]}]{ams|math}`), 'amsmath');
      assert.strictEqual(queryAtCursor(`\\${command.slice(0, 3)}|${command.slice(3)}{amsmath}`), 'amsmath');
    }
    assert.strictEqual(queryAtCursor('\\documentclass[12|pt]{article}'), 'article');
    assert.strictEqual(queryAtCursor('\\usepackage{my-package.v2|}'), 'my-package.v2');
  });

  test('selects the package containing the cursor without guessing from the command', () => {
    assert.strictEqual(queryAtCursor('\\usepackage{ams|math,amssymb}'), 'amsmath');
    assert.strictEqual(queryAtCursor('\\usepackage{amsmath,amss|ymb}'), 'amssymb');
    assert.strictEqual(queryAtCursor('\\usepackage{amsmath|,amssymb}'), 'amsmath');
    assert.strictEqual(queryAtCursor('\\usepackage{amsmath,|amssymb}'), 'amssymb');
    assert.strictEqual(queryAtCursor('\\usepackage{amsmath,  | amssymb  }'), 'amssymb');
    assert.strictEqual(queryAtCursor('\\usepackage{amsmath,amssymb|}'), 'amssymb');
    assert.strictEqual(queryAtCursor('\\usepack|age{amsmath,amssymb}'), undefined);
    assert.strictEqual(queryAtCursor('\\usepackage|{amsmath,amssymb}'), undefined);
    assert.strictEqual(queryAtCursor('\\usepackage{amsmath,|,amssymb}'), undefined);
  });

  test('keeps nested macro arguments together while selecting later literal names', () => {
    for (const command of ['usepackage', 'RequirePackage', 'documentclass']) {
      assert.strictEqual(queryAtCursor(`\\${command}{\\choose{a,b|,c},amsmath}`), undefined);
      assert.strictEqual(queryAtCursor(`\\${command}{\\choose{a,\\nested{x,y|,z},c},amsmath}`), undefined);
      assert.strictEqual(queryAtCursor(`\\${command}{\\choose{a,b,c},|amsmath}`), 'amsmath');
      assert.strictEqual(queryAtCursor(`\\${command}{amsmath|,\\choose{a,b,c}}`), 'amsmath');
      assert.strictEqual(queryAtCursor(`日本語😀\r\n\\${command}{\\choose{a,% ignored comma and brace , }\r\n\\nested{x,y,z},c},\r\namss|ymb}`), 'amssymb');
    }
  });

  test('preserves offsets across multiline arguments, comments, and Unicode text', () => {
    assert.strictEqual(queryAtCursor('日本語\r\n\\usepackage % declaration\r\n [options]\r\n {amsmath,% another package\r\n   amss|ymb\r\n}'), 'amssymb');
    assert.strictEqual(queryAtCursor('\\usepackage{amsmath,% amss|ymb\n amssymb}'), undefined);
    assert.strictEqual(queryAtCursor('\\usepackage{amsmath,% comment|\n amssymb}'), undefined);
    assert.strictEqual(queryAtCursor('% \\usepackage{ams|math}'), undefined);
  });

  test('distinguishes escaped percent signs and escaped command slashes', () => {
    assert.strictEqual(queryAtCursor('\\% \\usepackage{ams|math}'), 'amsmath');
    assert.strictEqual(queryAtCursor('\\\\% \\usepackage{ams|math}'), undefined);
    assert.strictEqual(queryAtCursor('\\\\usepackage{ams|math}'), undefined);
    assert.strictEqual(queryAtCursor('\\\\\\usepackage{ams|math}'), 'amsmath');
  });

  test('does not infer a query from unrelated commands, macros, or incomplete arguments', () => {
    for (const source of [
      '\\foo|bar', '\\usepackageextra{ams|math}', '\\usepackage@extra{ams|math}',
      '\\usepackage{\\my|package}', '\\usepackage{ams|math', '\\usepackage[]{|}',
      '\\usepackage{ams math|}', '\\usepackage{{ams|math}}', '\\usepackage{amsmath} |text'
    ]) {
      assert.strictEqual(queryAtCursor(source), undefined, source);
    }
  });

  test('ignores inline verbatim and common verbatim environments', () => {
    assert.strictEqual(queryAtCursor('\\verb+\\usepackage{ams|math}+'), undefined);
    assert.strictEqual(queryAtCursor('\\verb*+\\usepackage{ams|math}+'), undefined);
    for (const environment of ['verbatim', 'verbatim*', 'Verbatim', 'lstlisting', 'minted', 'comment']) {
      assert.strictEqual(queryAtCursor(`\\begin{${environment}}\n\\usepackage{ams|math}\n\\end{${environment}}`), undefined);
      assert.strictEqual(queryAtCursor(`\\begin{${environment}}\nignored\n\\end{${environment}}\n\\usepackage{ams|math}`), 'amsmath');
    }
  });

  test('does not select declarations outside the cursor or invalid source offsets', () => {
    assert.strictEqual(queryAtCursor('|text \\usepackage{amsmath}'), undefined);
    assert.strictEqual(queryAtCursor('\\usepackage{amsmath}\n|text'), undefined);
    assert.strictEqual(findDocumentationQuery('\\usepackage{amsmath}', -1), undefined);
    assert.strictEqual(findDocumentationQuery('\\usepackage{amsmath}', 100), undefined);
  });
});
