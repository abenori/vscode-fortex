import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import TeXToPDF from '../compile/TeXToPDF/TeXToPDF';

type LocatedDiagnostic = [vscode.Uri, vscode.Range, string, vscode.DiagnosticSeverity];

async function replaceDocument(document: vscode.TextDocument, source: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), source);
  assert.ok(await vscode.workspace.applyEdit(edit));
}

interface LogFixture {
  uri(name: string): vscode.Uri;
  open(name: string): Promise<vscode.TextDocument>;
  linkDirectory(name: string, target: string): Promise<void>;
  analyze(filename: string, line?: number): Promise<LocatedDiagnostic[]>;
  parse(log: string): Promise<LocatedDiagnostic[]>;
}

/**
 * 診断一覧を，ファイルと範囲を確認しやすいテスト用の組へ展開する．
 * @param diagnostics 解析器が返した対象URIごとの診断．
 * @returns URI・範囲・本文・重要度の一覧．
 */
function flattenDiagnostics(diagnostics: Awaited<ReturnType<typeof TeXToPDF.analyze_errors>>): LocatedDiagnostic[] {
  return diagnostics.flatMap(([uri, entries]) => entries.map(entry => [uri, entry.range, entry.message, entry.severity] as LocatedDiagnostic));
}

async function withLogFixture(files: Record<string, string>, run: (fixture: LogFixture) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fortex-log-analysis-'));
  const uri = (name: string) => vscode.Uri.file(path.join(directory, name));
  const documents = new Map<vscode.TextDocument, string>();
  const links: string[] = [];
  let testError: unknown;
  try {
    for (const [name, source] of Object.entries(files)) {
      await fs.mkdir(path.dirname(uri(name).fsPath), { recursive: true });
      await fs.writeFile(uri(name).fsPath, source, 'utf8');
    }
    await run({
      uri,
      open: async name => {
        const source = await fs.readFile(uri(name).fsPath, 'utf8');
        const document = await vscode.workspace.openTextDocument(uri(name));
        documents.set(document, source);
        return document;
      },
      linkDirectory: async (name, target) => {
        const link = uri(name).fsPath;
        assert.strictEqual(path.relative(directory, path.dirname(path.resolve(link))), '');
        await fs.symlink(uri(target).fsPath, link, process.platform === 'win32' ? 'junction' : 'dir');
        links.push(link);
      },
      analyze: async (filename, line = 2) => {
        await fs.writeFile(uri('build.log').fsPath,
          `${filename}:${line}: Undefined control sequence.\r\nl.${line} prefix \\broken\r\nsuffix\r\n`, 'utf8');
        return flattenDiagnostics(await TeXToPDF.analyze_errors(uri('build.tex')));
      },
      parse: async log => {
        await fs.writeFile(uri('build.log').fsPath, log, 'utf8');
        return flattenDiagnostics(await TeXToPDF.analyze_errors(uri('build.tex')));
      }
    });
  } catch (error) {
    testError = error;
    throw error;
  } finally {
    assert.strictEqual(path.relative(os.tmpdir(), path.dirname(path.resolve(directory))), '');
    assert.ok(path.basename(directory).startsWith('fortex-log-analysis-'));
    try {
      for (const [document, source] of documents) {
        if (!document.isClosed && document.isDirty) {
          await replaceDocument(document, source);
          assert.ok(await document.save());
        }
      }
      // Remove only the link itself before recursively removing the fixture.
      // In particular, never recurse through a Windows directory junction.
      for (const link of links) {
        assert.strictEqual(path.relative(directory, path.dirname(path.resolve(link))), '');
        assert.ok((await fs.lstat(link)).isSymbolicLink());
        for (let attempt = 0; ; attempt++) {
          try {
            if (process.platform === 'win32') { await fs.rmdir(link); }
            else { await fs.unlink(link); }
            break;
          } catch (error) {
            if (attempt >= 9) { throw error; }
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        }
      }
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (cleanupError) {
      if (testError) { throw new AggregateError([testError, cleanupError], 'Log analysis test and cleanup both failed'); }
      throw cleanupError;
    }
  }
}

function assertTokenRange(errors: LocatedDiagnostic[], document: vscode.TextDocument): void {
  assert.strictEqual(errors.length, 1);
  const [uri, range] = errors[0];
  assert.strictEqual(uri.toString(), document.uri.toString());
  assert.strictEqual(range.start.line, 1);
  assert.strictEqual(range.end.line, 1);
  assert.strictEqual(document.getText(range), '\\broken');
}

suite('TeX log error document lookup', function () {
  this.timeout(20000);

  test('locates the error token in an unsaved buffer instead of saved source', async () => {
    await withLogFixture({ 'source.tex': 'Saved heading.\nSaved source.' }, async fixture => {
      const document = await fixture.open('source.tex');
      await replaceDocument(document, 'Unsaved heading.\nprefix \\broken suffix');
      assert.ok(document.isDirty);
      assertTokenRange(await fixture.analyze('source.tex'), document);
      assert.strictEqual(await fs.readFile(document.uri.fsPath, 'utf8'), 'Saved heading.\nSaved source.');
    });
  });

  test('ignores untitled and unrelated missing buffers without interrupting analysis', async () => {
    await withLogFixture({ 'source.tex': 'Saved source.', 'unrelated.txt': 'Unrelated source.' }, async fixture => {
      const untitled = await vscode.workspace.openTextDocument({ language: 'latex', content: 'Scratch document.' });
      await vscode.window.showTextDocument(untitled);
      try {
        const errors = await fixture.analyze('source.tex');
        assert.strictEqual(errors.length, 1);
        assert.strictEqual(errors[0][0].toString(), fixture.uri('source.tex').toString());
        assert.strictEqual(errors[0][1].start.line, 1);
        assert.strictEqual(errors[0][1].end.character, Number.MAX_SAFE_INTEGER);
        const missingErrors = await fixture.analyze('missing.tex');
        assert.strictEqual(missingErrors.length, 1);
        assert.strictEqual(missingErrors[0][0].toString(), fixture.uri('missing.tex').toString());
      } finally {
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      }

      const missing = await fixture.open('unrelated.txt');
      await replaceDocument(missing, 'Keep this deleted file open.');
      await vscode.window.showTextDocument(missing);
      await fs.unlink(missing.uri.fsPath);
      assert.ok(!missing.isClosed);
      const errors = await fixture.analyze('source.tex');
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(errors[0][0].toString(), fixture.uri('source.tex').toString());
      assert.strictEqual(errors[0][1].end.character, Number.MAX_SAFE_INTEGER);
    });
  });

  test('uses an exact open buffer even after its file has been deleted', async () => {
    await withLogFixture({ 'source.tex': 'Saved source.' }, async fixture => {
      const document = await fixture.open('source.tex');
      await replaceDocument(document, 'Unsaved heading.\nprefix \\broken suffix');
      await fs.unlink(document.uri.fsPath);
      assert.ok(!document.isClosed);
      assertTokenRange(await fixture.analyze('source.tex'), document);
    });
  });

  test('matches directory aliases and reports the URI of the open alias buffer', async () => {
    await withLogFixture({ 'real/source.tex': 'Saved source.' }, async fixture => {
      await fixture.linkDirectory('alias', 'real');
      const document = await fixture.open('alias/source.tex');
      assert.strictEqual(document.uri.toString(), fixture.uri('alias/source.tex').toString());
      await replaceDocument(document, 'Alias heading.\nprefix \\broken suffix');
      await vscode.window.showTextDocument(document);
      assertTokenRange(await fixture.analyze('real/source.tex'), document);
    });
  });

  test('keeps an out-of-range log line as a coarse diagnostic on the matched alias URI', async () => {
    await withLogFixture({ 'real/source.tex': 'Saved source.' }, async fixture => {
      await fixture.linkDirectory('alias', 'real');
      const document = await fixture.open('alias/source.tex');
      await replaceDocument(document, 'Shorter unsaved source.');
      const errors = await fixture.analyze('real/source.tex', 9);
      assert.strictEqual(errors.length, 1);
      const [uri, range] = errors[0];
      assert.strictEqual(uri.toString(), document.uri.toString());
      assert.strictEqual(range.start.line, 8);
      assert.strictEqual(range.end.line, 8);
      assert.strictEqual(range.start.character, 0);
      assert.strictEqual(range.end.character, Number.MAX_SAFE_INTEGER);
    });
  });

  test('prefers an exact URI buffer over an active physical alias', async () => {
    await withLogFixture({ 'real/source.tex': 'Heading.\nprefix \\broken suffix' }, async fixture => {
      await fixture.linkDirectory('alias', 'real');
      const alias = await fixture.open('alias/source.tex');
      await replaceDocument(alias, 'Different alias buffer.');
      const direct = await fixture.open('real/source.tex');
      assert.strictEqual(direct.uri.toString(), fixture.uri('real/source.tex').toString());
      await vscode.window.showTextDocument(alias);
      assertTokenRange(await fixture.analyze('real/source.tex'), direct);
    });
  });
});

suite('TeX log messages and source contexts', function () {
  this.timeout(20000);

  test('locates a macro invocation using the later source-context pair', async () => {
    const source = '\\newcommand{\\foo}{\\unknowncommand}\n' + '\n'.repeat(20) + 'abc \\foo def';
    await withLogFixture({ 'test.tex': source }, async fixture => {
      const errors = await fixture.parse('./test.tex:22: Undefined control sequence.\n'
        + '\\foo ->\\unknowncommand \n                       \nl.22 abc \\foo\n              def\n');
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(errors[0][0].toString(), fixture.uri('test.tex').toString());
      assert.deepStrictEqual([errors[0][1].start.line, errors[0][1].start.character, errors[0][1].end.character], [21, 4, 8]);
      assert.ok(errors[0][2].includes('\\unknowncommand'));
      assert.ok(errors[0][2].includes('\\foo ->'));
    });
  });

  test('reads multiple macro frames and argument contexts before locating the source', async () => {
    await withLogFixture({ 'source.tex': 'abc \\outer def\n\\foo{\\missing}' }, async fixture => {
      const errors = await fixture.parse('./source.tex:1: Undefined control sequence.\n'
        + '\\inner ->\\missing\n        \n\\outer ->\\inner\n        \nl.1 abc \\outer\n                  def\n'
        + './source.tex:2: Undefined control sequence.\n<argument> \\missing\n        \n'
        + '\\foo #1->#1\n        \nl.2 \\foo{\\missing\n                  }\n');
      assert.strictEqual(errors.length, 2);
      assert.deepStrictEqual([errors[0][1].start.character, errors[0][1].end.character], [4, 10]);
      assert.deepStrictEqual([errors[1][1].start.character, errors[1][1].end.character], [5, 13]);
    });
  });

  test('highlights only the offending subscript and superscript markers', async () => {
    await withLogFixture({ 'source.tex': '$a_b_c$\n$x^y^z$' }, async fixture => {
      const errors = await fixture.parse('./source.tex:1: Double subscript.\nl.1 $a_b_\n         c$\n'
        + './source.tex:2: Double superscript.\nl.2 $x^y^\n         z$\n');
      assert.strictEqual(errors.length, 2);
      for (const [, range] of errors) {
        assert.deepStrictEqual([range.start.character, range.end.character], [4, 5]);
      }
    });
  });

  test('does not search earlier source lines when the reported line does not match', async () => {
    await withLogFixture({ 'source.tex': 'prefix \\broken suffix\nDifferent source.' }, async fixture => {
      const errors = await fixture.analyze('source.tex');
      assert.strictEqual(errors[0][1].start.line, 1);
      assert.deepStrictEqual([errors[0][1].start.character, errors[0][1].end.character], [0, 17]);
    });
  });

  test('uses both cropped snippets and falls back when they are ambiguous', async () => {
    await withLogFixture({ 'source.tex': 'long prefix abc \\foo def long suffix\n\\foo \\foo' }, async fixture => {
      const errors = await fixture.parse('./source.tex:1: Undefined control sequence.\nl.1 ...abc \\foo\n     def...\n'
        + './source.tex:2: Undefined control sequence.\nl.2 ...\\foo\n     ...\n');
      assert.deepStrictEqual([errors[0][1].start.character, errors[0][1].end.character], [16, 20]);
      assert.deepStrictEqual([errors[1][1].start.character, errors[1][1].end.character], [0, 9]);
    });
  });

  test('locates an undefined command after Japanese text without using the display indentation', async () => {
    await withLogFixture({ '日本語 path(1).tex': '日本語の文です。\\broken 残りです。' }, async fixture => {
      const errors = await fixture.parse('./日本語 path(1).tex:1: Undefined control sequence.\n'
        + 'l.1 日本語の文です。\\broken\n                                            残りです。\n');
      assert.strictEqual(errors.length, 1);
      assert.deepStrictEqual([errors[0][1].start.character, errors[0][1].end.character], [8, 15]);
      assert.ok(!errors[0][2].includes('\\\\broken'));
    });
  });

  test('tracks input files with spaces and parentheses for traditional errors and warnings', async () => {
    await withLogFixture({ 'sub (1).tex': 'prefix \\broken suffix', 'build.tex': 'Main source.' }, async fixture => {
      const errors = await fixture.parse('(./build.tex (./sub (1).tex\n'
        + '! Undefined control sequence.\nl.1 prefix \\broken\n                     suffix\n\n'
        + 'Package probe Warning: Parentheses (in a warning)\n(probe)                on input line 1.\n\n)\n'
        + 'LaTeX Warning: Reference `missing\' on page 1 undefined on input line 1.\n\n)');
      assert.strictEqual(errors.length, 3);
      assert.strictEqual(errors[0][0].toString(), fixture.uri('sub (1).tex').toString());
      assert.strictEqual(errors[1][0].toString(), fixture.uri('sub (1).tex').toString());
      assert.strictEqual(errors[2][0].toString(), fixture.uri('build.tex').toString());
      assert.strictEqual(errors[1][3], vscode.DiagnosticSeverity.Warning);
    });
  });

  test('restores a wrapped input filename and a wrapped file-line header', async () => {
    const filename = 'nested-path-'.repeat(8) + '/sub.tex';
    await withLogFixture({ [filename]: '\\broken' }, async fixture => {
      const opened = '(./' + filename;
      const header = './' + filename + ':1: Undefined control sequence.';
      const errors = await fixture.parse(opened.slice(0, 79) + '\n' + opened.slice(79) + '\n'
        + header.slice(0, 79) + '\n' + header.slice(79) + '\nl.1 \\broken\n             \n');
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(errors[0][0].toString(), fixture.uri(filename).toString());
      assert.deepStrictEqual([errors[0][1].start.character, errors[0][1].end.character], [0, 7]);
      const traditional = await fixture.parse(opened.slice(0, 79) + '\n' + opened.slice(79)
        + '\n! Undefined control sequence.\nl.1 \\broken\n             \n');
      assert.strictEqual(traditional[0][0].toString(), fixture.uri(filename).toString());
    });
  });

  test('preserves all wrapped message lines and package continuations', async () => {
    await withLogFixture({ 'source.tex': 'source' }, async fixture => {
      const long = 'abcdefghijklmnopqrst'.repeat(20);
      const header = './source.tex:1: ' + long;
      const physical = header.match(/.{1,61}/g)!.join('\n');
      const errors = await fixture.parse(physical + '\nl.1 source\n              \n'
        + './source.tex:1: Package probe Error: First line\n(probe)                Second line\n'
        + '(probe)                Third line.\n\nSee the probe package documentation for explanation.\n'
        + 'Type H for help.\n ...\n\nl.1 source\n              \n');
      assert.strictEqual(errors.length, 2);
      assert.strictEqual(errors[0][2], long);
      assert.strictEqual(errors[1][2], 'Package probe Error: First line\nSecond line\nThird line.');
    });
  });

  test('reports runaway arguments and missing ends at the actual log message', async () => {
    await withLogFixture({}, async fixture => {
      const runaway = await fixture.parse(')\nRunaway argument?\n{never closed\n'
        + '! File ended while scanning use of \\foo.\n<inserted text>\n                \\par\n<*> build.tex\n\n');
      assert.strictEqual(runaway.length, 1);
      assert.strictEqual(runaway[0][0].toString(), fixture.uri('build.log').toString());
      assert.strictEqual(runaway[0][1].start.line, 3);
      assert.ok(runaway[0][2].includes('never closed'));
      const emergency = await fixture.parse(')\n! Emergency stop.\n<*> build.tex\n\n'
        + '*** (job aborted, no legal \\end found)\n');
      assert.strictEqual(emergency.length, 1);
      assert.strictEqual(emergency[0][1].start.line, 1);
      assert.ok(emergency[0][2].includes('no legal \\end found'));
    });
  });

  test('retains the missing package name and suppresses a redundant fatal summary', async () => {
    await withLogFixture({ 'build.tex': '\\usepackage{missing}\n\\begin{document}' }, async fixture => {
      const errors = await fixture.parse("! LaTeX Error: File `missing.sty' not found.\n\n"
        + 'Enter file name:\n./build.tex:2: Emergency stop.\n<read *>\n         \n'
        + 'l.2 \\begin\n         {document}\n*** (cannot read from terminal)\n'
        + './build.tex:2: ==> Fatal error occurred, no output PDF file produced!\n');
      assert.strictEqual(errors.length, 2);
      assert.ok(errors.some(([, , text]) => text.includes("missing.sty' not found")));
      assert.ok(!errors.some(([, , text]) => text.includes('Fatal error occurred')));
    });
  });

  test('keeps a standalone fatal summary and rejects invalid source line numbers', async () => {
    await withLogFixture({}, async fixture => {
      const fatal = await fixture.parse('! ==> Fatal error occurred, no output PDF file produced!\n');
      assert.strictEqual(fatal.length, 1);
      assert.strictEqual(fatal[0][0].toString(), fixture.uri('build.log').toString());
      for (const line of ['0', '999999999999999999999999']) {
        const errors = await fixture.parse(`./build.tex:${line}: Invalid source position.\n`);
        assert.strictEqual(errors.length, 1);
        assert.strictEqual(errors[0][0].toString(), fixture.uri('build.log').toString());
        assert.strictEqual(errors[0][1].start.line, 0);
      }
    });
  });

  test('collects warnings, line ranges, and missing characters with their own severity', async () => {
    await withLogFixture({ 'build.tex': 'one\ntwo\nthree' }, async fixture => {
      const errors = await fixture.parse('(./build.tex\nPackage probe Warning: First line\n'
        + '(probe)                Second line on input line 2.\n\n'
        + 'Overfull \\hbox (5pt too wide) in paragraph at lines 1--3\n'
        + '\\OT1/cmr/m/n/10 This (is not a filename).\n []\n\n'
        + 'Missing character: There is no X in font nullfont!\n\n)');
      assert.strictEqual(errors.length, 3);
      assert.strictEqual(errors[0][3], vscode.DiagnosticSeverity.Warning);
      assert.strictEqual(errors[0][1].start.line, 1);
      assert.strictEqual(errors[1][3], vscode.DiagnosticSeverity.Information);
      assert.deepStrictEqual([errors[1][1].start.line, errors[1][1].end.line], [0, 2]);
      assert.ok(!errors[1][2].includes('OT1'));
      assert.strictEqual(errors[2][0].toString(), fixture.uri('build.log').toString());
      assert.strictEqual(errors[2][3], vscode.DiagnosticSeverity.Warning);
    });
  });

  test('does not turn Lua stack frames into file diagnostics', async () => {
    await withLogFixture({ 'build.tex': "\\directlua{error('probe')}" }, async fixture => {
      const errors = await fixture.parse('(./build.tex[\\directlua]:1: probe\nstack traceback:\n'
        + "\t[C]: in function 'error'\n\t[\\directlua]:1: in main chunk.\n"
        + "l.1 \\directlua{error('probe')}\n                                     \n"
        + './build.tex:1: ==> Fatal error occurred, no output PDF file produced!\n');
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(errors[0][0].toString(), fixture.uri('build.tex').toString());
      assert.ok(errors[0][2].includes('probe'));
    });
  });

  test('ignores wrapped Lua frames and retains an explicit TeX location', async () => {
    await withLogFixture({ 'build.tex': 'one\ntwo\nthree' }, async fixture => {
      const errors = await fixture.parse('./build.tex:3: [\\directlua]:1: probe\nstack traceback:\n'
        + '\t...a very long Lua file\n/path/to/frame.lua:97: in function\n'
        + 'l.3 three\n           \n');
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(errors[0][0].toString(), fixture.uri('build.tex').toString());
      assert.strictEqual(errors[0][1].start.line, 2);
    });
  });

  test('tracks a file opened on the same line as a Lua error', async () => {
    await withLogFixture({ 'sub (1).tex': "\\directlua{error('probe')}" }, async fixture => {
      const errors = await fixture.parse('(./sub (1).tex[\\directlua]:1: probe\nstack traceback:\n'
        + "\t[\\directlua]:1: in main chunk.\nl.1 \\directlua{error('probe')}\n              \n");
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(errors[0][0].toString(), fixture.uri('sub (1).tex').toString());
    });
  });

  test('suppresses an undefined-reference summary only when a detailed warning exists', async () => {
    await withLogFixture({ 'build.tex': 'source' }, async fixture => {
      const summary = 'LaTeX Warning: There were undefined references.\n\n';
      const detailed = "LaTeX Warning: Reference `missing' on page 1 undefined on input line 1.\n\n";
      const errors = await fixture.parse(detailed + summary);
      assert.strictEqual(errors.length, 1);
      assert.ok(errors[0][2].includes("Reference `missing'"));
      const summaryOnly = await fixture.parse(summary);
      assert.strictEqual(summaryOnly.length, 1);
      assert.ok(summaryOnly[0][2].includes('There were undefined references'));
    });
  });

  test('keeps the first file-line location when the message contains another location or an arrow', async () => {
    await withLogFixture({ 'build.tex': 'one\ntwo\nthree' }, async fixture => {
      const absolute = fixture.uri('build.tex').fsPath;
      const errors = await fixture.parse(`${absolute}:3: script.lua:9: a->b failed.\nl.3 three\n           \n`);
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(errors[0][0].toString(), fixture.uri('build.tex').toString());
      assert.strictEqual(errors[0][1].start.line, 2);
      assert.strictEqual(errors[0][2], 'script.lua:9: a->b failed.');
    });
  });

  test('deduplicates identical diagnostics and tolerates a truncated context', async () => {
    await withLogFixture({ 'build.tex': '\\broken' }, async fixture => {
      const error = './build.tex:1: Undefined control sequence.\nl.1 \\broken\n             \n';
      const duplicates = await fixture.parse(error + error);
      assert.strictEqual(duplicates.length, 1);
      const truncated = await fixture.parse('./build.tex:1: Undefined control sequence.\nl.1 \\broken');
      assert.strictEqual(truncated.length, 1);
    });
  });
});
