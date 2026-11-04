import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import LaTeXProject from '../project/LaTeXProject';
import StructureService from '../structure/StructureService';
import { StructureNode, StructureSnapshot } from '../structure/StructureTypes';
import * as Workspace from '../workspace';

function allNodes(nodes: StructureNode[]): StructureNode[] {
  return nodes.flatMap(node => [node, ...allNodes(node.children)]);
}

function sections(snapshot: StructureSnapshot): StructureNode[] {
  return allNodes(snapshot.roots).filter(node => node.kind === 'section');
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, description: string, timeout = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), timeout);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function observeSnapshot(
  service: StructureService,
  matches: (snapshot: StructureSnapshot) => boolean,
  description: string,
  action: () => Promise<unknown> = async () => undefined
): Promise<StructureSnapshot> {
  let subscription: vscode.Disposable | undefined;
  const changed = new Promise<StructureSnapshot>(resolve => {
    subscription = service.onDidChange(snapshot => {
      if (snapshot && matches(snapshot)) { resolve(snapshot); }
    });
  });
  try {
    await action();
    return await bounded(changed, description);
  } finally {
    subscription?.dispose();
  }
}

async function replaceDocument(document: vscode.TextDocument, text: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
  assert.ok(await vscode.workspace.applyEdit(edit));
}

async function withProject(
  files: Record<string, string>,
  run: (uri: (name: string) => vscode.Uri) => Promise<void>
): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fortex-structure-'));
  const uri = (name: string) => vscode.Uri.file(path.join(directory, name));
  let testError: unknown;
  try {
    for (const [name, text] of Object.entries(files)) {
      const file = uri(name);
      await fs.mkdir(path.dirname(file.fsPath), { recursive: true });
      await fs.writeFile(file.fsPath, text, 'utf8');
    }
    await run(uri);
  } catch (error) {
    testError = error;
    throw error;
  } finally {
    assert.strictEqual(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('fortex-structure-'));
    try {
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (cleanupError) {
      if (testError) { throw new AggregateError([testError, cleanupError], 'Structure test and cleanup both failed'); }
      throw cleanupError;
    }
  }
}

async function withService(run: (service: StructureService) => Promise<void>): Promise<void> {
  const service = new StructureService(false);
  try {
    await run(service);
  } finally {
    service.dispose();
  }
}

async function documentStructure(document: vscode.TextDocument): Promise<StructureNode[]> {
  const service = new StructureService(false);
  try {
    await service.refresh(document);
    return service.snapshot!.roots;
  } finally {
    service.dispose();
  }
}

