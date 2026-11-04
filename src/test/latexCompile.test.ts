import * as assert from 'assert';
import * as fs from 'fs/promises';
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { runInThisContext } from 'vm';
import * as vscode from 'vscode';
import Config from '../Config';
import LaTeXProject, { ProjectReadOptions } from '../project/LaTeXProject';
import type LaTeXCompile from '../compile/LaTeXCompile';
import type { TeXToPDFOptions, TeXToPDFResult } from '../compile/TeXToPDF/TeXToPDF';
import type { BuildContext, BuildRequest, BuildResult } from '../compile/BuildProtocol';

/** Holds a discovery read open while source buffers are edited. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(finish => { resolve = finish; });
  return { promise, resolve };
}

/** Bounds discovery checks so a regression cannot hang the extension host. */
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Build discovery did not complete')), 5000);
    })]);
  } finally { if (timer) { clearTimeout(timer); } }
}

/** Edits the in-memory source while leaving its saved contents unchanged. */
async function replace(document: vscode.TextDocument, source: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), source);
  assert.ok(await vscode.workspace.applyEdit(edit));
}

interface BuildFixture {
  uri(name: string): vscode.Uri;
  open(name: string): Promise<vscode.TextDocument>;
  build(document: vscode.TextDocument): Promise<BuildResult>;
  request(document: vscode.TextDocument): BuildRequest;
  execute(request: BuildRequest): Promise<BuildResult>;
  pipeline(project: LaTeXProject, options?: TeXToPDFOptions): Promise<TeXToPDFResult>;
  preview?: (token?: vscode.CancellationToken) => Promise<void>;
  projects: LaTeXProject[];
  previews: (readonly vscode.Uri[])[];
  reads: vscode.Uri[];
  onRead?: (uri: vscode.Uri) => Promise<void>;
}

