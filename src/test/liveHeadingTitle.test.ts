import * as assert from 'assert';
import { readHeadingTitle } from '../structure/LaTeXStructureParser';

suite('Live heading title fragments', () => {
  test('reads a complete title, including an empty title', () => {
    assert.strictEqual(readHeadingTitle('\\section{New name}', 'section'), 'New name');
    assert.strictEqual(readHeadingTitle('\\section{}', 'section'), '');
  });

  test('uses the mandatory title after a star and optional short title', () => {
    assert.strictEqual(readHeadingTitle('\\section*[Short {title}]{Long \\emph{title}}', 'section'), 'Long title');
  });

  test('preserves nested and escaped braces, comments, Unicode and multiline formatting', () => {
    assert.strictEqual(readHeadingTitle('\\section{日本語 😀 \\textbf{bold {nested}} \\{literal\\}% hidden\r\n next}', 'section'),
      '日本語 😀 bold nested {literal} next');
  });

  test('omits labels using the same display-name normalization as saved headings', () => {
    assert.strictEqual(readHeadingTitle('\\section{A \\label{sec:a} title}', 'section'), 'A title');
  });

  test('rejects incomplete arguments and accepts them after the next edit closes them', () => {
    assert.strictEqual(readHeadingTitle('\\section{Title \\textbf{unfinished}', 'section'), undefined);
    assert.strictEqual(readHeadingTitle('\\section{Title \\textbf{finished}}', 'section'), 'Title finished');
    assert.strictEqual(readHeadingTitle('\\section{Title%}', 'section'), undefined);
    assert.strictEqual(readHeadingTitle('\\section{Title%\n}', 'section'), 'Title');
  });

  test('rejects declarations whose command or outer boundary changed', () => {
    assert.strictEqual(readHeadingTitle('\\subsection{Other level}', 'section'), undefined);
    assert.strictEqual(readHeadingTitle('\\section{Early} trailing}', 'section'), undefined);
    assert.strictEqual(readHeadingTitle('prefix \\section{Title}', 'section'), undefined);
    assert.strictEqual(readHeadingTitle('\\section[unfinished{Title}', 'section'), undefined);
    assert.strictEqual(readHeadingTitle('\\caption{Caption}', 'caption'), undefined);
  });
});
