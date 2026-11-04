import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import LaTeXProject from '../project/LaTeXProject';
import TeXToPDF from '../compile/TeXToPDF/TeXToPDF';

async function withProject(
  files: Record<string, string>,
  run: (uri: (name: string) => vscode.Uri) => Promise<void>
): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fortex-project-parser-'));
  const uri = (name: string) => vscode.Uri.file(path.join(directory, name));
  let testError: unknown;
  try {
    for (const [name, source] of Object.entries(files)) {
      const file = uri(name);
      await fs.mkdir(path.dirname(file.fsPath), { recursive: true });
      await fs.writeFile(file.fsPath, source, 'utf8');
    }
    await run(uri);
  } catch (error) {
    testError = error;
    throw error;
  } finally {
    assert.strictEqual(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('fortex-project-parser-'));
    try {
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (cleanupError) {
      if (testError) { throw new AggregateError([testError, cleanupError], 'Project test and cleanup both failed'); }
      throw cleanupError;
    }
  }
}

async function replaceDocument(document: vscode.TextDocument, source: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), source);
  assert.ok(await vscode.workspace.applyEdit(edit));
}

function paths(files: vscode.Uri[]): string[] {
  return files.map(file => path.normalize(file.fsPath));
}

async function classOptions(file: vscode.Uri): Promise<[string, string]> {
  const project = await LaTeXProject.create(file);
  return [project.classfile, project.classoption];
}

async function existingFiles(file: vscode.Uri): Promise<vscode.Uri[]> {
  const project = await LaTeXProject.create(file);
  return project.filelist.filter(entry => entry.exists).map(entry => entry.uri);
}

type ProjectResult = Awaited<ReturnType<typeof LaTeXProject.create>>;

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), 10000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function projectAfterChange(
  file: vscode.Uri,
  matches: (project: ProjectResult) => boolean,
  description: string,
  action: () => PromiseLike<unknown>
): Promise<ProjectResult> {
  await action();
  const project = await bounded(LaTeXProject.create(file), description);
  assert.ok(matches(project), `A fresh request must reflect ${description}`);
  return project;
}

suite('Percent-sharp directive parsing', () => {
  const parse = (source: string) => LaTeXProject['parse_percent_sharp_doc'](source);

  test('normalizes indentation, key case and separator whitespace while retaining unknown keys and empty values', () => {
    const source = [
      '\uFEFF \t%#MAIN\t "main file.tex" \t',
      '  %#T2DOPT   --foo\t"two words"  %F % 説明\t ',
      '%#CUSTOM earlier',
      '\t%#custom\t last \t',
      '%#empty',
      '%#blank \t',
      '%#! \t'
    ].join('\n');
    assert.deepStrictEqual(parse(source), {
      main: '"main file.tex"',
      t2dopt: '--foo\t"two words"  %F % 説明',
      custom: 'last',
      empty: '',
      blank: '',
      '!': ''
    });
  });

  test('always treats the adjacent exclamation mark as the command key', () => {
    for (const source of ['%#!lualatex --foo', '%#! lualatex --foo', '\t%#!\tlualatex --foo\t ']) {
      assert.deepStrictEqual(parse(source), { '!': 'lualatex --foo' });
    }
    assert.deepStrictEqual(parse('%#!lualatex \t'), { '!': 'lualatex' });
    assert.deepStrictEqual(parse('%#!LuaLaTeX  "some file.tex"\t%F %T\t'), {
      '!': 'LuaLaTeX  "some file.tex"\t%F %T'
    });
    assert.deepStrictEqual(parse('%#!first\n%#! second --foo'), { '!': 'second --foo' });
  });

  test('requires an exact marker and a full-line TeX comment with a nonempty adjacent key', () => {
    const source = [
      '% #spaced invalid',
      '%# separated invalid',
      '%#\ttabbed invalid',
      '%#',
      '%# \t',
      '%# ! invalid',
      '%%#nested invalid',
      'body %#inline invalid',
      '\\%#escaped invalid',
      '\\\\%#aftercommand invalid',
      '\u00A0%#nonhorizontal invalid',
      '\uFEFF%#laterbom invalid',
      ' \t%#valid accepted'
    ].join('\n');
    assert.deepStrictEqual(parse(source), { valid: 'accepted' });
  });

  test('handles LF, CRLF and CR without merging directive lines', () => {
    for (const lineEnding of ['\n', '\r\n', '\r']) {
      const source = ['%#main first.tex', '%#t2dopt --foo', '%#MAIN second.tex', '%#!lualatex --bar']
        .join(lineEnding);
      assert.deepStrictEqual(parse(source), {
        main: 'second.tex', t2dopt: '--foo', '!': 'lualatex --bar'
      });
    }
  });

  test('excludes directive-looking text in literal environments and resumes after their closing lines', () => {
    for (const environment of ['verbatim', 'verbatim*', 'Verbatim', 'lstlisting', 'minted', 'comment', 'filecontents']) {
      const source = [
        '%#main visible.tex',
        `\\begin{${environment}}`,
        '%#main hidden.tex',
        '\t%#!hidden --command',
        `\\end{${environment}}`,
        '%#custom visible'
      ].join('\r\n');
      assert.deepStrictEqual(parse(source), { main: 'visible.tex', custom: 'visible' }, environment);
    }
    assert.deepStrictEqual(parse('%#main visible.tex\n\\begin{verbatim}\n%#main hidden.tex'), {
      main: 'visible.tex'
    });
  });

  test('excludes inline literal contents without losing later comments', () => {
    const source = [
      '\\verb|%#verb hidden|',
      '\\Verb+%#capital hidden+',
      '\\lstinline{%#listing hidden}',
      '\\mintinline{tex}{%#minted hidden}',
      '\\verb%#delimited hidden%',
      '%#main visible.tex'
    ].join('\n');
    assert.deepStrictEqual(parse(source), { main: 'visible.tex' });
  });

  test('trims only spaces and tabs while preserving all other value text', () => {
    assert.deepStrictEqual(parse('%#custom \t\u00A0quoted "value"\t%F % explanation\u00A0\t '), {
      custom: '\u00A0quoted "value"\t%F % explanation\u00A0'
    });
    const longCommand = `lualatex${' '.repeat(40000)}%F`;
    assert.deepStrictEqual(parse(`%#! \t${longCommand}\t `), { '!': longCommand });
  });

  test('keeps prototype-like unknown keys as own string properties on a plain object', () => {
    const directives = parse('%#__proto__ retained\n%#constructor compiler\n%#__PROTO__ replaced');
    assert.strictEqual(Object.getPrototypeOf(directives), Object.prototype);
    assert.ok(Object.prototype.hasOwnProperty.call(directives, '__proto__'));
    assert.strictEqual(directives['__proto__'], 'replaced');
    assert.strictEqual(directives['constructor'], 'compiler');
    assert.deepStrictEqual(Object.keys(directives), ['__proto__', 'constructor']);
  });
});

