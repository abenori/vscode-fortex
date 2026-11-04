import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import Config from '../Config';
import LaTeXProject from '../project/LaTeXProject';
import LaTeXCompile from '../compile/LaTeXCompile';
import Process from '../compile/Process';
import TeXToPDF from '../compile/TeXToPDF/TeXToPDF';
import KpsewhichResolver from '../project/KpsewhichResolver';
import type { BuildContext, BuildResult } from '../compile/BuildProtocol';
import { EventEmitter } from 'events';
import type { ChildProcess, SpawnOptions } from 'child_process';

interface Command {
  command: string;
  args: string[];
  output: 'pdf' | 'dvi';
}

interface CommandMethods {
  make_latex_command(): Command;
  make_program_command(key: 'bibtex' | 'makeindex' | 'dvipdf'): Omit<Command, 'output'>;
}

interface BibliographyMethods {
  read_status(command: Omit<Command, 'output'>): void;
  latex_check(): boolean;
  bib_check(command: Omit<Command, 'output'>, options?: { token: vscode.CancellationToken }): Promise<boolean>;
}

const commonArgs = ['-interaction=nonstopmode', '-halt-on-error', '-synctex=1', '-file-line-error'];

function project(classfile = 'article', classoption = '', directives: Record<string, string> = {},
  mainfile = vscode.Uri.file(path.join(os.tmpdir(), 'fortex-command-test', 'main.tex'))): LaTeXProject {
  return {
    classfile, classoption, mainfile, file: mainfile, filelist: [],
    percent_sharp: (key: string) => directives[key]
  } as unknown as LaTeXProject;
}

function commands(proj = project()): CommandMethods {
  return new TeXToPDF(proj, '') as unknown as CommandMethods;
}