/** Exercises the LaTeX entry point with real saved-source discovery and isolated pipeline/viewer effects. */
async function withBuildFixture(files: Record<string, string>, run: (fixture: BuildFixture) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fortex-build-source-'));
  const uri = (name: string) => vscode.Uri.file(path.join(directory, name));
  const originalOrder = Config.mainFileOrder;
  const originalAllowed = Config.allowedPrograms;
  Config.allowedPrograms = () => ['pdflatex', 'lualatex'];
  try {
    for (const [name, source] of Object.entries(files)) {
      await fs.mkdir(path.dirname(uri(name).fsPath), { recursive: true });
      await fs.writeFile(uri(name).fsPath, source, 'utf8');
    }
    Config.mainFileOrder = () => ['magic', 'current'];
    const fixture: BuildFixture = {
      uri, open: async name => vscode.workspace.openTextDocument(uri(name)), projects: [], previews: [], reads: [],
      pipeline: async project => ({ outcome: 'succeeded', severity: 'info', message: 'Built.', diagnostics: [],
        pdfs: [vscode.Uri.file(project.mainfile.fsPath.replace(/\.tex$/, '.pdf'))] }),
      build: document => fixture.execute(fixture.request(document)),
      /** Supplies the manager-facing context without forwarding it into the pipeline. */
      execute: async request => {
        const cancellation = new vscode.CancellationTokenSource();
        try { return await request.execute({ token: cancellation.token, reportProgress() {}, reportNotice() {} }); }
        finally { cancellation.dispose(); }
      },
      request: document => {
        const filename = require.resolve('../compile/LaTeXCompile');
        const source = readFileSync(filename, 'utf8');
        const localRequire = createRequire(filename);
        const isolatedModule = { exports: {} as { default: typeof LaTeXCompile } };
        const load = runInThisContext(`(function (exports, require, module, __filename, __dirname) {\n${source}\n})`, { filename });
        load(isolatedModule.exports, (id: string) => {
          if (id === 'vscode') {
            return {
              ...vscode,
              workspace: { isTrusted: true },
              commands: { executeCommand: async () => {} },
              languages: { createDiagnosticCollection: () => ({ clear() {}, set() {}, dispose() {} }) },
              window: { activeTextEditor: { document }, createStatusBarItem: () => ({ show() {}, dispose() {} }) }
            };
          }
          if (id === '../project/LaTeXProject') {
            return { create: async (file: vscode.Uri, options?: ProjectReadOptions) => {
              const read = options?.readSource;
              return LaTeXProject.create(file, read ? { ...options, readSource: async sourceUri => {
                const text = await read(sourceUri);
                fixture.reads.push(sourceUri);
                await fixture.onRead?.(sourceUri);
                return text;
              } } : options);
            } };
          }
          if (id === './TeXToPDF/TeXToPDF') {
            return class {
              /** Captures the project selected by the real LaTeX request entry point. */
              constructor(private readonly project: LaTeXProject) {}
              /** Reports pipeline-specific output through its private options and result. */
              async build(options?: TeXToPDFOptions) {
                fixture.projects.push(this.project);
                options?.onProgress?.('Simulated LaTeX pass…');
                return fixture.pipeline(this.project, options);
              }
            };
          }
          if (id === './Process') {
            return class {
              /** Accepts the same immutable command specification as a real process. */
              constructor(_command: string, _args: readonly string[], _directory: string | null) {}
              /** Simulates allowed arbitrary commands without launching external programs. */
              async execute() { return 0; }
            };
          }
          return localRequire(id);
        }, isolatedModule, filename, path.dirname(filename));
        return isolatedModule.exports.default.createBuildRequest(document.uri, {
          /** Captures only explicitly reported PDFs and optionally delays/cancels the update. */
          onBuildComplete: async (pdfs: readonly vscode.Uri[], token?: vscode.CancellationToken) => {
            fixture.previews.push(pdfs);
            await fixture.preview?.(token);
          }
        } as Parameters<typeof LaTeXCompile.createBuildRequest>[1]);
      }
    };
    await run(fixture);
  } finally {
    Config.allowedPrograms = originalAllowed;
    Config.mainFileOrder = originalOrder;
    assert.strictEqual(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('fortex-build-source-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

suite('Build project source selection', () => {
  test('creates inert reusable requests and rediscovers saved inputs on every execution', async () => {
    await withBuildFixture({
      'child.tex': '%#main first.tex\nChild.', 'first.tex': '\\documentclass{article}',
      'second.tex': '\\documentclass{book}'
    }, async fixture => {
      const request = fixture.request(await fixture.open('child.tex'));
      assert.strictEqual(fixture.reads.length, 0);
      const first = await fixture.execute(request);
      assert.strictEqual(first.diagnostics?.key.toString(), fixture.uri('first.tex').toString());
      await fs.writeFile(fixture.uri('child.tex').fsPath, '%#main second.tex\nChanged.', 'utf8');
      const second = await fixture.execute(request);
      assert.strictEqual(second.diagnostics?.key.toString(), fixture.uri('second.tex').toString());
      assert.deepStrictEqual(fixture.projects.map(project => project.classfile), ['article', 'book']);
    });
  });

  test('uses the request URI for every nonempty percent-sharp form and the main URI otherwise', async () => {
    await withBuildFixture({ 'child.tex': '%#main main.tex', 'main.tex': '\\documentclass{article}' }, async fixture => {
      const document = await fixture.open('child.tex');
      for (const directive of ['', 'pdflatex', '$(C:TeXToPDF)', 'pdflatex --direct %B',
        '$(C:TeXToPDF); pdflatex --direct %B']) {
        await fs.writeFile(document.uri.fsPath, '%#main main.tex\n' + (directive ? '%#!' + directive : ''), 'utf8');
        const result = await fixture.build(document);
        assert.strictEqual(result.outcome, 'succeeded');
        assert.strictEqual(result.diagnostics?.key.toString(),
          fixture.uri(directive ? 'child.tex' : 'main.tex').toString(), directive);
        assert.deepStrictEqual(result.diagnostics?.entries, []);
      }
    });
  });

  test('keeps error locations independent of the diagnostic ownership key', async () => {
    await withBuildFixture({ 'child.tex': '%#main main.tex\n%#!pdflatex', 'main.tex': '\\documentclass{article}' }, async fixture => {
      const errorFile = fixture.uri('included.tex');
      const diagnostic = new vscode.Diagnostic(new vscode.Range(2, 0, 2, 1), 'Pipeline source error');
      fixture.pipeline = async () => ({ outcome: 'failed', severity: 'error', message: 'LaTeX failed.',
        diagnostics: [[errorFile, [diagnostic]]] });
      const result = await fixture.build(await fixture.open('child.tex'));
      assert.strictEqual(result.diagnostics?.key.toString(), fixture.uri('child.tex').toString());
      assert.strictEqual(result.diagnostics?.entries[0][0], errorFile);
      assert.strictEqual(result.diagnostics?.entries[0][1][0], diagnostic);
      assert.strictEqual(fixture.previews.length, 0);
    });
  });

  test('reports known-key failures with an empty replacement snapshot', async () => {
    await withBuildFixture({ 'child.tex': '%#main main.tex\n%#!forbidden', 'main.tex': '\\documentclass{article}' }, async fixture => {
      const result = await fixture.build(await fixture.open('child.tex'));
      assert.strictEqual(result.outcome, 'failed');
      assert.strictEqual(result.diagnostics?.key.toString(), fixture.uri('child.tex').toString());
      assert.deepStrictEqual(result.diagnostics?.entries, []);
      assert.strictEqual(fixture.projects.length, 0);
    });
  });

  test('relays private pipeline progress and preview notices through the LaTeX adapter', async () => {
    await withBuildFixture({ 'main.tex': '\\documentclass{article}' }, async fixture => {
      const request = fixture.request(await fixture.open('main.tex'));
      fixture.preview = async () => { throw new Error('Viewer unavailable'); };
      const cancellation = new vscode.CancellationTokenSource();
      const progress: string[] = []; const notices: string[] = [];
      try {
        const result = await request.execute({ token: cancellation.token,
          reportProgress: message => progress.push(message), reportNotice: notice => { if (notice) { notices.push(notice.message); } } });
        assert.strictEqual(result.outcome, 'succeeded');
        assert.strictEqual(result.severity, 'info');
        assert.ok(progress.includes('Simulated LaTeX pass…'));
        assert.match(notices[0], /PDF generated.*Viewer unavailable/);
      } finally { cancellation.dispose(); }
    });
  });

  test('does not publish a snapshot or preview after cancellation inside the private pipeline', async () => {
    await withBuildFixture({ 'main.tex': '\\documentclass{article}' }, async fixture => {
      const request = fixture.request(await fixture.open('main.tex'));
      const cancellation = new vscode.CancellationTokenSource();
      fixture.pipeline = async (_project, options) => {
        assert.strictEqual(options?.token, cancellation.token);
        cancellation.cancel();
        return { outcome: 'succeeded', severity: 'info', message: 'Late completion.', pdfs: [fixture.uri('main.pdf')] };
      };
      try {
        const result = await request.execute({ token: cancellation.token, reportProgress() {}, reportNotice() {} });
        assert.strictEqual(result.outcome, 'cancelled');
        assert.strictEqual(result.diagnostics, undefined);
        assert.strictEqual(fixture.previews.length, 0);
      } finally { cancellation.dispose(); }
    });
  });

  test('does not publish a snapshot when cancellation occurs during preview update', async () => {
    await withBuildFixture({ 'main.tex': '\\documentclass{article}' }, async fixture => {
      const cancellation = new vscode.CancellationTokenSource();
      fixture.preview = async () => { cancellation.cancel(); };
      try {
        const result = await fixture.request(await fixture.open('main.tex')).execute({
          token: cancellation.token, reportProgress() {}, reportNotice() {}
        });
        assert.strictEqual(result.outcome, 'cancelled');
        assert.strictEqual(result.diagnostics, undefined);
      } finally { cancellation.dispose(); }
    });
  });

  test('leaves the diagnostic key unspecified when saved-source discovery fails', async () => {
    await withBuildFixture({ 'main.tex': '\\documentclass{article}' }, async fixture => {
      fixture.onRead = async () => { throw new Error('Saved source unavailable'); };
      const result = await fixture.build(await fixture.open('main.tex'));
      assert.strictEqual(result.outcome, 'failed');
      assert.strictEqual(result.diagnostics, undefined);
    });
  });

  test('uses saved main, class, includes and build directives instead of unsaved buffers', async () => {
    await withBuildFixture({
      'child.tex': '%#main first.tex\n%#!pdflatex\n%#t2dopt --saved\nChild body.',
      'first.tex': '\\documentclass[10pt]{article}\n\\include{saved}',
      'second.tex': '\\documentclass{book}',
      'saved.tex': 'Saved include.', 'unsaved.tex': 'Unsaved include.'
    }, async fixture => {
      const child = await fixture.open('child.tex');
      const main = await fixture.open('first.tex');
      await replace(child, '%#main second.tex\n%#!lualatex\n%#t2dopt --unsaved\nNew body.');
      await replace(main, '\\documentclass[12pt]{book}\n\\include{unsaved}');
      await fixture.build(child);
      assert.strictEqual(fixture.projects.length, 1, 'The saved project must reach the build stage');
      const project = fixture.projects[0];
      assert.strictEqual(project.mainfile.toString(), fixture.uri('first.tex').toString());
      assert.deepStrictEqual([project.classfile, project.classoption], ['article', '10pt']);
      assert.strictEqual(project.percent_sharp('!'), 'pdflatex');
      assert.strictEqual(project.percent_sharp('t2dopt'), '--saved');
      assert.deepStrictEqual(project.filelist.map(file => path.basename(file.uri.fsPath)), ['first.tex', 'saved.tex']);
      assert.strictEqual(fixture.previews[0][0].fsPath, project.mainfile.fsPath.replace(/\.tex$/, '.pdf'), 'Preview uses the reported output');

      await fs.writeFile(child.uri.fsPath, '%#main second.tex\n%#!lualatex\n', 'utf8');
      await fixture.build(child);
      assert.strictEqual(fixture.projects[1].mainfile.toString(), fixture.uri('second.tex').toString());
      assert.strictEqual(fixture.projects[1].classfile, 'book');
      assert.strictEqual(fixture.projects[1].percent_sharp('!'), 'lualatex');
    });
  });

  test('finishes one discovery while the active and included buffers keep changing', async () => {
    await withBuildFixture({
      'main.tex': '\\documentclass{article}\n\\include{child}', 'child.tex': 'Saved child.'
    }, async fixture => {
      const main = await fixture.open('main.tex');
      const child = await fixture.open('child.tex');
      const started = deferred();
      const release = deferred();
      fixture.onRead = async sourceUri => {
        if (sourceUri.toString() === child.uri.toString()) { started.resolve(); await release.promise; }
      };
      const pending = fixture.build(main);
      try {
        await bounded(started.promise);
        for (let index = 0; index < 4; index++) {
          await replace(main, `\\documentclass{book}\nEdited main ${index}.`);
          await replace(child, `Edited child ${index}.`);
        }
        release.resolve();
        await bounded(pending);
        assert.strictEqual(fixture.projects.length, 1);
        assert.strictEqual(fixture.projects[0].classfile, 'article');
        assert.deepStrictEqual(fixture.projects[0].filelist.map(file => path.basename(file.uri.fsPath)), ['main.tex', 'child.tex']);
        assert.strictEqual(fixture.reads.filter(read => read.toString() === main.uri.toString()).length, 1);
        assert.strictEqual(fixture.reads.filter(read => read.toString() === child.uri.toString()).length, 1);
      } finally { release.resolve(); await pending; }
    });
  });
});