suite('LaTeX project document parsing', function () {
  this.timeout(20000);
  let target: vscode.ConfigurationTarget;
  let originalOrder: unknown;

  setup(async () => {
    target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    const configuration = vscode.workspace.getConfiguration('vscode-fortex');
    const previous = configuration.inspect('mainFileOrder');
    originalOrder = target === vscode.ConfigurationTarget.Workspace ? previous?.workspaceValue : previous?.globalValue;
    await configuration.update('mainFileOrder', ['magic', 'guess', 'current'], target);
  });

  teardown(async () => {
    await vscode.workspace.getConfiguration('vscode-fortex').update('mainFileOrder', originalOrder, target);
  });

  test('reads CRLF class declarations and nested options while ignoring comments and literal text', async () => {
    const source = [
      '% \\documentclass{commented}',
      '\\verb|\\documentclass{inline}|',
      '\\begin{verbatim}',
      '\\documentclass{literal}',
      '\\end{verbatim}',
      '\\\\documentclass{escaped}',
      '\\documentclass % The declaration continues on the next line.',
      '[12pt,',
      ' title={A [nested] title},% \\ignored{comment}',
      ' draft]',
      '{ arti% \\ignored{comment}',
      'cle }[2025/01/01]'
    ].join('\r\n');
    await withProject({ 'main.tex': source }, async uri => {
      assert.deepStrictEqual(await classOptions(uri('main.tex')), [
        'article', '12pt,\r\n title={A [nested] title}, draft'
      ]);
    });
  });

  test('collects recursive braced inputs and excludes unresolved declarations', async () => {
    const ignored = [
      '% \\input{commented}',
      '\\verb|\\include{inline}|',
      '\\begin{verbatim}',
      '\\input{literal}',
      '\\end{verbatim}',
      '\\\\input{escaped}',
      '\\input{\\generated}',
      '\\input{nested{path}}',
      '\\input{#1}',
      '\\input{$generated}',
      '\\input{}',
      '\\input{unfinished'
    ].join('\r\n');
    await withProject({
      'braced.tex': '\\documentclass{article}\r\n\\input{chapters/first}\r\n\\include{appendix}\r\n' + ignored,
      'chapters/first.tex': '\\input{sha% \\ignored{comment}\r\nred}\r\n\\input{shared.tex}',
      'shared.tex': '\\input{chapters/first}\r\nShared body.',
      'appendix.tex': '\\input{shared}',
      'commented.tex': 'Must not be included.',
      'inline.tex': 'Must not be included.',
      'literal.tex': 'Must not be included.',
      'escaped.tex': 'Must not be included.',
      'generated.tex': 'Must not be included.',
      'nested{path}.tex': 'Must not be included.',
      '#1.tex': 'Must not be included.',
      '$generated.tex': 'Must not be included.',
      'unfinished.tex': 'Must not be included.'
    }, async uri => {
      assert.deepStrictEqual(paths(await existingFiles(uri('braced.tex'))),
        paths(['braced.tex', 'chapters/first.tex', 'shared.tex', 'appendix.tex'].map(uri)));
    });
  });

  test('ignores bare literal, macro, and quoted inputs and recovers at the following braced input', async () => {
    await vscode.workspace.getConfiguration('vscode-fortex').update('mainFileOrder', ['guess', 'current'], target);
    await withProject({
      'main.tex': String.raw`\documentclass{article}
\newcommand{\file}{macro}
\input literal
\input \file
\input "with space"\input{visible}`,
      'literal.tex': 'Bare literal target.',
      'macro.tex': 'Bare macro target.',
      'with space.tex': 'Bare quoted target.',
      'visible.tex': 'Braced target.'
    }, async uri => {
      const project = await LaTeXProject.create(uri('main.tex'));
      assert.deepStrictEqual(paths(project.filelist.map(entry => entry.uri)), paths(['main.tex', 'visible.tex'].map(uri)));
      for (const name of ['literal.tex', 'macro.tex', 'with space.tex']) {
        assert.strictEqual((await LaTeXProject.resolveMainFile(uri(name))).toString(), uri(name).toString(),
          `A bare input must not make main.tex the parent of ${name}`);
      }
      assert.strictEqual((await LaTeXProject.resolveMainFile(uri('visible.tex'))).toString(), uri('main.tex').toString());
    });
  });

  test('discovers an ancestor main through a braced input and a nested include', async () => {
    await withProject({
      'main.tex': '\\documentclass[11pt]{book}\r\n\\input{chapters/first}',
      'chapters/first.tex': '\\include{chapters/nested/child}',
      'chapters/nested/child.tex': '% \\documentclass{commented}\r\n\\verb|\\documentclass{inline}|\r\nChild body.'
    }, async uri => {
      await vscode.workspace.getConfiguration('vscode-fortex').update('mainFileOrder', ['guess', 'current'], target);
      const current = uri('chapters/nested/child.tex');
      const result = await LaTeXProject.create(current);
      assert.strictEqual(result.file?.toString(), current.toString());
      assert.strictEqual(result.mainfile.toString(), uri('main.tex').toString());
      assert.deepStrictEqual([result.classfile, result.classoption], ['book', '11pt']);
    });
  });

  test('resolves the main without collecting its included files', async () => {
    await withProject({
      'main.tex': '\\documentclass{article}\n\\input{chapters/first}',
      'child.tex': '%#main main.tex\nChild body.',
      'chapters/first.tex': '\\include{chapters/nested/second}',
      'chapters/nested/second.tex': 'Second body.'
    }, async uri => {
      const documentText: { readDocumentText: typeof import('../workspace').readDocumentText }
        = require('../workspace/DocumentText');
      const originalRead = documentText.readDocumentText;
      const reads: string[] = [];
      documentText.readDocumentText = async file => {
        reads.push(file.toString());
        return originalRead(file);
      };
      try {
        const main = await LaTeXProject.resolveMainFile(uri('child.tex'));
        assert.strictEqual(main.toString(), uri('main.tex').toString());
        const allowed = new Set(['child.tex', 'main.tex'].map(name => uri(name).toString()));
        assert.ok(reads.length > 0);
        assert.ok(reads.every(file => allowed.has(file)), 'Main lookup must not read included files');
        assert.ok(reads.includes(uri('main.tex').toString()));
        reads.length = 0;
        const project = await LaTeXProject.create(uri('child.tex'));
        assert.deepStrictEqual(paths(project.filelist.map(entry => entry.uri)),
          paths(['main.tex', 'chapters/first.tex', 'chapters/nested/second.tex'].map(uri)));
        assert.ok(reads.includes(uri('chapters/nested/second.tex').toString()));
      } finally {
        documentText.readDocumentText = originalRead;
      }
    });
  });

  test('keeps missing references and first-visit types in the shared project traversal', async () => {
    await vscode.workspace.getConfiguration('vscode-fortex').update('mainFileOrder', ['current'], target);
    await withProject({
      'main.tex': '\\documentclass{article}\n\\input{chapter}\n\\include{missing-include}\n\\input{missing-input}\n\\include{shared}',
      'chapter.tex': '\\include{nested/child}\n\\input{shared}',
      'nested/child.tex': '\\input{main}\n\\include{missing-include}',
      'shared.tex': 'Shared body.'
    }, async uri => {
      const types = LaTeXProject.LaTeXFileType;
      const expected = [
        { uri: uri('main.tex'), type: types.main, exists: true },
        { uri: uri('chapter.tex'), type: types.input, exists: true },
        { uri: uri('nested/child.tex'), type: types.include, exists: true },
        { uri: uri('missing-include.tex'), type: types.include, exists: false },
        { uri: uri('shared.tex'), type: types.input, exists: true },
        { uri: uri('missing-input.tex'), type: types.input, exists: false }
      ];
      const project = await LaTeXProject.create(uri('main.tex'));
      const entries = project.filelist;
      assert.deepStrictEqual(entries.map(entry => [path.normalize(entry.uri.fsPath), entry.type, entry.exists]),
        expected.map(entry => [path.normalize(entry.uri.fsPath), entry.type, entry.exists]));

      // Build auxiliary-file tracking must retain missing includes so TeX can
      // report them; ordinary inputs do not get separate auxiliary files.
      const build = new TeXToPDF(project, undefined);
      assert.deepStrictEqual(build.file_list.map(file => path.normalize(file)),
        paths(['main.tex', 'nested/child.tex', 'missing-include.tex'].map(uri)));

      assert.deepStrictEqual(paths(project.filelist.filter(entry => entry.exists).map(entry => entry.uri)),
        paths(expected.filter(entry => entry.exists).map(entry => entry.uri)));

      const missingInclude = uri('missing-include.tex');
      await fs.writeFile(missingInclude.fsPath, '% Newly created include.\n', 'utf8');
      assert.strictEqual(project.filelist, entries);
      assert.strictEqual(project.filelist.find(entry => entry.uri.toString() === missingInclude.toString())?.exists, false,
        'An existing project must retain its collected existence snapshot');
      const refreshed = await LaTeXProject.create(uri('main.tex'));
      assert.strictEqual(refreshed.filelist.find(entry => entry.uri.toString() === missingInclude.toString())?.exists, true,
        'A new project must collect the newly created include');
    });
  });

  test('waits for nested source reads before returning a complete project', async () => {
    await vscode.workspace.getConfiguration('vscode-fortex').update('mainFileOrder', ['current'], target);
    await withProject({
      'main.tex': '\\documentclass[12pt]{book}\n%#custom retained\n\\input{chapter}',
      'chapter.tex': '\\include{nested/child}',
      'nested/child.tex': 'Child body.'
    }, async uri => {
      const started = deferred<void>();
      const release = deferred<void>();
      const documentText: { readDocumentText: typeof import('../workspace').readDocumentText }
        = require('../workspace/DocumentText');
      const originalRead = documentText.readDocumentText;
      documentText.readDocumentText = async file => {
        const source = await originalRead(file);
        if (file.toString() === uri('nested/child.tex').toString()) {
          started.resolve();
          await release.promise;
        }
        return source;
      };
      let settled = false;
      try {
        const pending = LaTeXProject.create(uri('main.tex')).then(project => { settled = true; return project; });
        await bounded(started.promise, 'the nested project source read');
        assert.strictEqual(settled, false);
        release.resolve();
        const project = await bounded(pending, 'the completed project');
        assert.strictEqual(project.mainfile.toString(), uri('main.tex').toString());
        assert.strictEqual(project.classfile, 'book');
        assert.strictEqual(project.classoption, '12pt');
        assert.strictEqual(project.percent_sharp('custom'), 'retained');
        assert.deepStrictEqual(paths(project.filelist.map(entry => entry.uri)),
          paths(['main.tex', 'chapter.tex', 'nested/child.tex'].map(uri)));
      } finally {
        release.resolve();
        documentText.readDocumentText = originalRead;
      }
    });
  });

  test('keeps first-read directives stable during file-list collection and uses edits on the next request', async () => {
    const saved = '%#main first.tex\nChild body.';
    await withProject({
      'first.tex': '\\documentclass{article}\n\\input{first-child}',
      'first-child.tex': 'First child.',
      'second.tex': '\\documentclass[11pt]{report}\n\\include{second-child}',
      'second-child.tex': 'Second child.',
      'child.tex': saved
    }, async uri => {
      const document = await vscode.workspace.openTextDocument(uri('child.tex'));
      const started = deferred<void>();
      const release = deferred<void>();
      const documentText: { readDocumentText: typeof import('../workspace').readDocumentText }
        = require('../workspace/DocumentText');
      const originalRead = documentText.readDocumentText;
      let held = false;
      documentText.readDocumentText = async file => {
        const source = await originalRead(file);
        if (file.toString() === uri('first-child.tex').toString() && !held) {
          held = true;
          started.resolve();
          await release.promise;
        }
        return source;
      };
      try {
        const pending = LaTeXProject.create(document.uri);
        await bounded(started.promise, 'file-list collection for the original main');
        await replaceDocument(document, saved.replace('first.tex', 'second.tex'));
        release.resolve();
        const project = await bounded(pending, 'the original project request');
        assert.strictEqual(project.mainfile.toString(), uri('first.tex').toString());
        assert.strictEqual(project.classfile, 'article');
        assert.strictEqual(project.classoption, '');
        assert.strictEqual(project.percent_sharp('main'), 'first.tex');
        assert.deepStrictEqual(paths(project.filelist.map(entry => entry.uri)),
          paths(['first.tex', 'first-child.tex'].map(uri)));
        const latest = await LaTeXProject.create(document.uri);
        assert.strictEqual(latest.mainfile.toString(), uri('second.tex').toString());
        assert.deepStrictEqual(paths(latest.filelist.map(entry => entry.uri)),
          paths(['second.tex', 'second-child.tex'].map(uri)));
      } finally {
        release.resolve();
        documentText.readDocumentText = originalRead;
        if (!document.isClosed) { await replaceDocument(document, saved); }
      }
    });
  });

  test('cancels project creation disposed during file-list collection', async () => {
    await vscode.workspace.getConfiguration('vscode-fortex').update('mainFileOrder', ['current'], target);
    await withProject({
      'main.tex': '\\documentclass{article}\n\\input{child}',
      'child.tex': 'Child body.'
    }, async uri => {
      const started = deferred<void>();
      const release = deferred<void>();
      const documentText: { readDocumentText: typeof import('../workspace').readDocumentText }
        = require('../workspace/DocumentText');
      const originalRead = documentText.readDocumentText;
      documentText.readDocumentText = async file => {
        const source = await originalRead(file);
        if (file.toString() === uri('child.tex').toString()) {
          started.resolve();
          await release.promise;
        }
        return source;
      };
      try {
        const pending = LaTeXProject.create(uri('main.tex'));
        const cancelled = assert.rejects(pending, error => error instanceof vscode.CancellationError);
        await bounded(started.promise, 'file-list collection before disposal');
        LaTeXProject.dispose();
        release.resolve();
        await bounded(cancelled, 'the disposed project creation to cancel');
        documentText.readDocumentText = originalRead;
        const restarted = await LaTeXProject.create(uri('main.tex'));
        assert.deepStrictEqual(paths(restarted.filelist.map(entry => entry.uri)), paths(['main.tex', 'child.tex'].map(uri)));
      } finally {
        release.resolve();
        documentText.readDocumentText = originalRead;
      }
    });
  });

  // Editor dependency discovery supports nested includes as well as inputs.
  const nestedCommands = [['input', 'input'], ['include', 'input'], ['input', 'include'], ['include', 'include']];
  for (const [outer, inner] of nestedCommands) {
    test(`resolves ${outer} then ${inner} from the main directory at every depth`, async () => {
      await withProject({
        'main/main.tex': `\\documentclass[11pt]{book}\n\\${outer}{sub1/sub1.tex}`,
        'main/sub1/sub1.tex': `\\${inner}{sub1/sub2/sub2.tex}`,
        'main/sub1/sub2/sub2.tex': 'Child body.',
        'main/sub1/sub1/sub2/sub2.tex': 'Must not be included.'
      }, async uri => {
        const main = uri('main/main.tex');
        const current = uri('main/sub1/sub2/sub2.tex');
        assert.deepStrictEqual(paths(await existingFiles(main)),
          paths([main, uri('main/sub1/sub1.tex'), current]));
        assert.strictEqual((await LaTeXProject.resolveMainFile(current)).toString(), main.toString());
        const project = await LaTeXProject.create(current);
        assert.deepStrictEqual([project.classfile, project.classoption], ['book', '11pt']);
        const types = LaTeXProject.LaTeXFileType;
        assert.deepStrictEqual(project.filelist.map(entry => [path.normalize(entry.uri.fsPath), entry.type]), [
          [path.normalize(main.fsPath), types.main],
          [path.normalize(uri('main/sub1/sub1.tex').fsPath), outer === 'input' ? types.input : types.include],
          [path.normalize(current.fsPath), inner === 'input' ? types.input : types.include]
        ]);
      });
    });
  }

  for (const [outer, inner] of nestedCommands) {
    test(`does not discover a parent through a source-relative ${inner} after ${outer}`, async () => {
      await withProject({
        'main/main.tex': `\\documentclass{article}\n\\${outer}{sub1/sub1}`,
        'main/sub1/sub1.tex': `\\${inner}{sub2/sub2}`,
        'main/sub1/sub2/sub2.tex': 'Child body.'
      }, async uri => {
        const main = uri('main/main.tex');
        const current = uri('main/sub1/sub2/sub2.tex');
        assert.deepStrictEqual(paths(await existingFiles(main)),
          paths([main, uri('main/sub1/sub1.tex')]));
        assert.strictEqual((await LaTeXProject.resolveMainFile(current)).toString(), current.toString());
      });
    });
  }

  test('keeps parent segments and absolute inputs relative to the compilation directory', async () => {
    await withProject({
      'main/main.tex': '\\documentclass{article}\n\\input{sub/first}',
      'main/sub/first.tex': '\\input{../shared/second}',
      'shared/second.tex': '',
      'absolute.tex': 'Absolute body.'
    }, async uri => {
      const absolute = uri('absolute.tex');
      await fs.writeFile(uri('shared/second.tex').fsPath, `\\input{${absolute.fsPath.replace(/\\/g, '/')}}`);
      assert.deepStrictEqual(paths(await existingFiles(uri('main/main.tex'))),
        paths(['main/main.tex', 'main/sub/first.tex', 'shared/second.tex', 'absolute.tex'].map(uri)));
    });
  });

  test('resolves a shared source separately for each candidate main directory', async () => {
    await withProject({
      'first/main.tex': '\\documentclass{article}\n\\input{../shared}',
      'second/main.tex': '\\documentclass{book}\n\\input{../shared}',
      'shared.tex': '\\input{child}',
      'first/child.tex': 'First child.',
      'second/child.tex': 'Second child.',
      'child.tex': 'Must not be included.'
    }, async uri => {
      for (const directory of ['first', 'second', 'first']) {
        assert.deepStrictEqual(paths(await existingFiles(uri(`${directory}/main.tex`))),
          paths([uri(`${directory}/main.tex`), uri('shared.tex'), uri(`${directory}/child.tex`)]));
      }
    });
  });

  test('preserves configured strategy order and reads magic directives from the original file only', async () => {
    await withProject({
      'main.tex': '\\documentclass{memoir}\n\\input{child}',
      'magic.tex': '%#main missing.tex\n\\documentclass{report}',
      'child.tex': '%#main magic.tex\n%#custom retained\nChild body.'
    }, async uri => {
      const configuration = vscode.workspace.getConfiguration('vscode-fortex');
      const cases: [string[], string, string][] = [
        [['magic', 'guess', 'current'], 'magic.tex', 'report'],
        [['guess', 'magic', 'current'], 'main.tex', 'memoir'],
        [['current', 'magic', 'guess'], 'child.tex', '']
      ];
      for (const [order, main, documentClass] of cases) {
        await configuration.update('mainFileOrder', order, target);
        const result = await LaTeXProject.create(uri('child.tex'));
        assert.strictEqual(result.mainfile.toString(), uri(main).toString());
        assert.strictEqual(result.classfile, documentClass);
        assert.strictEqual(result.percent_sharp('main'), 'magic.tex');
        assert.strictEqual(result.percent_sharp('custom'), 'retained');
      }
    });
  });

  test('uses unsaved class and input changes without modifying saved source', async () => {
    const saved = '\\documentclass{article}\r\n\\input{saved}';
    await withProject({
      'main.tex': saved,
      'saved.tex': 'Saved child.',
      'unsaved.tex': 'Unsaved child.'
    }, async uri => {
      const main = uri('main.tex');
      const document = await vscode.workspace.openTextDocument(main);
      try {
        await replaceDocument(document, '\\documentclass[12pt]{book}\r\n\\input{unsaved}');
        assert.ok(document.isDirty);
        assert.deepStrictEqual(await classOptions(main), ['book', '12pt']);
        assert.deepStrictEqual(paths(await existingFiles(main)), paths([main, uri('unsaved.tex')]));
        assert.strictEqual(await fs.readFile(main.fsPath, 'utf8'), saved);
      } finally {
        if (!document.isClosed) {
          await replaceDocument(document, saved);
        }
      }
    });
  });

  test('preserves unexpanded class names and recovers after unfinished declarations', async () => {
    await withProject({
      'invalid.tex': '\\documentclass{ }\n\\documentclass[unfinished',
      'macro.tex': '\\documentclass{\\generated}',
      'recovered.tex': '\\documentclass{unfinished\n\\documentclass{book}'
    }, async uri => {
      assert.deepStrictEqual(await classOptions(uri('invalid.tex')), ['', '']);
      assert.deepStrictEqual(await classOptions(uri('macro.tex')), ['\\generated', '']);
      assert.deepStrictEqual(await classOptions(uri('recovered.tex')), ['book', '']);
    });
  });

  test('expands filename macros with spaces, quotes, and extension fallbacks', async () => {
    await withProject({
      'main.tex': String.raw`\documentclass{article}
\newcommand{\base}{my dir}
\newcommand{\folder}{\base/nested}
\input{\folder/x.foo}
\input{"with space"}
\input{fallback.foo}
\include{chapter.foo}
\include{explicit.tex}`,
      'my dir/nested/x.foo.tex': '',
      'my dir/nested/x.foo': '',
      'with space.tex': '',
      'fallback.foo': '',
      'chapter.foo.tex': '',
      'chapter.foo': '',
      'explicit.tex': '',
      'explicit.tex.tex': ''
    }, async uri => {
      assert.deepStrictEqual(paths(await existingFiles(uri('main.tex'))), paths([
        'main.tex', 'my dir/nested/x.foo.tex', 'with space.tex', 'fallback.foo', 'chapter.foo.tex', 'explicit.tex'
      ].map(uri)));
    });
  });

  test('applies definitions in input order and replays repeated files in their current macro state', async () => {
    await withProject({
      'main.tex': String.raw`\documentclass{article}
\newcommand{\dir}{a}
\input{selector}
\renewcommand{\dir}{b}
\input{selector}
\input{definitions}
\input{\dir/x}`,
      'selector.tex': String.raw`\input{\dir/x}`,
      'definitions.tex': String.raw`\renewcommand{\dir}{c}`,
      'a/x.tex': '', 'b/x.tex': '', 'c/x.tex': ''
    }, async uri => {
      assert.deepStrictEqual(paths(await existingFiles(uri('main.tex'))), paths([
        'main.tex', 'selector.tex', 'a/x.tex', 'b/x.tex', 'definitions.tex', 'c/x.tex'
      ].map(uri)));
    });
  });

  test('restores local filename definitions and retains global definitions across inputs', async () => {
    await withProject({
      'main.tex': String.raw`\documentclass{article}
\newcommand{\dir}{a}
{\renewcommand{\dir}{b}\input{\dir/x}}
\input{\dir/x}
\begingroup\input{global}\endgroup
\input{\dir/x}`,
      'global.tex': String.raw`\gdef\dir{c}`,
      'a/x.tex': '', 'b/x.tex': '', 'c/x.tex': ''
    }, async uri => {
      assert.deepStrictEqual(paths(await existingFiles(uri('main.tex'))), paths([
        'main.tex', 'b/x.tex', 'a/x.tex', 'global.tex', 'c/x.tex'
      ].map(uri)));
    });
  });

  test('ignores inputs in definitions and does not execute wrapper macros', async () => {
    await withProject({
      'main.tex': String.raw`\documentclass{article}
\newcommand\X{\input{hidden}\include{hidden-include}}
\X
\newcommand{\dir}{a}
\renewcommand{\dir}[1]{#1}
\input{\dir/x}
\input{visible}`,
      'hidden.tex': '', 'hidden-include.tex': '', 'a/x.tex': '', 'visible.tex': ''
    }, async uri => {
      assert.deepStrictEqual(paths(await existingFiles(uri('main.tex'))), paths(['main.tex', 'visible.tex'].map(uri)));
    });
  });

  test('rediscovers a guessed parent after only its filename macro definition changes', async () => {
    const saved = String.raw`\documentclass{article}
\newcommand{\dir}{a}
\input{\dir/x}`;
    await vscode.workspace.getConfiguration('vscode-fortex').update('mainFileOrder', ['guess', 'current'], target);
    await withProject({ 'main.tex': saved, 'a/x.tex': '', 'b/x.tex': '' }, async uri => {
      const main = await vscode.workspace.openTextDocument(uri('main.tex'));
      const child = uri('a/x.tex');
      try {
        assert.strictEqual((await LaTeXProject.resolveMainFile(child)).toString(), main.uri.toString());
        const switched = await projectAfterChange(child, project => project.mainfile.toString() === child.toString(),
          'the changed filename macro', () => replaceDocument(main, saved.replace('{a}', '{b}')));
        assert.strictEqual(switched.mainfile.toString(), child.toString());
        assert.deepStrictEqual(paths(await existingFiles(main.uri)), paths(['main.tex', 'b/x.tex'].map(uri)));
      } finally {
        if (!main.isClosed) { await replaceDocument(main, saved); }
      }
    });
  });

  test('switches from a fallback to a newly created preferred filename', async () => {
    await withProject({
      'main.tex': String.raw`\documentclass{article}\input{x.foo}`,
      'x.foo': ''
    }, async uri => {
      assert.deepStrictEqual(paths(await existingFiles(uri('main.tex'))), paths(['main.tex', 'x.foo'].map(uri)));
      await fs.writeFile(uri('x.foo.tex').fsPath, '', 'utf8');
      assert.deepStrictEqual(paths(await existingFiles(uri('main.tex'))), paths(['main.tex', 'x.foo.tex'].map(uri)));
    });
  });

  test('invalidates braced filenames when a continuation after a comment changes', async () => {
    const saved = '\\documentclass{article}\n\\input{a/% continued\n    x}';
    await vscode.workspace.getConfiguration('vscode-fortex').update('mainFileOrder', ['guess', 'current'], target);
    await withProject({ 'main.tex': saved, 'a/x.tex': '', 'a/y.tex': '' }, async uri => {
      const main = await vscode.workspace.openTextDocument(uri('main.tex'));
      const child = uri('a/x.tex');
      try {
        assert.strictEqual((await LaTeXProject.resolveMainFile(child)).toString(), main.uri.toString());
        await projectAfterChange(child, project => project.mainfile.toString() === child.toString(),
          'the edited braced filename continuation', () => replaceDocument(main, saved.replace('    x}', '    y}')));
      } finally {
        if (!main.isClosed) { await replaceDocument(main, saved); }
      }
    });
  });

  test('rechecks a new non-tex dependency created before its existence result is registered', async () => {
    await withProject({
      'main.tex': String.raw`\documentclass{article}\input{late.foo}`,
      'child.tex': ''
    }, async uri => {
      const resolver: { resolveInputFile: typeof import('../project/InputFileResolver').resolveInputFile }
        = require('../project/InputFileResolver');
      const originalResolve = resolver.resolveInputFile;
      let created = false;
      resolver.resolveInputFile = async (...args) => {
        const result = await originalResolve(...args);
        if (!created && result.status === 'missing' && result.filename === 'late.foo') {
          created = true;
          await fs.writeFile(uri('late.foo').fsPath, String.raw`\input{child}`, 'utf8');
        }
        return result;
      };
      try {
        const traced: vscode.Uri[] = [];
        const project = await LaTeXProject.create(uri('main.tex'), { onDependency: file => { traced.push(file); } });
        assert.deepStrictEqual(paths(project.filelist.filter(entry => entry.exists).map(entry => entry.uri)),
          paths(['main.tex', 'late.foo', 'child.tex'].map(uri)));
        assert.ok(traced.some(file => file.toString() === uri('late.foo').toString()));
        assert.ok(created);
      } finally {
        resolver.resolveInputFile = originalResolve;
      }
    });
  });

  test('reads fresh sources per request and does no source reads in response to edits', async () => {
    const saved = '%#main main.tex\n\\documentclass[10pt]{article}\n%#t2dopt --before\nOriginal body.';
    await withProject({ 'main.tex': saved }, async uri => {
      const document = await vscode.workspace.openTextDocument(uri('main.tex'));
      let reads = 0;
      const options = { readSource: async (file: vscode.Uri) => {
        assert.strictEqual(file.toString(), document.uri.toString());
        reads++;
        return document.getText();
      } };
      try {
        const first = await LaTeXProject.create(document.uri, options);
        assert.strictEqual(reads, 1, 'Each source is shared only within one request');
        await replaceDocument(document, saved.replace('Original body.', 'Edited body.'));
        assert.strictEqual(reads, 1, 'Editing must not eagerly read project sources');
        assert.strictEqual((await LaTeXProject.resolveMainFile(document.uri, options)).toString(), first.mainfile.toString());
        assert.strictEqual(reads, 2);
        await replaceDocument(document, saved.replace('t2dopt --before', 't2dopt --after'));
        assert.strictEqual(reads, 2);
        const edited = await LaTeXProject.create(document.uri, options);
        assert.strictEqual(edited.percent_sharp('t2dopt'), '--after');
        assert.strictEqual(edited.mainfile.toString(), first.mainfile.toString());
        assert.strictEqual(reads, 3);

        await replaceDocument(document, saved.replace('[10pt]{article}', '[12pt]{book}'));
        const changedClass = await LaTeXProject.create(document.uri, options);
        assert.deepStrictEqual([changedClass.classfile, changedClass.classoption], ['book', '12pt']);
        assert.strictEqual(reads, 4);
        assert.strictEqual(await fs.readFile(document.uri.fsPath, 'utf8'), saved);
      } finally {
        if (!document.isClosed) { await replaceDocument(document, saved); }
      }
    });
  });

  test('uses the caller source snapshot for parent discovery and traces missing dependencies', async () => {
    await vscode.workspace.getConfiguration('vscode-fortex').update('mainFileOrder', ['guess', 'current'], target);
    const savedMain = '\\documentclass[10pt]{article}\n\\input{nested/child}\n\\input{missing.foo}';
    await withProject({ 'main.tex': savedMain, 'nested/child.tex': 'Child body.' }, async uri => {
      const main = await vscode.workspace.openTextDocument(uri('main.tex'));
      try {
        await replaceDocument(main, '\\documentclass{book}\nNo inputs in the live buffer.');
        const reads = new Map<string, number>();
        const dependencies: string[] = [];
        const directories: string[] = [];
        const project = await LaTeXProject.create(uri('nested/child.tex'), {
          readSource: async file => {
            const key = path.normalize(file.fsPath);
            reads.set(key, (reads.get(key) ?? 0) + 1);
            return fs.readFile(file.fsPath, 'utf8');
          },
          onDependency: file => { dependencies.push(path.normalize(file.fsPath)); },
          onDirectory: directory => { directories.push(path.normalize(directory.fsPath)); }
        });
        assert.strictEqual(project.mainfile.toString(), main.uri.toString());
        assert.deepStrictEqual([project.classfile, project.classoption], ['article', '10pt']);
        assert.ok(dependencies.includes(path.normalize(uri('missing.foo.tex').fsPath)));
        assert.ok(dependencies.includes(path.normalize(uri('missing.foo').fsPath)));
        assert.ok(directories.includes(path.normalize(uri('nested').fsPath)));
        assert.ok(directories.includes(path.normalize(uri('').fsPath)));
        assert.strictEqual(new Set(dependencies).size, dependencies.length);
        assert.ok([...reads.values()].every(count => count === 1), 'Repeated traversal must share reads within one request');
        assert.strictEqual((await LaTeXProject.resolveMainFile(uri('nested/child.tex'))).toString(), uri('nested/child.tex').toString(),
          'A later default request must read the live buffer instead of retaining the saved snapshot');
      } finally {
        if (!main.isClosed) { await replaceDocument(main, savedMain); }
      }
    });
  });

  test('keeps a supplied snapshot stable when a live buffer changes during discovery', async () => {
    const saved = '%#main first.tex\nChild body.';
    await withProject({
      'child.tex': saved,
      'first.tex': '\\documentclass{article}',
      'second.tex': '\\documentclass{book}'
    }, async uri => {
      const document = await vscode.workspace.openTextDocument(uri('child.tex'));
      const started = deferred<void>();
      const release = deferred<void>();
      let held = false;
      const reads = new Map<string, number>();
      const pending = LaTeXProject.resolveMainFile(document.uri, {
        readSource: async file => {
          reads.set(file.toString(), (reads.get(file.toString()) ?? 0) + 1);
          const source = await fs.readFile(file.fsPath, 'utf8');
          if (file.toString() === uri('first.tex').toString() && !held) {
            held = true;
            started.resolve();
            await release.promise;
          }
          return source;
        }
      });
      try {
        await bounded(started.promise, 'the supplied saved main snapshot');
        await replaceDocument(document, saved.replace('first.tex', 'second.tex'));
        release.resolve();
        assert.strictEqual((await bounded(pending, 'the saved-snapshot result')).toString(), uri('first.tex').toString());
        assert.strictEqual(reads.size, 2);
        assert.ok([...reads.values()].every(count => count === 1), 'Typing must not restart a disk-backed request');
        assert.strictEqual((await LaTeXProject.resolveMainFile(document.uri)).toString(), uri('second.tex').toString());
      } finally {
        release.resolve();
        await pending.catch(() => undefined);
        if (!document.isClosed) { await replaceDocument(document, saved); }
      }
    });
  });

  test('captures the strategy order once without restarting when settings change', async () => {
    const config = vscode.workspace.getConfiguration('vscode-fortex');
    await config.update('mainFileOrder', ['magic', 'current'], target);
    await withProject({
      'child.tex': '%#main main.tex\nChild body.',
      'main.tex': '\\documentclass{article}'
    }, async uri => {
      const started = deferred<void>();
      const release = deferred<void>();
      const documentText: { readDocumentText: typeof import('../workspace').readDocumentText }
        = require('../workspace/DocumentText');
      const originalRead = documentText.readDocumentText;
      let reads = 0;
      documentText.readDocumentText = async file => {
        const source = await originalRead(file);
        if (file.toString() === uri('child.tex').toString() && ++reads === 1) {
          started.resolve();
          await release.promise;
        }
        return source;
      };
      const pending = LaTeXProject.resolveMainFile(uri('child.tex'));
      try {
        await bounded(started.promise, 'the initial strategy order');
        await config.update('mainFileOrder', ['current', 'magic'], target);
        release.resolve();
        assert.strictEqual((await bounded(pending, 'the original strategy result')).toString(), uri('main.tex').toString());
        assert.strictEqual(reads, 1);
        assert.strictEqual((await LaTeXProject.resolveMainFile(uri('child.tex'))).toString(), uri('child.tex').toString());
        assert.strictEqual(reads, 2);
      } finally {
        release.resolve();
        await pending.catch(() => undefined);
        documentText.readDocumentText = originalRead;
      }
    });
  });

  test('updates an unsaved uppercase main directive and honors a changed strategy order', async () => {
    const saved = '%#MAIN first.tex\nChild body.';
    await withProject({
      'first.tex': '\\documentclass{article}',
      'second.tex': '\\documentclass{book}',
      'child.tex': saved
    }, async uri => {
      const document = await vscode.workspace.openTextDocument(uri('child.tex'));
      try {
        assert.strictEqual((await LaTeXProject.resolveMainFile(document.uri)).toString(), uri('first.tex').toString());
        const switched = await projectAfterChange(document.uri, project => project.mainfile.toString() === uri('second.tex').toString(),
          'the unsaved uppercase main directive', () => replaceDocument(document, saved.replace('first.tex', 'second.tex')));
        assert.strictEqual(switched.classfile, 'book');

        await projectAfterChange(document.uri, project => project.mainfile.toString() === document.uri.toString(),
          'the updated main-file strategy order', () => vscode.workspace.getConfiguration('vscode-fortex')
            .update('mainFileOrder', ['current', 'magic'], target));
        assert.strictEqual(await fs.readFile(document.uri.fsPath, 'utf8'), saved);
      } finally {
        if (!document.isClosed) { await replaceDocument(document, saved); }
      }
    });
  });

  test('rediscovers the parent after unsaved input changes in nonactive candidate documents', async () => {
    const firstSource = '\\documentclass{article}\n\\input{child}';
    const secondSource = '\\documentclass{book}';
    await vscode.workspace.getConfiguration('vscode-fortex').update('mainFileOrder', ['guess', 'current'], target);
    await withProject({ 'first.tex': firstSource, 'second.tex': secondSource, 'child.tex': 'Child body.' }, async uri => {
      const child = await vscode.workspace.openTextDocument(uri('child.tex'));
      const first = await vscode.workspace.openTextDocument(uri('first.tex'));
      const second = await vscode.workspace.openTextDocument(uri('second.tex'));
      await vscode.window.showTextDocument(child, { preview: false });
      try {
        assert.strictEqual((await LaTeXProject.resolveMainFile(child.uri)).toString(), first.uri.toString());
        await projectAfterChange(child.uri, project => project.mainfile.toString() === second.uri.toString(),
          'the changed nonactive parent candidates', async () => {
            await replaceDocument(first, '\\documentclass{article}');
            await replaceDocument(second, secondSource + '\n\\input{child}');
          });
        assert.strictEqual(vscode.window.activeTextEditor?.document.uri.toString(), child.uri.toString());
      } finally {
        if (!first.isClosed) { await replaceDocument(first, firstSource); }
        if (!second.isClosed) { await replaceDocument(second, secondSource); }
      }
    });
  });

  test('rediscovers a guessed parent after an external candidate is created and deleted', async () => {
    await vscode.workspace.getConfiguration('vscode-fortex').update('mainFileOrder', ['guess', 'current'], target);
    await withProject({ 'child.tex': 'Standalone child.' }, async uri => {
      const child = uri('child.tex');
      const parent = uri('parent.tex');
      assert.strictEqual((await LaTeXProject.resolveMainFile(child)).toString(), child.toString());
      await projectAfterChange(child, project => project.mainfile.toString() === parent.toString(),
        'the externally created parent', () => fs.writeFile(parent.fsPath, '\\documentclass{report}\n\\input{child}', 'utf8'));
      await projectAfterChange(child, project => project.mainfile.toString() === child.toString(),
        'the externally deleted parent', () => fs.unlink(parent.fsPath));
    });
  });

  test('keeps concurrent requests independent and retries failed reads on later requests', async () => {
    await withProject({
      'child.tex': '%#main main.tex\nChild body.',
      'main.tex': '\\documentclass{article}\n\\input{child}',
      'retry.tex': '%#main retry-main.tex\nRetry body.',
      'retry-main.tex': '\\documentclass{book}'
    }, async uri => {
      const document = await vscode.workspace.openTextDocument(uri('child.tex'));
      await vscode.window.showTextDocument(document, { preview: false });
      const started = deferred<void>();
      const release = deferred<void>();
      const documentText: { readDocumentText: typeof import('../workspace').readDocumentText }
        = require('../workspace/DocumentText');
      const originalRead = documentText.readDocumentText;
      let held = false;
      let mainReads = 0;
      let retryReads = 0;
      const failure = new Error('Temporary discovery failure');
      documentText.readDocumentText = async file => {
        if (file.toString() === uri('retry-main.tex').toString() && ++retryReads === 1) { throw failure; }
        if (file.toString() === uri('main.tex').toString()) { mainReads++; }
        const source = await originalRead(file);
        if (file.toString() === uri('main.tex').toString() && !held) {
          held = true;
          started.resolve();
          await release.promise;
        }
        return source;
      };
      try {
        const explicit = LaTeXProject.create(document.uri);
        await bounded(started.promise, 'the first pending discovery');
        const implicit = LaTeXProject.create(null);
        release.resolve();
        const [fromExplicit, fromImplicit] = await bounded(Promise.all([explicit, implicit]), 'the concurrent requests');
        assert.strictEqual(fromExplicit.file?.toString(), document.uri.toString());
        assert.strictEqual(fromImplicit.file, null);
        assert.strictEqual(fromExplicit.mainfile.toString(), fromImplicit.mainfile.toString());
        assert.strictEqual(fromExplicit.mainfile.toString(), uri('main.tex').toString());
        assert.strictEqual(mainReads, 2, 'Each concurrent request must read its own source snapshot');

        await assert.rejects(LaTeXProject.resolveMainFile(uri('retry.tex')), error => error === failure);
        assert.strictEqual((await LaTeXProject.resolveMainFile(uri('retry.tex'))).toString(), uri('retry-main.tex').toString());
        assert.strictEqual(retryReads, 2);
        assert.strictEqual((await LaTeXProject.create(uri('retry.tex'))).classfile, 'book');
      } finally {
        release.resolve();
        documentText.readDocumentText = originalRead;
      }
    });
  });

  test('does not restart an in-progress discovery when a directive changes', async () => {
    const saved = '%#main first.tex\nChild body.';
    await withProject({
      'first.tex': '\\documentclass{article}',
      'second.tex': '\\documentclass{report}',
      'child.tex': saved
    }, async uri => {
      const document = await vscode.workspace.openTextDocument(uri('child.tex'));
      const started = deferred<void>();
      const release = deferred<void>();
      const documentText: { readDocumentText: typeof import('../workspace').readDocumentText }
        = require('../workspace/DocumentText');
      const originalRead = documentText.readDocumentText;
      let held = false;
      documentText.readDocumentText = async file => {
        const source = await originalRead(file);
        if (file.toString() === uri('first.tex').toString() && !held) {
          held = true;
          started.resolve();
          await release.promise;
        }
        return source;
      };
      try {
        const pending = LaTeXProject.resolveMainFile(document.uri);
        await bounded(started.promise, 'the pending original parent');
        await replaceDocument(document, saved.replace('first.tex', 'second.tex'));
        const refreshed = LaTeXProject.resolveMainFile(document.uri);
        release.resolve();
        const [initial, latest] = await bounded(Promise.all([pending, refreshed]), 'the independent parent requests');
        assert.strictEqual(initial.toString(), uri('first.tex').toString());
        assert.strictEqual(latest.toString(), uri('second.tex').toString());
        const project = await LaTeXProject.create(document.uri);
        assert.strictEqual(project.classfile, 'report');
        assert.strictEqual(project.percent_sharp('main'), 'second.tex');
      } finally {
        release.resolve();
        documentText.readDocumentText = originalRead;
        if (!document.isClosed) { await replaceDocument(document, saved); }
      }
    });
  });

  test('cancels pending discovery on disposal and allows a fresh later request', async () => {
    await vscode.workspace.getConfiguration('vscode-fortex').update('mainFileOrder', ['current'], target);
    await withProject({ 'main.tex': '\\documentclass{article}' }, async uri => {
      const started = deferred<void>();
      const release = deferred<void>();
      const documentText: { readDocumentText: typeof import('../workspace').readDocumentText }
        = require('../workspace/DocumentText');
      const originalRead = documentText.readDocumentText;
      documentText.readDocumentText = async file => {
        const source = await originalRead(file);
        if (file.toString() === uri('main.tex').toString()) {
          started.resolve();
          await release.promise;
        }
        return source;
      };
      try {
        const pending = LaTeXProject.resolveMainFile(uri('main.tex'));
        const cancelled = assert.rejects(pending, error => error instanceof vscode.CancellationError);
        await bounded(started.promise, 'discovery before disposal');
        LaTeXProject.dispose();
        release.resolve();
        await bounded(cancelled, 'the disposed discovery to cancel');

        documentText.readDocumentText = originalRead;
        const restarted = await LaTeXProject.resolveMainFile(uri('main.tex'));
        assert.strictEqual(restarted.toString(), uri('main.tex').toString());
        assert.strictEqual((await LaTeXProject.create(uri('main.tex'))).classfile, 'article');
      } finally {
        release.resolve();
        documentText.readDocumentText = originalRead;
      }
    });
  });

  test('does not replace a pending reader result with a newer unsaved buffer', async () => {
    const firstSource = '\\documentclass{article}\n\\input{child}';
    await vscode.workspace.getConfiguration('vscode-fortex').update('mainFileOrder', ['guess', 'current'], target);
    await withProject({
      'a.tex': firstSource,
      'b.tex': '\\documentclass{book}\n\\input{child}',
      'child.tex': 'Child body.'
    }, async uri => {
      const started = deferred<void>();
      const release = deferred<void>();
      const documentText: { readDocumentText: typeof import('../workspace').readDocumentText }
        = require('../workspace/DocumentText');
      const originalRead = documentText.readDocumentText;
      let held = false;
      let document: vscode.TextDocument | undefined;
      documentText.readDocumentText = async file => {
        const source = await originalRead(file);
        if (file.toString() === uri('a.tex').toString() && !held) {
          held = true;
          started.resolve();
          await release.promise;
        }
        return source;
      };
      try {
        const pending = LaTeXProject.create(uri('child.tex'));
        await bounded(started.promise, 'the original candidate disk read');
        document = await vscode.workspace.openTextDocument(uri('a.tex'));
        await replaceDocument(document, '\\documentclass{article}');
        const newer = await LaTeXProject.create(uri('child.tex'));
        assert.strictEqual(newer.mainfile.toString(), uri('b.tex').toString());

        release.resolve();
        const earlier = await bounded(pending, 'discovery after the original disk read completes');
        assert.strictEqual(earlier.mainfile.toString(), uri('a.tex').toString());

        await replaceDocument(document, firstSource);
        const reverted = await LaTeXProject.create(uri('child.tex'));
        assert.strictEqual(reverted.mainfile.toString(), uri('a.tex').toString());
      } finally {
        release.resolve();
        documentText.readDocumentText = originalRead;
        if (document && !document.isClosed) { await replaceDocument(document, firstSource); }
      }
    });
  });
});