suite('Project structure service', function () {
  this.timeout(20000);
  let originalResolveMain: typeof LaTeXProject.resolveMainFile;
  let originalCreate: typeof LaTeXProject.create;
  let target: vscode.ConfigurationTarget;
  const originalSettings = new Map<string, unknown>();

  setup(async () => {
    originalResolveMain = LaTeXProject.resolveMainFile;
    originalCreate = LaTeXProject.create;
    target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    const config = vscode.workspace.getConfiguration('vscode-fortex');
    for (const [key, value] of Object.entries({
      'outline.followIncludes': true,
      'outline.theoremEnvironments': {},
      mainFileOrder: ['magic', 'current']
    })) {
      const previous = config.inspect(key);
      originalSettings.set(key, target === vscode.ConfigurationTarget.Workspace ? previous?.workspaceValue : previous?.globalValue);
      await config.update(key, value, target);
    }
  });

  teardown(async () => {
    LaTeXProject.resolveMainFile = originalResolveMain;
    LaTeXProject.create = originalCreate;
    const config = vscode.workspace.getConfiguration('vscode-fortex');
    for (const [key, value] of originalSettings) {
      await config.update(key, value, target);
    }
    originalSettings.clear();
  });

  test('resolves only the main file and preserves source order through its own input expansion', async () => {
    const mainText = '\\documentclass{article}\n\\section{Before}\n\\input{chapters/child}\n\\section{After}';
    const childText = '\\subsection{Included child}\nIncluded body';
    await withProject({ 'main.tex': mainText, 'chapters/child.tex': childText }, async uri => {
      const main = uri('main.tex');
      const child = uri('chapters/child.tex');
      const document = await vscode.workspace.openTextDocument(child);
      const calls: (vscode.Uri | null)[] = [];
      let projectsCreated = 0;
      LaTeXProject.create = async () => {
        projectsCreated++;
        throw new Error('Structure refresh must not collect a project file list');
      };
      LaTeXProject.resolveMainFile = async active => {
        calls.push(active);
        return main;
      };
      await withService(async service => {
        await service.refresh(document);
        const snapshot = service.snapshot;
        assert.ok(snapshot);
        assert.deepStrictEqual(calls.map(active => active?.toString()), [child.toString()]);
        assert.strictEqual(projectsCreated, 0);
        assert.strictEqual(snapshot.main.toString(), main.toString());
        assert.strictEqual(snapshot.followIncludes, true);
        const headings = sections(snapshot);
        assert.deepStrictEqual(headings.map(node => node.title), ['Before', 'Included child', 'After']);
        assert.deepStrictEqual(snapshot.roots.map(node => node.title), ['Before', 'After']);
        assert.strictEqual(snapshot.roots[0].children[0], headings[1]);
        assert.strictEqual(headings[1].declarationRange.uri.toString(), child.toString());
        assert.strictEqual(headings[1].declarationRange.start, childText.indexOf('\\subsection'));
        assert.strictEqual(headings[1].extentEnd.uri.toString(), main.toString());
        assert.strictEqual(headings[1].extentEnd.start, mainText.indexOf('\\section{After}'));
      });
    });
  });

  test('resolves spaced, parent-relative and absolute input paths from the main directory', async () => {
    await withProject({
      'main/main.tex': '\\documentclass{article}\n\\section{Root}',
      'main/chapters/part (one).TEX': '\\subsection{Spaced}',
      'shared.tex': '\\subsection{Parent relative}',
      'absolute.tex': '\\subsection{Absolute}'
    }, async uri => {
      const main = uri('main/main.tex');
      const spaced = uri('main/chapters/part (one).TEX');
      const shared = uri('shared.tex');
      const absolute = uri('absolute.tex');
      await fs.writeFile(main.fsPath, '\\documentclass{article}\n\\section{Root}\n' +
        '\\input{ ./chapters/part (one).TEX }\n\\include{../shared}\n' +
        `\\input{${absolute.fsPath.replace(/\\/g, '/')}}`);
      LaTeXProject.resolveMainFile = async () => main;
      await withService(async service => {
        await service.refresh(await vscode.workspace.openTextDocument(main));
        assert.ok(service.snapshot);
        assert.deepStrictEqual(sections(service.snapshot).map(node => node.title),
          ['Root', 'Spaced', 'Parent relative', 'Absolute']);
        assert.deepStrictEqual(sections(service.snapshot).map(node => node.declarationRange.uri.toString()),
          [main, spaced, shared, absolute].map(file => file.toString()));
        assert.strictEqual(allNodes(service.snapshot.roots).filter(node => node.kind === 'issue').length, 0);
      });
    });
  });

  test('honors a real parent magic directive from an included document', async () => {
    await withProject({
      'main.tex': '\\documentclass{article}\n\\section{Parent}\n\\input{chapters/child}',
      'chapters/child.tex': '%#main ../main.tex\n\\subsection{Child}'
    }, async uri => {
      await withService(async service => {
        await service.refresh(await vscode.workspace.openTextDocument(uri('chapters/child.tex')));
        assert.ok(service.snapshot);
        assert.strictEqual(service.snapshot.main.toString(), uri('main.tex').toString());
        assert.deepStrictEqual(sections(service.snapshot).map(node => node.title), ['Parent', 'Child']);
      });
    });
  });

  test('shares literal filename resolution for quotes, spaces and extension fallbacks', async () => {
    await withProject({
      'main.tex': '\\section{Root}\n\\input{"with space"}\n\\input{"quoted name"}\n' +
        '\\input{unknown.foo}\n\\input{fallback.foo}\n\\input{exact.sty}\n\\include{included.foo}\n' +
        '\\input{trailing }\n\\include{fallback.foo}\n\\section{After}',
      'with space.tex': '\\subsection{Spaced}',
      'quoted name.tex': '\\subsection{Quoted name}',
      'unknown.foo.tex': '\\subsection{Preferred extension}',
      'unknown.foo': '\\subsection{Wrong fallback}',
      'fallback.foo': '\\subsection{Fallback}',
      'exact.sty': '\\subsection{Exact extension}',
      'exact.sty.tex': '\\subsection{Wrong appended extension}',
      'included.foo.tex': '\\subsection{Included extension}',
      'trailing .tex': '\\subsection{Trailing space}'
    }, async uri => {
      const main = uri('main.tex');
      LaTeXProject.resolveMainFile = async () => main;
      await withService(async service => {
        await service.refresh(await vscode.workspace.openTextDocument(main));
        assert.ok(service.snapshot);
        assert.deepStrictEqual(sections(service.snapshot).map(node => node.title),
          ['Root', 'Spaced', 'Quoted name', 'Preferred extension', 'Fallback',
            'Exact extension', 'Included extension', 'Trailing space', 'After']);
        const issues = allNodes(service.snapshot.roots).filter(node => node.kind === 'issue');
        assert.deepStrictEqual(issues.map(node => node.title), ['Missing include: fallback.foo.tex']);
      });
    });
  });

  test('does not follow macro filenames or inputs hidden in macro definitions', async () => {
    await withProject({
      'main.tex': '\\newcommand{\\dir}{chapters}\n\\newcommand\\load{\\input{literal}}\n' +
        '\\section{Root}\n\\input{\\dir/child}\n\\load\n\\input{literal}\n',
      'chapters/child.tex': '\\subsection{Macro child}',
      'literal.tex': '\\subsection{Literal child}'
    }, async uri => {
      const main = uri('main.tex');
      LaTeXProject.resolveMainFile = async () => main;
      await withService(async service => {
        await service.refresh(await vscode.workspace.openTextDocument(main));
        assert.ok(service.snapshot);
        assert.deepStrictEqual(sections(service.snapshot).map(node => node.title), ['Root', 'Literal child']);
      });
    });
  });

  test('does not follow unbraced literal, quoted or macro input forms', async () => {
    await withProject({
      'main.tex': '\\newcommand{\\dir}{chapters}\n\\section{Root}\n\\input bare.tex\n' +
        '\\input "bare quoted"\n\\input \\dir/child.tex\n\\section{After}\n\\input{literal}',
      'bare.tex': '\\subsection{Bare child}',
      'bare quoted.tex': '\\subsection{Bare quoted child}',
      'chapters/child.tex': '\\subsection{Bare macro child}',
      'literal.tex': '\\subsection{Braced child}'
    }, async uri => {
      const main = uri('main.tex');
      LaTeXProject.resolveMainFile = async () => main;
      await withService(async service => {
        await service.refresh(await vscode.workspace.openTextDocument(main));
        assert.ok(service.snapshot);
        assert.deepStrictEqual(sections(service.snapshot).map(node => node.title), ['Root', 'After', 'Braced child']);
      });
    });
  });

  for (const [outer, inner] of [['include', 'input'], ['input', 'include'], ['include', 'include']]) {
    test(`resolves nested ${inner} paths from the main directory after an ${outer}`, async () => {
      await withProject({
        'main/main.tex': `\\documentclass{article}\n\\section{Root}\n\\${outer}{sub1/sub1}`,
        'main/sub1/sub1.tex': `\\subsection{Child}\n\\${inner}{sub1/sub2/sub2.tex}`,
        'main/sub1/sub2/sub2.tex': '\\subsubsection{Grandchild}',
        'main/sub1/sub1/sub2/sub2.tex': '\\subsubsection{Wrong directory}'
      }, async uri => {
        const main = uri('main/main.tex');
        const child = uri('main/sub1/sub1.tex');
        const grandchild = uri('main/sub1/sub2/sub2.tex');
        LaTeXProject.resolveMainFile = async () => main;
        await withService(async service => {
          await service.refresh(await vscode.workspace.openTextDocument(grandchild));
          assert.ok(service.snapshot);
          assert.deepStrictEqual(sections(service.snapshot).map(node => node.title), ['Root', 'Child', 'Grandchild']);
          assert.deepStrictEqual(sections(service.snapshot).map(node => node.declarationRange.uri.toString()),
            [main, child, grandchild].map(file => file.toString()));
          assert.strictEqual(allNodes(service.snapshot.roots).filter(node => node.kind === 'issue').length, 0);
        });
      });
    });
  }

  test('reports nested paths that exist only relative to the included source as missing', async () => {
    await withProject({
      'main/main.tex': '\\documentclass{article}\n\\section{Root}\n\\input{sub1/sub1}',
      'main/sub1/sub1.tex': '\\subsection{Child}\n\\input{sub2/sub2}\n\\subsection{After}',
      'main/sub1/sub2/sub2.tex': '\\subsubsection{Wrongly included}'
    }, async uri => {
      const main = uri('main/main.tex');
      const child = uri('main/sub1/sub1.tex');
      LaTeXProject.resolveMainFile = async () => main;
      await withService(async service => {
        await service.refresh(await vscode.workspace.openTextDocument(child));
        assert.ok(service.snapshot);
        assert.deepStrictEqual(sections(service.snapshot).map(node => node.title), ['Root', 'Child', 'After']);
        const issues = allNodes(service.snapshot.roots).filter(node => node.kind === 'issue');
        assert.strictEqual(issues.length, 1);
        assert.strictEqual(issues[0].title, 'Missing include: sub2.tex');
        assert.strictEqual(issues[0].declarationRange.uri.toString(), child.toString());
      });
    });
  });

  test('keeps local mode in the active file without resolving a parent or expanding inputs', async () => {
    await vscode.workspace.getConfiguration('vscode-fortex').update('outline.followIncludes', false, target);
    await withProject({
      'main.tex': '\\documentclass{article}\n\\section{Parent}\n\\input{child}',
      'child.tex': '%#main main.tex\n\\section{Local}\n\\input{nested}',
      'nested.tex': '\\subsection{Nested}'
    }, async uri => {
      LaTeXProject.resolveMainFile = async () => assert.fail('Local mode must not resolve a main document');
      await withService(async service => {
        await service.refresh(await vscode.workspace.openTextDocument(uri('child.tex')));
        assert.ok(service.snapshot);
        assert.strictEqual(service.snapshot.main.toString(), uri('child.tex').toString());
        assert.strictEqual(service.snapshot.followIncludes, false);
        assert.deepStrictEqual(sections(service.snapshot).map(node => node.title), ['Local']);
      });
    });
  });

  test('retains repeated input occurrences while aggregating labels by physical declaration', async () => {
    await withProject({
      'main.tex': '\\label{duplicate}\n\\section{Root}\n\\input{child}\n\\input{child}',
      'child.tex': '\\subsection{Repeated}\n\\label{shared}\n\\label{duplicate}\nBody'
    }, async uri => {
      const main = uri('main.tex');
      LaTeXProject.resolveMainFile = async () => main;
      await withService(async service => {
        await service.refresh(await vscode.workspace.openTextDocument(main));
        const snapshot = service.snapshot;
        assert.ok(snapshot);
        const repeated = sections(snapshot).filter(node => node.title === 'Repeated');
        assert.strictEqual(repeated.length, 2);
        assert.notStrictEqual(repeated[0].id, repeated[1].id);
        assert.deepStrictEqual(repeated[0].declarationRange, repeated[1].declarationRange);
        assert.deepStrictEqual(repeated.map(node => node.labels.map(label => label.key)), [['shared', 'duplicate'], ['shared', 'duplicate']]);
        const shared = snapshot.labels.filter(entry => entry.label.key === 'shared');
        assert.strictEqual(shared.length, 1);
        assert.strictEqual(shared[0].inclusionCount, 2);
        assert.strictEqual(shared[0].duplicate, false);
        const duplicate = snapshot.labels.filter(entry => entry.label.key === 'duplicate');
        assert.strictEqual(duplicate.length, 2);
        assert.deepStrictEqual(duplicate.map(entry => entry.inclusionCount).sort(), [1, 2]);
        assert.ok(duplicate.every(entry => entry.duplicate));
      });
    });
  });

  test('reports cyclic and missing includes at their call sites and continues later headings', async () => {
    const mainText = '\\section{Before}\n\\input{child}\n\\input{missing}\n\\section{After}';
    const childText = '\\subsection{Child}\n\\input{main}';
    await withProject({ 'main.tex': mainText, 'child.tex': childText }, async uri => {
      const main = uri('main.tex');
      LaTeXProject.resolveMainFile = async () => main;
      await withService(async service => {
        await service.refresh(await vscode.workspace.openTextDocument(main));
        const snapshot = service.snapshot;
        assert.ok(snapshot);
        assert.deepStrictEqual(sections(snapshot).map(node => node.title), ['Before', 'Child', 'After']);
        const issues = allNodes(snapshot.roots).filter(node => node.kind === 'issue');
        assert.strictEqual(issues.length, 2);
        const cyclic = issues.find(node => node.declarationRange.uri.toString() === uri('child.tex').toString());
        const missing = issues.find(node => node.declarationRange.uri.toString() === main.toString());
        assert.ok(cyclic);
        assert.ok(missing);
        assert.strictEqual(cyclic.declarationRange.start, childText.indexOf('\\input{main}'));
        assert.strictEqual(missing.declarationRange.start, mainText.indexOf('\\input{missing}'));
        assert.ok(cyclic.declarationRange.end > cyclic.declarationRange.start);
        assert.ok(missing.declarationRange.end > missing.declarationRange.start);
      });
    });
  });

  test('attaches adjacent heading labels and nested environment labels to their proper owner', async () => {
    const source = String.raw`\label{standalone}
\section{Results}
% A comment does not separate the heading from its label.
\label{sec:results}
Text.
\begin{figure}
\label{fig:outer}
\begin{equation}
E = mc^2 \label{eq:inner}
\end{equation}
\label{fig:after}
\end{figure}
\begin{table}
\label{tab:data}
Data.
\end{table}`;
    const document = await vscode.workspace.openTextDocument({ language: 'latex', content: source });
    const roots = await documentStructure(document);
    const nodes = allNodes(roots);
    const heading = nodes.find(node => node.kind === 'section');
    const figure = nodes.find(node => node.kind === 'figure');
    const equation = nodes.find(node => node.kind === 'equation');
    const table = nodes.find(node => node.kind === 'table');
    const standalone = nodes.find(node => node.kind === 'label');
    assert.ok(heading);
    assert.ok(figure);
    assert.ok(equation);
    assert.ok(table);
    assert.ok(standalone);
    assert.deepStrictEqual(heading.labels.map(label => label.key), ['sec:results']);
    assert.deepStrictEqual(figure.labels.map(label => label.key), ['fig:outer', 'fig:after']);
    assert.deepStrictEqual(equation.labels.map(label => label.key), ['eq:inner']);
    assert.deepStrictEqual(table.labels.map(label => label.key), ['tab:data']);
    assert.deepStrictEqual(standalone.labels.map(label => label.key), ['standalone']);
    assert.ok(figure.children.includes(equation));
    assert.strictEqual(source.slice(equation.declarationRange.start, equation.declarationRange.end), '\\begin{equation}');
    assert.strictEqual(source.slice(equation.labels[0].location.start, equation.labels[0].location.end), '\\label{eq:inner}');
  });

  test('builds equation summaries from parsed environment commands without changing source locations', async () => {
    const source = '😀\\section{Heading \\begin{custom}kept\\end{custom}}\r\n' +
      '\\begin{equation}\r\n\\begin% opening\r\n{aligned} x &= y \\label{eq:one} ' +
      '\\verb|\\begin{fake}| \\end% closing\r\n{aligned}\r\n\\end{equation}';
    const document = await vscode.workspace.openTextDocument({ language: 'latex', content: source });
    const nodes = allNodes(await documentStructure(document));
    const heading = nodes.find(node => node.kind === 'section');
    const equations = nodes.filter(node => node.kind === 'equation');
    assert.strictEqual(heading?.title, String.raw`Heading \begin{custom}kept\end{custom}`);
    assert.strictEqual(equations.length, 1);
    const equation = equations[0];
    assert.strictEqual(equation.title, String.raw`x &= y \begin{fake}`);
    assert.strictEqual(equation.declarationRange.uri.toString(), document.uri.toString());
    assert.strictEqual(equation.declarationRange.start, source.indexOf('\\begin{equation}'));
    assert.strictEqual(source.slice(equation.declarationRange.start, equation.declarationRange.end), '\\begin{equation}');
    assert.strictEqual(equation.extentEnd.start, source.length);
    assert.deepStrictEqual(equation.labels.map(label => label.key), ['eq:one']);
    const label = equation.labels[0];
    assert.strictEqual(label.location.start, source.indexOf('\\label{eq:one}'));
    assert.strictEqual(source.slice(label.location.start, label.location.end), '\\label{eq:one}');
  });

  test('retains the equation summary length limit and empty-content fallback', async () => {
    const source = String.raw`\begin{equation}\begin{aligned}` + 'x'.repeat(130) +
      String.raw`\end{aligned}\end{equation}` + '\r\n' +
      String.raw`\begin{equation*}\begin{aligned}\end{aligned}\label{eq:empty}\end{equation*}`;
    const document = await vscode.workspace.openTextDocument({ language: 'latex', content: source });
    const equations = allNodes(await documentStructure(document)).filter(node => node.kind === 'equation');
    assert.deepStrictEqual(equations.map(node => node.title), ['x'.repeat(100), 'equation*']);
    assert.deepStrictEqual(equations[1].labels.map(label => label.key), ['eq:empty']);
  });

  test('uses root theorem declarations and configured theorem names in included files', async () => {
    await vscode.workspace.getConfiguration('vscode-fortex').update('outline.theoremEnvironments', { customclaim: 'Claim' }, target);
    await withProject({
      'main.tex': '\\newtheorem{proposition}{Proposition}\n\\section{Results}\n\\input{child}',
      'child.tex': '\\begin{proposition}[Observation]\n\\label{prop:first}\nStatement.\n\\end{proposition}\n' +
        '\\begin{customclaim}\n\\label{claim:first}\nStatement.\n\\end{customclaim}'
    }, async uri => {
      const main = uri('main.tex');
      LaTeXProject.resolveMainFile = async () => main;
      await withService(async service => {
        await service.refresh(await vscode.workspace.openTextDocument(uri('child.tex')));
        assert.ok(service.snapshot);
        const theorems = allNodes(service.snapshot.roots).filter(node => node.kind === 'theorem');
        assert.deepStrictEqual(theorems.map(node => node.constructName), ['proposition', 'customclaim']);
        assert.match(theorems[0].title, /Proposition/);
        assert.match(theorems[1].title, /Claim/);
        assert.deepStrictEqual(theorems.map(node => node.labels.map(label => label.key)), [['prop:first'], ['claim:first']]);
        assert.ok(theorems.every(node => node.declarationRange.uri.toString() === uri('child.tex').toString()));
      });
    });
  });

  test('uses unsaved edits for both the include graph and included document text', async () => {
    await withProject({
      'main.tex': '\\section{Saved root}\n\\input{first}',
      'first.tex': '\\subsection{First child}',
      'second.tex': '\\subsection{Saved second}'
    }, async uri => {
      const main = uri('main.tex');
      const mainDocument = await vscode.workspace.openTextDocument(main);
      const secondDocument = await vscode.workspace.openTextDocument(uri('second.tex'));
      await replaceDocument(mainDocument, '\\section{Unsaved root}\n\\input{second}');
      await replaceDocument(secondDocument, '\\subsection{Unsaved second}');
      assert.ok(mainDocument.isDirty);
      assert.ok(secondDocument.isDirty);
      LaTeXProject.resolveMainFile = async () => main;
      await withService(async service => {
        await service.refresh(mainDocument);
        assert.ok(service.snapshot);
        assert.deepStrictEqual(sections(service.snapshot).map(node => node.title), ['Unsaved root', 'Unsaved second']);
      });
    });
  });

  test('shares local and project snapshots and retains navigable headings while editing', async () => {
    await withProject({ 'main.tex': '\\section{Before}\\label{sec:before}' }, async uri => {
      const document = await vscode.workspace.openTextDocument(uri('main.tex'));
      let discoveries = 0;
      LaTeXProject.resolveMainFile = async () => { discoveries++; return document.uri; };
      await withService(async service => {
        await service.refresh(document);
        const first = service.snapshot!;
        const original = sections(first)[0];
        const local = await service.getDocumentHeadings(document);
        assert.strictEqual(local[0].declarationRange.sourceSnapshotId, original.declarationRange.sourceSnapshotId);
        assert.deepStrictEqual(service.projectLocation(original.declarationRange), original.declarationRange);
        let rebuilt = 0;
        const subscription = service.onDidChange(() => { rebuilt++; });
        try {
          await replaceDocument(document, 'Inserted text\n\\section{After}\\label{sec:after}');
          await replaceDocument(document, 'More inserted text\n\\section{After}\\label{sec:after}');
          assert.strictEqual((await service.current())!.roots, first.roots, 'Typing must retain the displayed tree');
          assert.strictEqual(discoveries, 1, 'Typing must not rediscover the project');
          assert.strictEqual(rebuilt, 0, 'Typing must not rebuild the project tree');
          const projected = await service.getDocumentHeadings(document);
          assert.strictEqual(projected.length, 1, 'An existing heading remains available after a whole-buffer replacement');
          assert.strictEqual(service.projectLocation(original.declarationRange).start, projected[0].declarationRange.start);
          assert.ok(await document.save());
          const saved = (await service.current())!;
          assert.deepStrictEqual(sections(saved).map(node => node.title), ['After']);
          const target = service.projectLocation(sections(saved)[0].declarationRange);
          assert.strictEqual(document.getText().slice(target.start, target.end), '\\section{After}');
          assert.deepStrictEqual(service.projectLocation(original.declarationRange), original.declarationRange,
            'Locations from a replaced baseline retain their previous offsets as approximate targets');
          assert.strictEqual((await service.getDocumentHeadings(document))[0].declarationRange.sourceSnapshotId, sections(saved)[0].declarationRange.sourceSnapshotId);
        } finally { subscription.dispose(); }
      });
    });
  });

  test('tracks body edits made before the first native heading projection without changing saved nodes', async () => {
    const source = '\\section{Saved parent}\nBody.\n\\subsection{Saved child}\nTail.';
    await withProject({ 'main.tex': source }, async uri => {
      const document = await vscode.workspace.openTextDocument(uri('main.tex'));
      LaTeXProject.resolveMainFile = async () => document.uri;
      await withService(async service => {
        await service.refresh(document);
        const saved = service.snapshot!.roots;
        const before = JSON.stringify(saved);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, document.positionAt(0), '😀 new body\r\n');
        edit.insert(document.uri, document.positionAt(source.indexOf('\\subsection')), 'More prose\n');
        assert.ok(await vscode.workspace.applyEdit(edit));
        const projected = await service.getDocumentHeadings(document);
        assert.deepStrictEqual(sections({ ...service.snapshot!, roots: projected }).map(node => node.title),
          ['Saved parent', 'Saved child']);
        for (const node of allNodes(projected)) {
          assert.strictEqual(document.getText().slice(node.declarationRange.start, node.declarationRange.end), `\\${node.constructName}{${node.title}}`);
        }
        assert.strictEqual(await service.getDocumentHeadings(document), projected, 'The same live version reuses its immutable projection');
        assert.strictEqual(JSON.stringify(saved), before);
        assert.strictEqual(service.projectLocation(sections(service.snapshot!)[0].declarationRange).start, projected[0].declarationRange.start);
      });
    });
  });

  test('retains a published project tree if a later main discovery fails', async () => {
    await withProject({ 'main.tex': '\\section{Retained}' }, async uri => {
      const document = await vscode.workspace.openTextDocument(uri('main.tex'));
      LaTeXProject.resolveMainFile = async () => document.uri;
      await withService(async service => {
        await service.refresh(document);
        const roots = service.snapshot!.roots;
        LaTeXProject.resolveMainFile = async () => { throw new Error('Temporary main discovery failure'); };
        await service.refresh(document);
        assert.strictEqual(service.snapshot!.roots, roots);
        assert.match(service.snapshot!.message ?? '', /Temporary main discovery failure/);
      });
    });
  });

  test('repeated unchanged source refreshes retain the snapshot and its lazy analysis', async () => {
    const source = '\\section{Stable}';
    const document = await vscode.workspace.openTextDocument({ language: 'latex', content: source });
    const service = new StructureService(false);
    const documentText: { readFileText: typeof Workspace.readFileText } = require('../workspace/DocumentText');
    const originalRead = documentText.readFileText;
    const internals = service as unknown as {
      sources: Map<string, { syntax: unknown; analysis: unknown }>;
      refreshSource(uri: vscode.Uri, document: vscode.TextDocument): Promise<void>;
    };
    try {
      await service.getDocumentHeadings(document);
      const key = Workspace.uriKey(document.uri);
      const initial = internals.sources.get(key)!;
      const syntax = initial.syntax;
      const analysis = initial.analysis;
      documentText.readFileText = async uri => Workspace.uriKey(uri) === key ? source : originalRead(uri);
      for (let index = 0; index < 10000; index++) { await internals.refreshSource(document.uri, document); }
      const latest = internals.sources.get(key)!;
      assert.strictEqual(latest, initial);
      assert.strictEqual(latest.analysis, analysis);
      assert.strictEqual(latest.syntax, syntax);
      assert.deepStrictEqual((await service.getDocumentHeadings(document)).map(node => node.title), ['Stable']);
    } finally {
      documentText.readFileText = originalRead;
      service.dispose();
    }
  });

  test('saving one source does not capture other dirty included buffers', async () => {
    await withProject({
      'main.tex': '\\section{Root}\\input{first}\\input{second}',
      'first.tex': '\\subsection{First saved}',
      'second.tex': '\\subsection{Second saved}'
    }, async uri => {
      const document = await vscode.workspace.openTextDocument(uri('main.tex'));
      const first = await vscode.workspace.openTextDocument(uri('first.tex'));
      const second = await vscode.workspace.openTextDocument(uri('second.tex'));
      LaTeXProject.resolveMainFile = async () => document.uri;
      await withService(async service => {
        await service.refresh(document);
        await replaceDocument(first, '\\subsection{First edited}');
        await replaceDocument(second, '\\subsection{Second edited}');
        assert.ok(await first.save());
        const oneSaved = (await service.current())!;
        assert.deepStrictEqual(sections(oneSaved).map(node => node.title), ['Root', 'First edited', 'Second saved']);
        assert.deepStrictEqual(service.projectLocation(sections(oneSaved)[1].declarationRange), sections(oneSaved)[1].declarationRange);
        const secondLocal = await service.getDocumentHeadings(second);
        assert.strictEqual(secondLocal.length, 1);
        assert.strictEqual(service.projectLocation(sections(oneSaved)[2].declarationRange).start, secondLocal[0].declarationRange.start);
        assert.ok(await second.save());
        const bothSaved = (await service.current())!;
        assert.deepStrictEqual(sections(bothSaved).map(node => node.title), ['Root', 'First edited', 'Second edited']);
        const target = service.projectLocation(sections(bothSaved)[2].declarationRange);
        assert.strictEqual(second.getText().slice(target.start, target.end), '\\subsection{Second edited}');
        assert.deepStrictEqual((await service.getDocumentHeadings(second)).map(node => node.title), ['Second edited']);
      });
    });
  });

  test('undoing back to clean captured text retains navigation and native symbols without rebuilding', async () => {
    await withProject({ 'main.tex': '\\section{Saved heading}' }, async uri => {
      const document = await vscode.workspace.openTextDocument(uri('main.tex'));
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      let discoveries = 0;
      LaTeXProject.resolveMainFile = async () => { discoveries++; return document.uri; };
      await withService(async service => {
        await service.refresh(document);
        const roots = service.snapshot!.roots;
        const location = sections(service.snapshot!)[0].declarationRange;
        assert.ok(await editor.edit(builder => builder.replace(
          new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), '\\section{Unsaved heading}'
        ), { undoStopBefore: true, undoStopAfter: true }));
        const projected = await service.getDocumentHeadings(document);
        assert.strictEqual(projected.length, 1);
        assert.strictEqual(service.projectLocation(location).start, projected[0].declarationRange.start);
        await vscode.window.showTextDocument(document, { preview: false });
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        let subscription: vscode.Disposable | undefined;
        const undone = new Promise<void>(resolve => {
          subscription = vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document === document && event.contentChanges.length > 0) { resolve(); }
          });
        });
        try {
          await vscode.commands.executeCommand('undo');
          await bounded(undone, 'undo of the outline test document');
        } finally { subscription?.dispose(); }
        assert.strictEqual(document.getText(), '\\section{Saved heading}');
        assert.ok(!document.isDirty);
        assert.strictEqual(service.snapshot!.roots, roots);
        assert.strictEqual(discoveries, 1, 'Clean undo must not rediscover the parent');
        assert.deepStrictEqual(service.projectLocation(location), location);
        assert.deepStrictEqual((await service.getDocumentHeadings(document)).map(node => node.title), ['Saved heading']);
      });
    });
  });

  test('a saved include first discovers another dirty buffer from its disk baseline', async () => {
    await withProject({ 'main.tex': '\\section{Root}', 'child.tex': '\\subsection{Child saved}' }, async uri => {
      const document = await vscode.workspace.openTextDocument(uri('main.tex'));
      const child = await vscode.workspace.openTextDocument(uri('child.tex'));
      LaTeXProject.resolveMainFile = async () => document.uri;
      await withService(async service => {
        await service.refresh(document);
        await replaceDocument(child, '\\subsection{Child unsaved}');
        await replaceDocument(document, '\\section{Root}\\input{child}');
        assert.ok(await document.save());
        const snapshot = (await service.current())!;
        assert.deepStrictEqual(sections(snapshot).map(node => node.title), ['Root', 'Child saved']);
        const target = service.projectLocation(sections(snapshot)[1].declarationRange);
        assert.strictEqual(child.getText().slice(target.start, target.end), '\\subsection{Child unsaved}');
        assert.strictEqual((await service.getDocumentHeadings(child)).length, 1);
        assert.ok(await child.save());
        const saved = (await service.current())!;
        assert.deepStrictEqual(sections(saved).map(node => node.title), ['Root', 'Child unsaved']);
        assert.deepStrictEqual(service.projectLocation(sections(saved)[1].declarationRange), sections(saved)[1].declarationRange);
      });
    });
  });

  test('keeps the captured save and navigable headings when the buffer changes during asynchronous discovery', async () => {
    await withProject({ 'main.tex': '\\section{Initial}' }, async uri => {
      const document = await vscode.workspace.openTextDocument(uri('main.tex'));
      const started = deferred<void>();
      const release = deferred<void>();
      let pause = false;
      LaTeXProject.resolveMainFile = async () => {
        if (pause) { started.resolve(); await release.promise; }
        return document.uri;
      };
      await withService(async service => {
        await service.refresh(document);
        await replaceDocument(document, '\\section{Captured save}');
        pause = true;
        assert.ok(await document.save());
        const refreshed = service.current();
        try {
          await bounded(started.promise, 'saved snapshot discovery');
          await replaceDocument(document, '\\section{Later unsaved edit}');
          release.resolve();
          const snapshot = (await refreshed)!;
          assert.deepStrictEqual(sections(snapshot).map(node => node.title), ['Captured save']);
          const projected = await service.getDocumentHeadings(document);
          assert.strictEqual(projected.length, 1);
          assert.strictEqual(service.projectLocation(sections(snapshot)[0].declarationRange).start, projected[0].declarationRange.start);
        } finally { release.resolve(); await refreshed; }
      });
    });
  });

  test('resolves each requested project using captured source rather than subsequent unsaved edits', async () => {
    const original = '\\input{first}\r\n';
    await withProject({
      'active.tex': original,
      'parent-first.tex': '\\section{First parent}',
      'parent-second.tex': '\\section{Second parent}'
    }, async uri => {
      const document = await vscode.workspace.openTextDocument(uri('active.tex'));
      let detections = 0;
      LaTeXProject.resolveMainFile = async (_active, options) => {
        detections++;
        const source = await options?.readSource?.(document.uri);
        return uri(source?.includes('second') ? 'parent-second.tex' : 'parent-first.tex');
      };
      try {
        await withService(async service => {
          await service.refresh(document);
          assert.strictEqual(service.snapshot?.main.toString(), uri('parent-first.tex').toString());
          await service.refresh(document);
          assert.strictEqual(detections, 2, 'The resolver has no cross-request parent cache');
          await replaceDocument(document, '\\input{second}\r\n');
          await service.refresh(document);
          assert.strictEqual(service.snapshot?.main.toString(), uri('parent-first.tex').toString());
          assert.ok(document.isDirty);
          assert.ok(await document.save());
          await service.current();
          assert.strictEqual(service.snapshot?.main.toString(), uri('parent-second.tex').toString());
          assert.deepStrictEqual(sections(service.snapshot!).map(node => node.title), ['Second parent']);
          assert.strictEqual(detections, 4);
        });
      } finally {
        await replaceDocument(document, original);
      }
    });
  });

  test('uses the shared resolver after an uppercase main directive is saved', async () => {
    const original = '%#MAIN first.tex\r\n\\subsection{Child}';
    await withProject({
      'child.tex': original,
      'first.tex': '\\documentclass{article}\r\n\\section{First parent}\r\n\\input{child}',
      'second.tex': '\\documentclass{article}\r\n\\section{Second parent}\r\n\\input{child}'
    }, async uri => {
      const document = await vscode.workspace.openTextDocument(uri('child.tex'));
      try {
        await withService(async service => {
          await service.refresh(document);
          assert.strictEqual(service.snapshot?.main.toString(), uri('first.tex').toString());
          assert.deepStrictEqual(sections(service.snapshot!).map(node => node.title), ['First parent', 'Child']);
          await replaceDocument(document, original.replace('first.tex', 'second.tex'));
          assert.ok(document.isDirty);
          await service.refresh(document);
          assert.strictEqual(service.snapshot?.main.toString(), uri('first.tex').toString());
          assert.ok(await document.save());
          await service.current();
          assert.strictEqual(service.snapshot?.main.toString(), uri('second.tex').toString());
          assert.deepStrictEqual(sections(service.snapshot!).map(node => node.title), ['Second parent', 'Child']);
        });
      } finally {
        await replaceDocument(document, original);
      }
    });
  });

  test('refreshes when the project resolver invalidates discovery after a setting change', async () => {
    const config = vscode.workspace.getConfiguration('vscode-fortex');
    await config.update('mainFileOrder', ['current'], target);
    await withProject({
      'main.tex': '\\documentclass{article}\n\\section{Parent}\n\\input{child}',
      'child.tex': '%#main main.tex\n\\subsection{Child}'
    }, async uri => {
      const document = await vscode.workspace.openTextDocument(uri('child.tex'));
      await vscode.window.showTextDocument(document);
      const service = new StructureService(true);
      try {
        await observeSnapshot(service,
          snapshot => snapshot.main.toString() === document.uri.toString(),
          'the initial current-file discovery');
        const snapshot = await observeSnapshot(service,
          snapshot => snapshot.main.toString() === uri('main.tex').toString(),
          'project discovery configuration to refresh the structure',
          async () => config.update('mainFileOrder', ['magic', 'current'], target));
        assert.deepStrictEqual(sections(snapshot).map(node => node.title), ['Parent', 'Child']);
      } finally {
        service.dispose();
      }
    });
  });

  test('discards a slower earlier refresh after the latest request has completed', async () => {
    await withProject({ 'old.tex': '\\section{Old}', 'latest.tex': '\\section{Latest}' }, async uri => {
      const oldDocument = await vscode.workspace.openTextDocument(uri('old.tex'));
      const latestDocument = await vscode.workspace.openTextDocument(uri('latest.tex'));
      const oldStarted = deferred<void>();
      const releaseOld = deferred<void>();
      LaTeXProject.resolveMainFile = async active => {
        assert.ok(active);
        if (active.toString() === oldDocument.uri.toString()) {
          oldStarted.resolve();
          await releaseOld.promise;
        }
        return active;
      };
      await withService(async service => {
        let changed = 0;
        const subscription = service.onDidChange(() => { changed++; });
        const oldRefresh = service.refresh(oldDocument);
        try {
          await oldStarted.promise;
          await service.refresh(latestDocument);
          const latest = service.snapshot;
          assert.ok(latest);
          assert.strictEqual(latest.main.toString(), latestDocument.uri.toString());
          releaseOld.resolve();
          await oldRefresh;
          assert.strictEqual(service.snapshot, latest);
          assert.deepStrictEqual(sections(latest).map(node => node.title), ['Latest']);
          assert.strictEqual(changed, 1);
        } finally {
          releaseOld.resolve();
          await oldRefresh;
          subscription.dispose();
        }
      });
    });
  });

  test('current waits for a newer refresh that starts while an earlier refresh is pending', async () => {
    await withProject({
      'initial.tex': '\\section{Initial}',
      'old.tex': '\\section{Old}',
      'latest.tex': '\\section{Latest}'
    }, async uri => {
      const initialDocument = await vscode.workspace.openTextDocument(uri('initial.tex'));
      const oldDocument = await vscode.workspace.openTextDocument(uri('old.tex'));
      const latestDocument = await vscode.workspace.openTextDocument(uri('latest.tex'));
      const oldStarted = deferred<void>();
      const latestStarted = deferred<void>();
      const releaseOld = deferred<void>();
      const releaseLatest = deferred<void>();
      LaTeXProject.resolveMainFile = async active => {
        assert.ok(active);
        if (active.toString() === oldDocument.uri.toString()) {
          oldStarted.resolve();
          await releaseOld.promise;
        } else if (active.toString() === latestDocument.uri.toString()) {
          latestStarted.resolve();
          await releaseLatest.promise;
        }
        return active;
      };
      await withService(async service => {
        await bounded(service.refresh(initialDocument), 'the initial snapshot');
        const initial = service.snapshot;
        assert.ok(initial);
        const oldRefresh = service.refresh(oldDocument);
        await bounded(oldStarted.promise, 'the earlier refresh to start');
        let currentSettled = false;
        const current = service.current().then(snapshot => { currentSettled = true; return snapshot; });
        const latestRefresh = service.refresh(latestDocument);
        try {
          await bounded(latestStarted.promise, 'the latest refresh to start');
          releaseOld.resolve();
          await bounded(oldRefresh, 'the earlier refresh to finish');
          // Complete the microtask queue so a prematurely resolved current()
          // would be observable before releasing the latest request.
          await new Promise<void>(resolve => setImmediate(resolve));
          assert.strictEqual(service.snapshot, initial);
          assert.strictEqual(currentSettled, false, 'current() must keep waiting for the newest request');
          releaseLatest.resolve();
          await bounded(latestRefresh, 'the latest refresh to finish');
          const snapshot = await bounded(current, 'current to return the latest snapshot');
          assert.strictEqual(snapshot, service.snapshot);
          assert.ok(snapshot);
          assert.strictEqual(snapshot.main.toString(), latestDocument.uri.toString());
          assert.deepStrictEqual(sections(snapshot).map(node => node.title), ['Latest']);
        } finally {
          releaseOld.resolve();
          releaseLatest.resolve();
          await bounded(Promise.all([oldRefresh, latestRefresh, current]), 'pending refresh cleanup');
        }
      });
    });
  });

  test('waits for included-file saves and still follows external changes outside the workspace', async function () {
    this.timeout(30000);
    await withProject({
      'main.tex': '\\section{Root}\n\\input{open-child}\n\\input{external-child}',
      'open-child.tex': '\\subsection{Saved open child}',
      'external-child.tex': '\\subsection{Saved external child}'
    }, async uri => {
      const main = uri('main.tex');
      const mainDocument = await vscode.workspace.openTextDocument(main);
      const openChild = await vscode.workspace.openTextDocument(uri('open-child.tex'));
      assert.ok(!vscode.workspace.textDocuments.some(document => document.uri.toString() === uri('external-child.tex').toString()));
      LaTeXProject.resolveMainFile = async () => main;
      await vscode.window.showTextDocument(mainDocument);
      const service = new StructureService(true);
      try {
        await observeSnapshot(service,
          snapshot => sections(snapshot).map(node => node.title).join('|') === 'Root|Saved open child|Saved external child',
          'the initial automatic project refresh');
        await replaceDocument(openChild, '\\subsection{Unsaved open child}');
        assert.ok(openChild.isDirty);
        assert.strictEqual(service.projectLocation(sections(service.snapshot!)[1].declarationRange).start,
          (await service.getDocumentHeadings(openChild))[0].declarationRange.start);
        assert.deepStrictEqual(sections((await service.current())!).map(node => node.title),
          ['Root', 'Saved open child', 'Saved external child']);
        const saved = await observeSnapshot(service,
          snapshot => sections(snapshot).some(node => node.title === 'Unsaved open child'),
          'a saved included-file edit to refresh the structure',
          async () => openChild.save());
        assert.ok(!openChild.isDirty);
        assert.deepStrictEqual(sections(saved).map(node => node.title), ['Root', 'Unsaved open child', 'Saved external child']);
        const external = await observeSnapshot(service,
          snapshot => sections(snapshot).some(node => node.title === 'Changed externally'),
          'an external included-file write to refresh the structure',
          () => fs.writeFile(uri('external-child.tex').fsPath, '\\subsection{Changed externally}', 'utf8'));
        assert.deepStrictEqual(sections(external).map(node => node.title), ['Root', 'Unsaved open child', 'Changed externally']);
        assert.ok(!vscode.workspace.textDocuments.some(document => document.uri.toString() === uri('external-child.tex').toString()));
      } finally {
        service.dispose();
      }
    });
  });

  test('refreshes a fallback when an absent preferred filename is created', async function () {
    this.timeout(30000);
    await withProject({
      'main.tex': '\\section{Root}\n\\input{chapter.foo}',
      'chapter.foo': '\\subsection{Fallback}'
    }, async uri => {
      const main = uri('main.tex');
      const document = await vscode.workspace.openTextDocument(main);
      LaTeXProject.resolveMainFile = async () => main;
      await vscode.window.showTextDocument(document);
      const service = new StructureService(true);
      try {
        await observeSnapshot(service,
          snapshot => sections(snapshot).map(node => node.title).join('|') === 'Root|Fallback',
          'the fallback outline');
        // VS Code activates filesystem watches asynchronously. Establish a real
        // notification on this directory before testing a single file creation.
        const ready = deferred<void>();
        let probing = true;
        const readiness = service.onDidChange(snapshot => {
          if (snapshot && sections(snapshot).some(node => node.title === 'Ready fallback')) { ready.resolve(); }
        });
        const probe = (async () => {
          while (probing) {
            await fs.writeFile(uri('chapter.foo').fsPath, '\\subsection{Ready fallback}', 'utf8');
            await Promise.race([ready.promise, new Promise<void>(resolve => setTimeout(resolve, 500))]);
          }
        })();
        try {
          await bounded(Promise.race([ready.promise, probe]), 'the candidate directory watcher to become active');
        } finally {
          probing = false;
          readiness.dispose();
          await probe;
        }
        await observeSnapshot(service,
          snapshot => sections(snapshot).map(node => node.title).join('|') === 'Root|Preferred',
          'creation of the preferred .tex candidate',
          () => fs.writeFile(uri('chapter.foo.tex').fsPath, '\\subsection{Preferred}', 'utf8'));
      } finally {
        service.dispose();
      }
    });
  });

  test('does not publish a missing non-tex input created before watcher registration', async () => {
    await withProject({ 'main.tex': '\\section{Root}\n\\input{late.foo}' }, async uri => {
      const main = uri('main.tex');
      const document = await vscode.workspace.openTextDocument(main);
      LaTeXProject.resolveMainFile = async () => main;
      await vscode.window.showTextDocument(document);
      const resolver: { resolveInputFile: typeof import('../project/InputFileResolver').resolveInputFile }
        = require('../project/InputFileResolver');
      const originalResolve = resolver.resolveInputFile;
      let created = false;
      resolver.resolveInputFile = async (...args) => {
        const result = await originalResolve(...args);
        if (!created && result.status === 'missing' && result.filename === 'late.foo') {
          created = true;
          await fs.writeFile(uri('late.foo').fsPath, '\\subsection{Created}', 'utf8');
        }
        return result;
      };
      const service = new StructureService(true);
      const published: StructureSnapshot[] = [];
      const subscription = service.onDidChange(snapshot => { if (snapshot) { published.push(snapshot); } });
      try {
        await service.refresh(document);
        const snapshot = await bounded(service.current(), 'the post-registration input recheck');
        assert.ok(created);
        assert.ok(snapshot);
        assert.deepStrictEqual(sections(snapshot).map(node => node.title), ['Root', 'Created']);
        assert.ok(published.length > 0);
        assert.ok(published.every(value => allNodes(value.roots).every(node => node.kind !== 'issue')),
          'A stale missing-input snapshot must not be published');
      } finally {
        subscription.dispose();
        service.dispose();
        resolver.resolveInputFile = originalResolve;
      }
    });
  });
});