suite('TeXToPDF build configuration', () => {
  let settings: Record<string, unknown>;
  let originalGetConfiguration: typeof vscode.workspace.getConfiguration;
  const subprocess = require('cross-spawn') as { spawn: typeof import('child_process').spawn };
  let originalSpawn: typeof subprocess.spawn;
  let originalResolve: typeof KpsewhichResolver.resolve;
  let runProgram: (command: string, args: readonly string[], directory: string) => Promise<number | null>;

  setup(() => {
    settings = {};
    originalGetConfiguration = vscode.workspace.getConfiguration;
    originalSpawn = subprocess.spawn;
    originalResolve = KpsewhichResolver.resolve;
    KpsewhichResolver.resolve = async (main, names) => names.map(name => vscode.Uri.file(path.resolve(path.dirname(main.fsPath), name)));
    vscode.workspace.getConfiguration = (section, scope) => section === Config.config_name ? {
      get: <T>(key: string, fallback: T): T => Object.hasOwn(settings, key) ? settings[key] as T : fallback
    } as vscode.WorkspaceConfiguration : originalGetConfiguration(section, scope);
  });

  teardown(() => {
    vscode.workspace.getConfiguration = originalGetConfiguration;
    subprocess.spawn = originalSpawn;
    KpsewhichResolver.resolve = originalResolve;
  });

  test('retains every default class mapping in both runtime and contributed settings', () => {
    const properties = require('../../package.json').contributes.configuration.properties;
    assert.deepStrictEqual(properties['vscode-fortex.compile.latex.engines'].default, {});
    assert.strictEqual(properties['vscode-fortex.compile.latex.args'], undefined);
    const cases: [string[], string, string][] = [
      [['article', 'report', 'book', 'unknown', ''], '', 'pdflatex'],
      [['jarticle', 'jreport', 'jbook'], 'uplatex', 'platex'],
      [['ujarticle', 'ujreport', 'ujbook'], '', 'uplatex'],
      [['jsarticle', 'jsbook', 'jsreport'], '', 'platex'],
      [['jsarticle', 'jsbook', 'jsreport'], 'a4paper, \n uplatex \t, 10pt', 'uplatex'],
      [['jsarticle'], 'notuplatex,uplatex=1', 'platex'],
      [['ltjsarticle', 'ltjsbook', 'ltjsreport'], '', 'lualatex'],
      [['jlreq'], '', 'uplatex'],
      [['jlreq'], 'lualatex', 'lualatex'],
      [['jlreq'], 'lualatex, platex', 'platex']
    ];
    for (const rules of [undefined, properties['vscode-fortex.compile.latex.engineRules'].default]) {
      if (rules !== undefined) { settings['compile.latex.engineRules'] = rules; }
      for (const [classes, options, expected] of cases) {
        for (const cls of classes) {
          const command = commands(project(cls, options)).make_latex_command();
          assert.strictEqual(command.command, expected, `${cls}[${options}]`);
          assert.deepStrictEqual(command.args, commonArgs);
          assert.strictEqual(command.output, expected === 'platex' || expected === 'uplatex' ? 'dvi' : 'pdf');
        }
      }
    }
  });

  test('fixed selection ignores source rules and permits an unregistered executable', () => {
    settings['compile.latex.engineSelection'] = 'fixed';
    settings['compile.latex.engine'] = 'xelatex';
    settings['compile.latex.engineRules'] = [];
    assert.deepStrictEqual(commands(project('jarticle')).make_latex_command(), {
      command: 'xelatex', args: commonArgs, output: 'pdf'
    });
  });

  test('custom rules replace defaults, use first match, and require every option', () => {
    settings['compile.latex.engine'] = 'fallback';
    settings['compile.latex.engineRules'] = [
      { classes: ['custom', 'custom-book'], options: ['mode={a,b}', 'draft'], engine: 'lualatex' },
      { classes: ['custom'], engine: 'platex' },
      { options: ['draft'], engine: 'xelatex' }
    ];
    const select = (cls: string, options = '') => commands(project(cls, options)).make_latex_command().command;
    assert.strictEqual(select('custom', ' draft, mode={a,b} '), 'lualatex');
    assert.strictEqual(select('custom-book', 'mode={a,b}, draft'), 'lualatex');
    assert.strictEqual(select('custom', 'mode={a,b}'), 'platex');
    assert.strictEqual(select('other', 'draft'), 'xelatex');
    assert.strictEqual(select('article'), 'fallback');
    settings['compile.latex.engineRules'] = [];
    assert.strictEqual(select('jarticle'), 'fallback');
  });

  test('fills each omitted engine field and orders common, engine and directive arguments', () => {
    settings['compile.latex.engineSelection'] = 'fixed';
    settings['compile.latex.engine'] = 'custom';
    settings['compile.latex.engines'] = { custom: { output: 'pdf' } };
    assert.deepStrictEqual(commands().make_latex_command(), {
      command: 'custom', args: commonArgs, output: 'pdf'
    });
    settings['compile.latex.engines'] = {
      custom: { command: 'C:\\TeX Programs\\latex.exe', args: ['--engine', 'another value'], output: 'pdf' }
    };
    assert.deepStrictEqual(commands(project('article', '', { t2dopt: '--source --last' })).make_latex_command(), {
      command: 'C:\\TeX Programs\\latex.exe',
      args: [...commonArgs, '--engine', 'another value', '--source', '--last'], output: 'pdf'
    });
    settings['compile.latex.engines'] = { custom: { command: 'lualatex' } };
    assert.strictEqual(commands().make_latex_command().output, 'pdf');
    settings['compile.latex.engines'] = { custom: {} };
    assert.strictEqual(commands().make_latex_command().output, 'dvi');
  });

  test('retains legacy output detection and lets the DVI argument override explicit PDF', () => {
    settings['compile.latex.engineSelection'] = 'fixed';
    for (const [engine, output] of [
      ['pdftex', 'pdf'], ['luatex', 'pdf'], ['xetex', 'pdf'], ['context', 'pdf'], ['latex', 'dvi']
    ]) {
      settings['compile.latex.engine'] = engine;
      assert.strictEqual(commands().make_latex_command().output, output);
    }
    settings['compile.latex.engine'] = 'custom';
    settings['compile.latex.engines'] = { custom: { output: 'pdf' } };
    assert.strictEqual(commands(project('article', '', { t2dopt: '-output-format=dvi' })).make_latex_command().output, 'dvi');
    settings['compile.latex.engines'] = { custom: { args: ['-output-format=dvi'], output: 'pdf' } };
    assert.strictEqual(commands().make_latex_command().output, 'dvi');
  });

  test('single-program percent-sharp overrides fixed and source selection without command remapping', () => {
    settings['compile.latex.engine'] = 'lualatex';
    settings['compile.latex.engines'] = { platex: { command: 'unapproved-wrapper', args: ['--extra'] } };
    for (const selection of ['source', 'fixed']) {
      settings['compile.latex.engineSelection'] = selection;
      assert.deepStrictEqual(commands(project('article', '', { '!': 'platex', t2dopt: '--source' })).make_latex_command(), {
        command: 'platex', args: [...commonArgs, '--extra', '--source'], output: 'dvi'
      });
    }
  });

  test('helper programs support defaults, partial overrides and literal percent-sharp priority', () => {
    for (const [key, fallback] of [
      ['bibtex', 'upbibtex'], ['makeindex', 'upmendex'], ['dvipdf', 'dvipdfmx']
    ] as const) {
      assert.deepStrictEqual(commands().make_program_command(key), { command: fallback, args: [] });
      settings[`compile.${key}`] = { args: ['--option', 'value with spaces'] };
      assert.deepStrictEqual(commands().make_program_command(key), {
        command: fallback, args: ['--option', 'value with spaces']
      });
      settings[`compile.${key}`] = { command: 'custom-helper', args: ['--option'] };
      assert.deepStrictEqual(commands().make_program_command(key), { command: 'custom-helper', args: ['--option'] });
      assert.deepStrictEqual(commands(project('article', '', { [key]: ` ${fallback} ` })).make_program_command(key), {
        command: fallback, args: ['--option']
      });
      settings[`compile.${key}`] = { command: '', args: ['--option'] };
      assert.deepStrictEqual(commands(project('article', '', { [key]: fallback })).make_program_command(key), {
        command: fallback, args: ['--option']
      });
    }
  });

  test('does not validate fallback settings or rules that are bypassed', () => {
    settings['compile.latex.engine'] = '';
    settings['compile.latex.engineRules'] = [{ engine: 'pdflatex' }, null];
    assert.strictEqual(commands().make_latex_command().command, 'pdflatex');
    settings['compile.latex.engineSelection'] = 'invalid';
    settings['compile.latex.engineRules'] = null;
    settings['compile.latex.engines'] = { pdflatex: { command: '', args: ['--extra'] } };
    assert.deepStrictEqual(commands(project('article', '', { '!': 'pdflatex' })).make_latex_command(), {
      command: 'pdflatex', args: [...commonArgs, '--extra'], output: 'pdf'
    });
  });

  test('reports the setting path for malformed configuration', () => {
    for (const [key, value, detail] of [
      ['compile.latex.engineSelection', 'invalid', 'engineSelection'],
      ['compile.latex.engine', '', 'engine'],
      ['compile.latex.engineRules', null, 'engineRules'],
      ['compile.latex.engineRules', [{ classes: ['article'] }], 'engineRules[0].engine'],
      ['compile.latex.engineRules', [{ engine: 'pdflatex', classes: [1] }], 'engineRules[0].classes'],
      ['compile.latex.engineRules', [{ engine: 'pdflatex', options: [1] }], 'engineRules[0].options'],
      ['compile.latex.engines', null, 'engines'],
      ['compile.latex.engines', { pdflatex: { command: '' } }, 'engines.pdflatex.command'],
      ['compile.latex.engines', { pdflatex: { args: [1] } }, 'engines.pdflatex.args'],
      ['compile.latex.engines', { pdflatex: { output: 'ps' } }, 'engines.pdflatex.output'],
      ['compile.latex.engines', { pdflatex: { output: null } }, 'engines.pdflatex.output']
    ] as const) {
      settings = { [key]: value };
      if (key === 'compile.latex.engine') { settings['compile.latex.engineSelection'] = 'fixed'; }
      assert.throws(() => commands().make_latex_command(), (error: unknown) =>
        error instanceof Error && error.message.includes(`vscode-fortex.${key}`) && error.message.includes(detail));
    }
  });

  test('reports helper setting paths and validates arguments even with a source override', () => {
    for (const key of ['bibtex', 'makeindex', 'dvipdf'] as const) {
      for (const [value, detail] of [[null, ''], [{ command: '' }, '.command'], [{ args: [1] }, '.args']] as const) {
        settings = { [`compile.${key}`]: value };
        assert.throws(() => commands().make_program_command(key), (error: unknown) =>
          error instanceof Error && error.message.includes(`vscode-fortex.compile.${key}${detail}`));
      }
      assert.throws(() => commands(project('article', '', { [key]: 'custom' })).make_program_command(key),
        (error: unknown) => error instanceof Error && error.message.includes(`vscode-fortex.compile.${key}.args`));
    }
  });

  /** Runs action assertions through the public request API using an explicitly rooted saved source. */
  async function buildSavedSource(mainfile: vscode.Uri, directives: Record<string, string>,
    context?: BuildContext): Promise<BuildResult> {
    const source = [
      `%#main ${path.basename(mainfile.fsPath)}`,
      ...Object.entries(directives).map(([key, value]) => `%#${key} ${value}`),
      '\\documentclass{article}', '\\begin{document}', '\\end{document}'
    ].join('\n');
    await fs.writeFile(mainfile.fsPath, source, 'utf8');
    const cancellation = context ? undefined : new vscode.CancellationTokenSource();
    try {
      return await LaTeXCompile.createBuildRequest(mainfile).execute(context ?? {
        token: cancellation!.token, reportProgress() {}, reportNotice() {}
      });
    } finally { cancellation?.dispose(); }
  }

  /** Runs the actual pipeline and Process lifecycle while simulating only the external tools' OS boundary. */
  async function withBuild(run: (directory: string, calls: { command: string; args: string[] }[]) => Promise<void>) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fortex-engine-build-'));
    const calls: { command: string; args: string[] }[] = [];
    runProgram = async (command, args, cwd) => {
      assert.ok(cwd);
      assert.strictEqual(vscode.Uri.file(cwd).toString(), vscode.Uri.file(directory).toString());
      calls.push({ command, args: [...args] });
      return 0;
    };
    /** Supplies a child with real event ordering while keeping all executable behavior in the test. */
    subprocess.spawn = ((command: string, args: readonly string[], options: SpawnOptions) => {
      assert.strictEqual(options.shell, false);
      const cwd = options.cwd;
      assert.ok(typeof cwd === 'string');
      assert.strictEqual(vscode.Uri.file(cwd).toString(), vscode.Uri.file(directory).toString());
      let closed = false;
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(), stderr: new EventEmitter(),
        /** Confirms a simulated signal through the same close event used by real processes. */
        kill: () => { queueMicrotask(() => finish(null)); return true; }
      });
      /** Emits at most one close even when a tool finishes after a cancellation signal. */
      const finish = (code: number | null, error?: Error) => {
        if (closed) { return; }
        closed = true;
        if (error) { child.emit('error', error); }
        child.emit('close', code);
      };
      const runTool = runProgram;
      queueMicrotask(() => {
        void runTool(command, args, cwd).then(code => finish(code), error => finish(-1, error));
      });
      return child as unknown as ChildProcess;
    }) as typeof subprocess.spawn;
    try { await run(directory, calls); }
    finally {
      await Process.killAll();
      subprocess.spawn = originalSpawn;
      assert.strictEqual(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('fortex-engine-build-'));
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  test('uses configured programs throughout the real pipeline and snapshots settings before the first process', async () => {
    await withBuild(async (directory, calls) => {
      settings = {
        'compile.latex.engineSelection': 'fixed', 'compile.latex.engine': 'custom',
        'compile.latex.engines': { custom: { command: 'wrapper', args: ['--engine'], output: 'dvi' } },
        'compile.bibtex': { command: 'bib-helper', args: ['--bib'] },
        'compile.makeindex': { command: 'index-helper', args: ['--index'] },
        'compile.dvipdf': { command: 'pdf-helper', args: ['--pdf', 'two words'] }
      };
      const recordExecute = runProgram;
      runProgram = async (command, args, cwd) => {
        if (command === 'wrapper') {
          await fs.writeFile(path.join(directory, 'main.aux'), '\\citation{one}\n\\bibdata{refs}\n');
          await fs.writeFile(path.join(directory, 'main.idx'), '\\indexentry{one}{1}\n');
          settings['compile.latex.engines'] = { custom: { command: 'changed', output: 'pdf' } };
          settings['compile.bibtex'] = { command: 'changed' };
          settings['compile.makeindex'] = { command: 'changed' };
          settings['compile.dvipdf'] = { command: 'changed' };
        }
        if (command === 'index-helper') { await fs.writeFile(path.join(directory, 'main.ind'), 'index'); }
        return recordExecute(command, args, cwd);
      };
      const mainfile = vscode.Uri.file(path.join(directory, 'main.tex'));
      assert.strictEqual((await new TeXToPDF(project('article', '', { t2dopt: '--source' }, mainfile), '').build()).outcome, 'succeeded');
      assert.deepStrictEqual(calls.map(call => call.command), [
        'wrapper', 'wrapper', 'bib-helper', 'wrapper', 'index-helper', 'wrapper', 'pdf-helper'
      ]);
      for (const call of calls.filter(call => call.command === 'wrapper')) {
        assert.deepStrictEqual(call.args, [...commonArgs, '--engine', '--source', 'main.tex']);
      }
      assert.deepStrictEqual(calls.find(call => call.command === 'bib-helper')?.args, ['--bib', 'main']);
      assert.deepStrictEqual(calls.find(call => call.command === 'index-helper')?.args, ['--index', 'main']);
      assert.deepStrictEqual(calls.at(-1)?.args, ['--pdf', 'two words', 'main.dvi']);
    });
  });

  test('direct PDF output skips DVI conversion and command failures stop the build', async () => {
    await withBuild(async (directory, calls) => {
      settings['compile.latex.engineSelection'] = 'fixed';
      settings['compile.latex.engine'] = 'custom';
      settings['compile.latex.engines'] = { custom: { output: 'pdf' } };
      const proj = project('article', '', {}, vscode.Uri.file(path.join(directory, 'main.tex')));
      assert.strictEqual((await new TeXToPDF(proj, '').build()).outcome, 'succeeded');
      assert.deepStrictEqual(calls.map(call => call.command), ['custom']);
      const recordExecute = runProgram;
      runProgram = async (...args) => { await recordExecute(...args); return 1; };
      assert.strictEqual((await new TeXToPDF(proj, '').build()).outcome, 'failed');
      assert.strictEqual(calls.length, 2);
    });
  });

  test('includes final LaTeX warnings in a successful build without changing its outcome', async () => {
    await withBuild(async directory => {
      settings['compile.latex.engineSelection'] = 'fixed';
      settings['compile.latex.engine'] = 'custom';
      settings['compile.latex.engines'] = { custom: { output: 'pdf' } };
      const mainfile = vscode.Uri.file(path.join(directory, 'main.tex'));
      await fs.writeFile(mainfile.fsPath, 'source');
      const recordExecute = runProgram;
      runProgram = async (...args) => {
        await fs.writeFile(path.join(directory, 'main.log'), 'LaTeX Warning: Probe warning on input line 1.\n\n');
        await fs.writeFile(path.join(directory, 'main.pdf'), 'PDF');
        return recordExecute(...args);
      };
      const result = await new TeXToPDF(project('article', '', {}, mainfile), '').build();
      assert.strictEqual(result.outcome, 'succeeded');
      assert.strictEqual(result.severity, 'warning');
      const diagnostic = result.diagnostics?.flatMap(([, entries]) => entries)[0];
      assert.strictEqual(diagnostic?.severity, vscode.DiagnosticSeverity.Warning);
      assert.ok(diagnostic?.message.includes('Probe warning'));
    });
  });

  test('does not retain warnings resolved by a later LaTeX pass', async () => {
    await withBuild(async directory => {
      settings['compile.latex.engineSelection'] = 'fixed';
      settings['compile.latex.engine'] = 'custom';
      settings['compile.latex.engines'] = { custom: { output: 'pdf' } };
      const mainfile = vscode.Uri.file(path.join(directory, 'main.tex'));
      await fs.writeFile(path.join(directory, 'main.aux'), 'old');
      const recordExecute = runProgram;
      let passes = 0;
      runProgram = async (...args) => {
        passes++;
        await fs.writeFile(path.join(directory, 'main.aux'), 'new');
        await fs.writeFile(path.join(directory, 'main.log'), passes === 1
          ? 'LaTeX Warning: Temporary warning on input line 1.\n\n' : '(./main.tex)\n');
        await fs.writeFile(path.join(directory, 'main.pdf'), 'PDF');
        return recordExecute(...args);
      };
      const result = await new TeXToPDF(project('article', '', {}, mainfile), '').build();
      assert.strictEqual(passes, 2);
      assert.strictEqual(result.outcome, 'succeeded');
      assert.strictEqual(result.severity, 'info');
      assert.deepStrictEqual(result.diagnostics, []);
    });
  });

  test('does not publish an unchanged log for a successful launch or a failed launch', async () => {
    await withBuild(async directory => {
      settings['compile.latex.engineSelection'] = 'fixed';
      settings['compile.latex.engine'] = 'custom';
      settings['compile.latex.engines'] = { custom: { output: 'pdf' } };
      const mainfile = vscode.Uri.file(path.join(directory, 'main.tex'));
      await fs.writeFile(path.join(directory, 'main.log'), './main.tex:1: Previous build failed.\n');
      const recordExecute = runProgram;
      runProgram = async (...args) => {
        await fs.writeFile(path.join(directory, 'main.pdf'), 'PDF');
        return recordExecute(...args);
      };
      const succeeded = await new TeXToPDF(project('article', '', {}, mainfile), '').build();
      assert.strictEqual(succeeded.outcome, 'succeeded');
      assert.deepStrictEqual(succeeded.diagnostics, []);
      runProgram = async () => { throw new Error('Unable to launch engine'); };
      const failed = await new TeXToPDF(project('article', '', {}, mainfile), '').build();
      assert.strictEqual(failed.outcome, 'failed');
      assert.deepStrictEqual(failed.diagnostics ?? [], []);
    });
  });

  test('returns parsed LaTeX errors after a nonzero exit without duplicating the fatal summary', async () => {
    await withBuild(async directory => {
      settings['compile.latex.engineSelection'] = 'fixed';
      settings['compile.latex.engine'] = 'custom';
      settings['compile.latex.engines'] = { custom: { output: 'pdf' } };
      const mainfile = vscode.Uri.file(path.join(directory, 'main.tex'));
      await fs.writeFile(mainfile.fsPath, '\\broken');
      runProgram = async () => {
        await fs.writeFile(path.join(directory, 'main.log'), './main.tex:1: Undefined control sequence.\n'
          + 'l.1 \\broken\n             \n./main.tex:1: ==> Fatal error occurred, no output PDF file produced!\n');
        return 1;
      };
      const result = await new TeXToPDF(project('article', '', {}, mainfile), '').build();
      assert.strictEqual(result.outcome, 'failed');
      assert.strictEqual(result.diagnostics?.length, 1);
      assert.strictEqual(result.diagnostics[0][1].length, 1);
      const diagnostic = result.diagnostics[0][1][0];
      assert.strictEqual(diagnostic.severity, vscode.DiagnosticSeverity.Error);
      assert.deepStrictEqual([diagnostic.range.start.character, diagnostic.range.end.character], [0, 7]);
    });
  });

  test('percent-sharp action commands and the allowlist retain priority over settings', async () => {
    await withBuild(async (directory, calls) => {
      settings['compile.allowedPrograms'] = ['pdflatex'];
      settings['compile.latex.engineSelection'] = 'fixed';
      settings['compile.latex.engine'] = 'custom';
      settings['compile.latex.engines'] = { pdflatex: { command: 'unapproved-wrapper' } };
      const mainfile = vscode.Uri.file(path.join(directory, 'main.tex'));
      assert.strictEqual((await buildSavedSource(mainfile, { '!': 'pdflatex --direct %B' })).outcome, 'succeeded');
      assert.deepStrictEqual(calls, [{ command: 'pdflatex', args: ['--direct', 'main'] }]);
      assert.strictEqual((await buildSavedSource(mainfile, { '!': 'pdflatex' })).outcome, 'succeeded');
      assert.strictEqual(calls.at(-1)?.command, 'pdflatex');
      const count = calls.length;
      assert.strictEqual((await buildSavedSource(mainfile, { '!': 'forbidden' })).outcome, 'failed');
      assert.strictEqual(calls.length, count);
      assert.strictEqual((await buildSavedSource(mainfile, { bibtex: 'forbidden' })).outcome, 'failed');
      assert.strictEqual(calls.length, count);
    });
  });
  test('stops a percent-sharp command sequence at the first failed command', async () => {
    await withBuild(async (directory, calls) => {
      settings['compile.allowedPrograms'] = ['first', 'second'];
      const record = runProgram;
      runProgram = async (...args) => {
        await record(...args);
        return 1;
      };
      const mainfile = vscode.Uri.file(path.join(directory, 'main.tex'));
      const result = await buildSavedSource(mainfile, {
        '!': 'first --flag %B; second %F'
      });
      assert.strictEqual(result.outcome, 'failed');
      assert.match(result.message, /first exited with code 1/);
      assert.deepStrictEqual(calls, [{ command: 'first', args: ['--flag', 'main'] }]);
    });
  });

  test('never launches the next percent-sharp command after cancellation', async () => {
    await withBuild(async (directory, calls) => {
      settings['compile.allowedPrograms'] = ['first', 'second'];
      const cancellation = new vscode.CancellationTokenSource();
      const record = runProgram;
      const messages: string[] = [];
      runProgram = async (...args) => {
        await record(...args);
        cancellation.cancel();
        return 0;
      };
      try {
        const mainfile = vscode.Uri.file(path.join(directory, 'main.tex'));
        const result = await buildSavedSource(mainfile, {
          '!': 'first --flag %B; second %F'
        }, { token: cancellation.token, reportProgress: message => messages.push(message), reportNotice() {} });
        assert.strictEqual(result.outcome, 'cancelled');
        assert.deepStrictEqual(calls, [{ command: 'first', args: ['--flag', 'main'] }]);
        assert.deepStrictEqual(messages.filter(message => message.startsWith('Running ')), ['Running first…']);
      } finally { cancellation.dispose(); }
    });
  });

  test('reports a bibliography failure as a warning when the PDF was produced', async () => {
    await withBuild(async (directory, calls) => {
      settings['compile.latex.engineSelection'] = 'fixed';
      settings['compile.latex.engine'] = 'custom';
      settings['compile.latex.engines'] = { custom: { command: 'engine', output: 'pdf' } };
      settings['compile.bibtex'] = { command: 'bib-helper' };
      const record = runProgram;
      runProgram = async (command, args, cwd) => {
        await record(command, args, cwd);
        if (command === 'engine') {
          await fs.writeFile(path.join(directory, 'main.aux'), '\\citation{one}\n\\bibdata{refs}\n');
          await fs.writeFile(path.join(directory, 'main.pdf'), 'generated PDF');
        }
        return command === 'bib-helper' ? 1 : 0;
      };
      const cancellation = new vscode.CancellationTokenSource();
      const messages: string[] = [];
      try {
        const result = await new TeXToPDF(project('article', '', {}, vscode.Uri.file(path.join(directory, 'main.tex'))), '')
          .build({ token: cancellation.token, onProgress: message => messages.push(message) });
        assert.strictEqual(result.outcome, 'succeeded');
        assert.strictEqual(result.severity, 'warning');
        assert.match(result.message, /bib-helper exited with code 1/);
        assert.strictEqual(result.diagnostics?.[0][0].fsPath, vscode.Uri.file(path.join(directory, 'main.tex')).fsPath);
        const diagnostic = result.diagnostics?.[0][1][0];
        assert.strictEqual(diagnostic?.severity, vscode.DiagnosticSeverity.Error);
        assert.strictEqual(diagnostic?.code, 'bibliography-failed');
        assert.match(diagnostic!.message, /Source location unknown/);
        assert.ok(diagnostic?.range.isEqual(new vscode.Range(0, 0, 0, 0)));
        assert.strictEqual(result.pdfs?.[0].fsPath, vscode.Uri.file(path.join(directory, 'main.pdf')).fsPath);
        assert.ok(messages.includes('Processing bibliography…'));
        assert.strictEqual(calls.at(-1)?.command, 'engine');
      } finally { cancellation.dispose(); }
    });
  });

  test('never starts another LaTeX pass after cancellation during bibliography processing', async () => {
    await withBuild(async (directory, calls) => {
      settings['compile.latex.engineSelection'] = 'fixed';
      settings['compile.latex.engine'] = 'custom';
      settings['compile.latex.engines'] = { custom: { command: 'engine', output: 'pdf' } };
      settings['compile.bibtex'] = { command: 'bib-helper' };
      const cancellation = new vscode.CancellationTokenSource();
      const record = runProgram;
      runProgram = async (command, args, cwd) => {
        await record(command, args, cwd);
        if (command === 'engine') { await fs.writeFile(path.join(directory, 'main.aux'), '\\citation{one}\n\\bibdata{refs}\n'); }
        if (command === 'bib-helper') { cancellation.cancel(); return 1; }
        return 0;
      };
      try {
        const result = await new TeXToPDF(project('article', '', {}, vscode.Uri.file(path.join(directory, 'main.tex'))), '')
          .build({ token: cancellation.token, onProgress() {} });
        assert.strictEqual(result.outcome, 'cancelled');
        assert.strictEqual(calls.at(-1)?.command, 'bib-helper');
        assert.strictEqual(result.pdfs, undefined);
      } finally { cancellation.dispose(); }
    });
  });

  test('keeps PDF conversion failure distinct from recoverable helper warnings', async () => {
    await withBuild(async (directory, calls) => {
      settings['compile.latex.engineSelection'] = 'fixed';
      settings['compile.latex.engine'] = 'platex';
      const record = runProgram;
      runProgram = async (command, args, cwd) => {
        await record(command, args, cwd);
        return command === 'dvipdfmx' ? 1 : 0;
      };
      const result = await new TeXToPDF(project('article', '', {}, vscode.Uri.file(path.join(directory, 'main.tex'))), '').build();
      assert.strictEqual(result.outcome, 'failed');
      assert.match(result.message, /dvipdfmx exited with code 1/);
      assert.strictEqual(calls.at(-1)?.command, 'dvipdfmx');
    });
  });

  test('does not report an unchanged PDF from a previous run as a newly generated artifact', async () => {
    await withBuild(async directory => {
      settings['compile.latex.engineSelection'] = 'fixed';
      settings['compile.latex.engine'] = 'pdflatex';
      await fs.writeFile(path.join(directory, 'main.pdf'), 'old PDF');
      const result = await new TeXToPDF(project('article', '', {}, vscode.Uri.file(path.join(directory, 'main.tex'))), '').build();
      assert.strictEqual(result.outcome, 'succeeded');
      assert.strictEqual(result.severity, 'warning');
      assert.deepStrictEqual(result.pdfs, []);
      assert.match(result.message, /No new PDF/);
    });
  });

  test('compares bibliography declarations with the build start even after auxiliary snapshots stabilize', async () => {
    await withBuild(async directory => {
      const aux = path.join(directory, 'main.aux');
      const before = '\\citation{one}\n\\bibcite{one}{1}\n\\bibdata{old}\n\\bibstyle{plain}\n';
      await fs.writeFile(aux, before);
      for (const name of ['old.bib', 'plain.bst', 'main.bbl']) {
        await fs.writeFile(path.join(directory, name), 'data');
        await fs.utimes(path.join(directory, name), 1000, name === 'main.bbl' ? 2000 : 1000);
      }
      const methods = new TeXToPDF(project('article', '', {}, vscode.Uri.file(path.join(directory, 'main.tex'))), '') as unknown as BibliographyMethods;
      const command = { command: 'upbibtex', args: [] };
      methods.read_status(command);
      await fs.writeFile(aux, before.replace('{old}', '{new}'));
      assert.strictEqual(methods.latex_check(), true);
      assert.strictEqual(methods.latex_check(), false);
      assert.strictEqual(await methods.bib_check(command), true);
      await fs.writeFile(aux, before);
      methods.latex_check();
      assert.strictEqual(await methods.bib_check(command), false, 'Returning to the original declarations needs no extra run');
      await fs.writeFile(aux, before.replace('{plain}', '{another}'));
      methods.latex_check();
      assert.strictEqual(await methods.bib_check(command), true);
    });
  });

  test('checks both database and style timestamps using the configured BibTeX program context', async () => {
    await withBuild(async directory => {
      await fs.writeFile(path.join(directory, 'main.aux'), '\\citation{one,two}\n\\bibcite{one}{1}\n\\bibcite{two}{2}\n\\bibdata{refs}\n\\bibstyle{plain}');
      for (const name of ['refs.bib', 'plain.bst', 'main.bbl']) {
        await fs.writeFile(path.join(directory, name), 'data');
        await fs.utimes(path.join(directory, name), 1000, name === 'main.bbl' ? 2000 : 1000);
      }
      const methods = new TeXToPDF(project('article', '', {}, vscode.Uri.file(path.join(directory, 'main.tex'))), '') as unknown as BibliographyMethods;
      const command = { command: 'upbibtex', args: [] };
      KpsewhichResolver.resolve = async (main, names, program) => {
        assert.strictEqual(program, 'upbibtex');
        assert.deepStrictEqual(names, ['refs.bib', 'plain.bst']);
        return names.map(name => vscode.Uri.file(path.join(directory, name)));
      };
      methods.read_status(command);
      assert.strictEqual(await methods.bib_check(command), false);
      for (const name of ['refs.bib', 'plain.bst']) {
        await fs.utimes(path.join(directory, name), 3000, 3000);
        assert.strictEqual(await methods.bib_check(command), true, name);
        await fs.utimes(path.join(directory, name), 1000, 1000);
      }
      await fs.unlink(path.join(directory, 'main.bbl'));
      assert.strictEqual(await methods.bib_check(command), true);
    });
  });

  test('uses BCF content rather than its timestamp and detects Biber datasource edits', async () => {
    await withBuild(async directory => {
      const control = path.join(directory, 'main.bcf');
      const text = '<bcf:controlfile xmlns:bcf="urn:test"><bcf:bibdata><bcf:datasource type="file" glob="false">refs&amp;data.bib</bcf:datasource></bcf:bibdata></bcf:controlfile>';
      await fs.writeFile(control, text);
      const data = path.join(directory, 'refs&data.bib');
      await fs.writeFile(data, 'data'); await fs.utimes(data, 1000, 1000);
      await fs.writeFile(path.join(directory, 'main.bbl'), 'data');
      await fs.utimes(path.join(directory, 'main.bbl'), 2000, 2000);
      const methods = new TeXToPDF(project('article', '', {}, vscode.Uri.file(path.join(directory, 'main.tex'))), '') as unknown as BibliographyMethods;
      const command = { command: 'C:\\TeX Programs\\BIBER.EXE', args: [] };
      methods.read_status(command);
      await fs.utimes(control, 3000, 3000);
      assert.strictEqual(await methods.bib_check(command), false, 'Rewriting an identical BCF must not rerun Biber');
      await fs.utimes(data, 4000, 4000);
      assert.strictEqual(await methods.bib_check(command), true);
      await fs.utimes(data, 1000, 1000);
      await fs.writeFile(control, text.replace('glob="false"', 'glob="true"'));
      assert.strictEqual(await methods.bib_check(command), true);
      methods.read_status(command);
      await fs.utimes(control, 5000, 5000);
      assert.strictEqual(await methods.bib_check(command), true, 'Glob inputs conservatively run once');
    });
  });

  test('honors current logreq requests but ignores stale requests and orphaned BCF files', async () => {
    await withBuild(async directory => {
      const control = path.join(directory, 'main.bcf');
      const requests = path.join(directory, 'main.run.xml');
      await fs.writeFile(control, '<controlfile/>');
      const methods = new TeXToPDF(project('article', '', {}, vscode.Uri.file(path.join(directory, 'main.tex'))), '') as unknown as BibliographyMethods;
      const command = { command: 'biber', args: [] };
      methods.read_status(command);
      assert.strictEqual(await methods.bib_check(command), false);
      await fs.writeFile(requests, '<requests><external active="1"><generic>biber</generic></external></requests>');
      assert.strictEqual(await methods.bib_check(command), true);
      methods.read_status(command);
      assert.strictEqual(await methods.bib_check(command), false);
    });
  });

  test('reports a Biber failure once and continues with a warning', async () => {
    await withBuild(async (directory, calls) => {
      settings['compile.latex.engineSelection'] = 'fixed';
      settings['compile.latex.engine'] = 'custom';
      settings['compile.latex.engines'] = { custom: { command: 'engine', output: 'pdf' } };
      settings['compile.bibtex'] = { command: 'biber' };
      const record = runProgram;
      runProgram = async (command, args, cwd) => {
        await record(command, args, cwd);
        if (command === 'engine') {
          await fs.writeFile(path.join(directory, 'main.bcf'), '<controlfile/>');
          await fs.writeFile(path.join(directory, 'main.pdf'), 'new PDF');
        }
        return command === 'biber' ? 1 : 0;
      };
      const result = await new TeXToPDF(project('article', '', {}, vscode.Uri.file(path.join(directory, 'main.tex'))), '').build();
      assert.strictEqual(result.outcome, 'succeeded');
      assert.strictEqual(result.severity, 'warning');
      assert.match(result.message, /biber exited with code 1/);
      assert.deepStrictEqual(calls.map(call => call.command), ['engine', 'biber', 'engine']);
    });
  });

  test('checks cancellation after awaiting bibliography resolution', async () => {
    await withBuild(async directory => {
      await fs.writeFile(path.join(directory, 'main.aux'), '\\citation{*}\n\\bibdata{refs}');
      await fs.writeFile(path.join(directory, 'main.bbl'), 'old bibliography');
      const cancellation = new vscode.CancellationTokenSource();
      KpsewhichResolver.resolve = async () => { cancellation.cancel(); return []; };
      const methods = new TeXToPDF(project('article', '', {}, vscode.Uri.file(path.join(directory, 'main.tex'))), '') as unknown as BibliographyMethods;
      const command = { command: 'upbibtex', args: [] };
      methods.read_status(command);
      try { await assert.rejects(methods.bib_check(command, { token: cancellation.token }), vscode.CancellationError); }
      finally { cancellation.dispose(); }
    });
  });

  /** Selects a predictable PDF engine and index program for index lifecycle assertions. */
  function configureIndex(command = 'index-helper', args: string[] = []): void {
    settings['compile.latex.engineSelection'] = 'fixed';
    settings['compile.latex.engine'] = 'custom';
    settings['compile.latex.engines'] = { custom: { command: 'engine', output: 'pdf' } };
    settings['compile.makeindex'] = { command, args };
  }

  /** Builds one fresh pipeline instance using the test directory's main file. */
  function buildIndex(directory: string, token?: vscode.CancellationToken) {
    return new TeXToPDF(project('article', '', {}, vscode.Uri.file(path.join(directory, 'main.tex'))), '').build({ token });
  }

  test('skips an unchanged index even when LaTeX rewrites it with a newer timestamp', async () => {
    await withBuild(async (directory, calls) => {
      configureIndex();
      const content = Buffer.from([92, 105, 110, 100, 101, 120, 128, 129, 10]);
      await fs.writeFile(path.join(directory, 'main.idx'), content);
      await fs.writeFile(path.join(directory, 'main.ind'), 'existing');
      await fs.utimes(path.join(directory, 'main.ind'), 1000, 1000);
      const record = runProgram;
      runProgram = async (command, args, cwd) => {
        if (command === 'engine') {
          await fs.writeFile(path.join(directory, 'main.idx'), content);
          await fs.writeFile(path.join(directory, 'main.pdf'), 'PDF');
        }
        return record(command, args, cwd);
      };
      const result = await buildIndex(directory);
      assert.strictEqual(result.severity, 'info');
      assert.deepStrictEqual(calls.map(call => call.command), ['engine']);
      assert.deepStrictEqual(result.diagnostics, []);
    });
  });

  test('regenerates an index after its insertion shifts body pages and stops when IDX content stabilizes', async () => {
    await withBuild(async (directory, calls) => {
      configureIndex();
      const record = runProgram;
      let indexed = false;
      runProgram = async (command, args, cwd) => {
        if (command === 'engine') {
          await fs.writeFile(path.join(directory, 'main.idx'), `\\indexentry{word}{${indexed ? 2 : 1}}\n`);
          await fs.writeFile(path.join(directory, 'main.pdf'), 'PDF');
        } else if (command === 'index-helper') {
          await fs.copyFile(path.join(directory, 'main.idx'), path.join(directory, 'main.ind'));
          indexed = true;
        }
        return record(command, args, cwd);
      };
      assert.strictEqual((await buildIndex(directory)).severity, 'info');
      assert.deepStrictEqual(calls.map(call => call.command), ['engine', 'index-helper', 'engine', 'index-helper', 'engine']);
      assert.match(await fs.readFile(path.join(directory, 'main.ind'), 'utf8'), /\{2\}/);
      calls.length = 0;
      await buildIndex(directory);
      assert.deepStrictEqual(calls.map(call => call.command), ['engine'], 'A new request captures its own initial IDX');
      await fs.unlink(path.join(directory, 'main.ind'));
      calls.length = 0;
      await buildIndex(directory);
      assert.deepStrictEqual(calls.map(call => call.command), ['engine', 'index-helper', 'engine']);
    });
  });

  test('uses style/dictionary timestamps and short-option output paths without repeated processing', async () => {
    await withBuild(async (directory, calls) => {
      configureIndex('index-helper', ['-qsstyle.ist', '-d', 'reading.dic', '-oresult.ind']);
      const content = '\\indexentry{word}{1}\n';
      await fs.writeFile(path.join(directory, 'main.idx'), content);
      for (const name of ['style.ist', 'reading.dic', 'result.ind']) {
        await fs.writeFile(path.join(directory, name), 'data');
        await fs.utimes(path.join(directory, name), 1000, name === 'result.ind' ? 2000 : 1000);
      }
      const lookups: { names: readonly string[]; searchPath?: string }[] = [];
      KpsewhichResolver.resolve = async (_main, names, _program, searchPath) => {
        lookups.push({ names, searchPath });
        return names.map(name => vscode.Uri.file(path.join(directory, name)));
      };
      const record = runProgram;
      runProgram = async (command, args, cwd) => {
        if (command === 'engine') { await fs.writeFile(path.join(directory, 'main.idx'), content); }
        if (command === 'index-helper') { await fs.writeFile(path.join(directory, 'result.ind'), 'generated'); }
        return record(command, args, cwd);
      };
      await buildIndex(directory);
      assert.strictEqual(calls.filter(call => call.command === 'index-helper').length, 0);
      for (const name of ['style.ist', 'reading.dic']) {
        await fs.utimes(path.join(directory, 'result.ind'), 2000, 2000);
        await fs.utimes(path.join(directory, name), 3000, 3000);
        calls.length = 0;
        await buildIndex(directory);
        assert.strictEqual(calls.filter(call => call.command === 'index-helper').length, 1, name);
        await fs.utimes(path.join(directory, name), 1000, 1000);
      }
      assert.ok(lookups.some(lookup => lookup.names.includes('reading.dic')
        && lookup.searchPath === (process.env.INDEXDICTIONARY ?? '$INDEXDICTIONARY')));
      assert.deepStrictEqual(calls.find(call => call.command === 'index-helper')?.args,
        ['-qsstyle.ist', '-d', 'reading.dic', '-oresult.ind', 'main']);
    });
  });

  test('delegates empty input to the index tool and skips an already empty output', async () => {
    await withBuild(async (directory, calls) => {
      configureIndex('index-helper', ['-o', 'empty.ind']);
      await fs.writeFile(path.join(directory, 'main.idx'), ' \r\n\t');
      await fs.writeFile(path.join(directory, 'empty.ind'), 'obsolete');
      const record = runProgram;
      runProgram = async (command, args, cwd) => {
        if (command === 'index-helper') { await fs.writeFile(path.join(directory, 'empty.ind'), ''); }
        return record(command, args, cwd);
      };
      await buildIndex(directory);
      assert.strictEqual((await fs.readFile(path.join(directory, 'empty.ind'))).length, 0);
      assert.deepStrictEqual(calls.map(call => call.command), ['engine', 'index-helper', 'engine']);
      assert.strictEqual(await fs.readFile(path.join(directory, 'main.idx'), 'utf8'), ' \r\n\t');
      calls.length = 0;
      await buildIndex(directory);
      assert.deepStrictEqual(calls.map(call => call.command), ['engine']);
      await fs.unlink(path.join(directory, 'empty.ind'));
      await buildIndex(directory);
      assert.strictEqual((await fs.stat(path.join(directory, 'empty.ind'))).size, 0);
    });
  });

  test('records one index failure in Problems and does not retry even if subsequent IDX content changes', async () => {
    await withBuild(async (directory, calls) => {
      configureIndex();
      const record = runProgram;
      let passes = 0;
      runProgram = async (command, args, cwd) => {
        await record(command, args, cwd);
        if (command === 'engine') {
          await fs.writeFile(path.join(directory, 'main.idx'), `\\indexentry{word}{${++passes}}`);
          await fs.writeFile(path.join(directory, 'main.pdf'), 'PDF');
        }
        return command === 'index-helper' ? 2 : 0;
      };
      const result = await buildIndex(directory);
      assert.strictEqual(result.outcome, 'succeeded');
      assert.strictEqual(result.severity, 'warning');
      assert.strictEqual(calls.filter(call => call.command === 'index-helper').length, 1);
      assert.strictEqual(result.diagnostics?.length, 1);
      assert.strictEqual(result.diagnostics?.[0][1][0].code, 'index-failed');
      assert.strictEqual(result.diagnostics?.[0][1][0].severity, vscode.DiagnosticSeverity.Error);
    });
  });

  test('accepts a zero exit code without index output and does not loop on that missing output', async () => {
    await withBuild(async (directory, calls) => {
      configureIndex();
      await fs.writeFile(path.join(directory, 'main.idx'), '\\indexentry{word}{1}');
      const record = runProgram;
      runProgram = async (command, args, cwd) => {
        if (command === 'engine') { await fs.writeFile(path.join(directory, 'main.pdf'), 'PDF'); }
        return record(command, args, cwd);
      };
      const result = await buildIndex(directory);
      assert.strictEqual(result.outcome, 'succeeded');
      assert.strictEqual(result.severity, 'info');
      assert.deepStrictEqual(result.diagnostics, []);
      await assert.rejects(fs.stat(path.join(directory, 'main.ind')), { code: 'ENOENT' });
      assert.strictEqual(calls.filter(call => call.command === 'index-helper').length, 1);
    });
  });

  test('reports an empty-input tool failure without modifying the existing index output', async () => {
    await withBuild(async (directory, calls) => {
      configureIndex();
      await fs.writeFile(path.join(directory, 'main.idx'), '');
      await fs.writeFile(path.join(directory, 'main.ind'), 'retained by the tool');
      const record = runProgram;
      runProgram = async (command, args, cwd) => {
        await record(command, args, cwd);
        if (command === 'engine') { await fs.writeFile(path.join(directory, 'main.pdf'), 'PDF'); }
        return command === 'index-helper' ? 255 : 0;
      };
      const result = await buildIndex(directory);
      assert.strictEqual(result.outcome, 'succeeded');
      assert.strictEqual(result.severity, 'warning');
      assert.strictEqual(result.diagnostics?.[0][1][0].code, 'index-failed');
      assert.strictEqual(await fs.readFile(path.join(directory, 'main.ind'), 'utf8'), 'retained by the tool');
      assert.strictEqual(calls.filter(call => call.command === 'index-helper').length, 1);
    });
  });

  test('keeps helper diagnostics when LaTeX fails later and passes successful-build errors through LaTeXCompile', async () => {
    await withBuild(async directory => {
      configureIndex();
      const record = runProgram;
      let indexFailed = false;
      runProgram = async (command, args, cwd) => {
        await record(command, args, cwd);
        if (command === 'index-helper') { indexFailed = true; return 1; }
        if (command === 'engine' && !indexFailed) {
          await fs.writeFile(path.join(directory, 'main.idx'), '\\indexentry{word}{1}');
          await fs.writeFile(path.join(directory, 'main.pdf'), 'PDF');
        } else if (command === 'engine') {
          await fs.writeFile(path.join(directory, 'main.log'), './main.tex:3: Later LaTeX error\n');
          return 1;
        }
        return 0;
      };
      const result = await buildIndex(directory);
      assert.strictEqual(result.outcome, 'failed');
      assert.deepStrictEqual(result.diagnostics?.flatMap(([, entries]) => entries.map(entry => entry.code)), ['index-failed', undefined]);
      assert.match(result.diagnostics![1][1][0].message, /Later LaTeX error/);
      runProgram = async (command, args, cwd) => {
        await record(command, args, cwd);
        if (command === 'engine') { await fs.writeFile(path.join(directory, 'main.pdf'), 'PDF'); }
        return command === 'index-helper' ? 1 : 0;
      };
      const reported = await buildSavedSource(vscode.Uri.file(path.join(directory, 'main.tex')), {});
      assert.strictEqual(reported.outcome, 'succeeded');
      assert.strictEqual(reported.severity, 'warning');
      assert.strictEqual(reported.diagnostics?.entries[0][1][0].code, 'index-failed');
    });
  });

  test('cancellation during index processing never creates a helper-error diagnostic or starts another pass', async () => {
    await withBuild(async (directory, calls) => {
      configureIndex();
      await fs.writeFile(path.join(directory, 'main.idx'), '\\indexentry{word}{1}');
      const cancellation = new vscode.CancellationTokenSource();
      const record = runProgram;
      runProgram = async (command, args, cwd) => {
        await record(command, args, cwd);
        if (command === 'index-helper') { cancellation.cancel(); }
        return 0;
      };
      try {
        const result = await buildIndex(directory, cancellation.token);
        assert.strictEqual(result.outcome, 'cancelled');
        assert.strictEqual(result.diagnostics, undefined);
        assert.deepStrictEqual(calls.map(call => call.command), ['engine', 'index-helper']);
      } finally { cancellation.dispose(); }
    });
  });

  test('bounds repeated index pagination changes with the existing LaTeX pass limit', async () => {
    await withBuild(async (directory, calls) => {
      configureIndex(); settings['compile.maxLaTeXRuns'] = 3;
      const record = runProgram;
      let page = 0;
      runProgram = async (command, args, cwd) => {
        if (command === 'engine') { await fs.writeFile(path.join(directory, 'main.idx'), `\\indexentry{word}{${++page}}`); }
        if (command === 'index-helper') { await fs.copyFile(path.join(directory, 'main.idx'), path.join(directory, 'main.ind')); }
        return record(command, args, cwd);
      };
      const result = await buildIndex(directory);
      assert.strictEqual(result.outcome, 'failed');
      assert.match(result.message, /Maximum number of LaTeX runs \(3\) exceeded/);
      assert.strictEqual(calls.filter(call => call.command === 'engine').length, 3);
    });
  });

});
