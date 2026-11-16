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
  output?: 'pdf' | 'dvi';
}

interface CommandMethods {
  make_latex_command(): Command;
  make_program_command(key: 'bibtex' | 'makeindex' | 'dvipdf'): Omit<Command, 'output'>;
}

interface AuxiliarySnapshot {
  readonly latex: ReadonlyMap<string, string | null>;
  readonly bcfText: string | null;
  readonly idx: Buffer | null;
}

interface BibliographyMethods {
  read_auxiliary_files(bibliography: Omit<Command, 'output'>, index: Omit<Command, 'output'>): AuxiliarySnapshot;
  bib_check(command: Omit<Command, 'output'>, start: AuxiliarySnapshot, previous: AuxiliarySnapshot | undefined,
    current: AuxiliarySnapshot,
    options?: { token: vscode.CancellationToken }): Promise<boolean>;
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
          assert.strictEqual(command.output, undefined);
        }
      }
    }
  });

  test('fixed selection ignores source rules and permits an unregistered executable', () => {
    settings['compile.latex.engineSelection'] = 'fixed';
    settings['compile.latex.engine'] = 'xelatex';
    settings['compile.latex.engineRules'] = [];
    assert.deepStrictEqual(commands(project('jarticle')).make_latex_command(), {
      command: 'xelatex', args: commonArgs, output: undefined
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
    assert.strictEqual(commands().make_latex_command().output, undefined);
    settings['compile.latex.engines'] = { custom: {} };
    assert.strictEqual(commands().make_latex_command().output, undefined);
  });

  test('leaves output unspecified regardless of executable name and gives explicit settings priority over arguments', () => {
    settings['compile.latex.engineSelection'] = 'fixed';
    for (const engine of ['pdftex', 'luatex', 'xetex', 'context', 'latex', 'C:\\TeX Programs\\pdflatex.exe']) {
      settings['compile.latex.engine'] = engine;
      assert.strictEqual(commands().make_latex_command().output, undefined);
    }
    settings['compile.latex.engine'] = 'custom';
    settings['compile.latex.engines'] = { custom: { output: 'pdf' } };
    const directive = commands(project('article', '', { t2dopt: '-output-format=dvi' })).make_latex_command();
    assert.strictEqual(directive.output, 'pdf');
    assert.deepStrictEqual(directive.args, [...commonArgs, '-output-format=dvi']);
    settings['compile.latex.engines'] = { custom: { args: ['-output-format=dvi'], output: 'pdf' } };
    assert.strictEqual(commands().make_latex_command().output, 'pdf');
    settings['compile.latex.engines'] = { custom: { args: ['-output-format=pdf'], output: 'dvi' } };
    assert.strictEqual(commands().make_latex_command().output, 'dvi');
    settings['compile.latex.engines'] = { custom: { args: ['-output-format=dvi'] } };
    assert.strictEqual(commands().make_latex_command().output, undefined);
  });

  test('single-program percent-sharp overrides fixed and source selection without command remapping', () => {
    settings['compile.latex.engine'] = 'lualatex';
    settings['compile.latex.engines'] = { platex: { command: 'unapproved-wrapper', args: ['--extra'] } };
    for (const selection of ['source', 'fixed']) {
      settings['compile.latex.engineSelection'] = selection;
      assert.deepStrictEqual(commands(project('article', '', { '!': 'platex', t2dopt: '--source' })).make_latex_command(), {
        command: 'platex', args: [...commonArgs, '--extra', '--source'], output: undefined
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
      command: 'pdflatex', args: [...commonArgs, '--extra'], output: undefined
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
        'wrapper', 'bib-helper', 'wrapper', 'index-helper', 'wrapper', 'pdf-helper'
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

  test('automatically converts new or updated DVI when PDF is missing or unchanged', async () => {
    for (const [existingDVI, existingPDF, engine] of [
      [false, false, 'pdf-wrapper'], [false, true, 'custom'],
      [true, false, 'C:\\TeX Programs\\lualatex.exe'], [true, true, 'platex']
    ] as const) {
      await withBuild(async (directory, calls) => {
        settings['compile.latex.engineSelection'] = 'fixed';
        settings['compile.latex.engine'] = engine;
        const dvi = path.join(directory, 'main.dvi');
        const pdf = path.join(directory, 'main.pdf');
        if (existingDVI) { await fs.writeFile(dvi, 'old DVI'); }
        if (existingPDF) { await fs.writeFile(pdf, 'old PDF'); }
        const record = runProgram;
        runProgram = async (command, args, cwd) => {
          await record(command, args, cwd);
          if (command === engine) { await fs.writeFile(dvi, 'new DVI output'); }
          if (command === 'dvipdfmx') { await fs.writeFile(pdf, 'converted PDF'); }
          return 0;
        };
        const mainfile = vscode.Uri.file(path.join(directory, 'main.tex'));
        const result = await new TeXToPDF(project('article', '', {}, mainfile), '').build();
        assert.deepStrictEqual(calls.map(call => call.command), [engine, 'dvipdfmx']);
        assert.deepStrictEqual(calls[1].args, ['main.dvi']);
        assert.strictEqual(result.outcome, 'succeeded');
        assert.strictEqual(result.severity, 'info');
        assert.strictEqual(result.pdfs?.[0].fsPath, vscode.Uri.file(pdf).fsPath);
        assert.strictEqual(await fs.readFile(pdf, 'utf8'), 'converted PDF');
      });
    }
  });

  test('automatically skips conversion when PDF is new or updated even if DVI also changes', async () => {
    for (const existingPDF of [false, true]) {
      for (const updateDVI of [false, true]) {
        await withBuild(async (directory, calls) => {
          settings['compile.latex.engineSelection'] = 'fixed';
          settings['compile.latex.engine'] = 'latex';
          const pdf = path.join(directory, 'main.pdf');
          const dvi = path.join(directory, 'main.dvi');
          if (existingPDF) { await fs.writeFile(pdf, 'old PDF'); }
          await fs.writeFile(dvi, 'old DVI');
          const record = runProgram;
          runProgram = async (...args) => {
            await record(...args);
            await fs.writeFile(pdf, 'new direct PDF output');
            if (updateDVI) { await fs.writeFile(dvi, 'new DVI output'); }
            return 0;
          };
          const mainfile = vscode.Uri.file(path.join(directory, 'main.tex'));
          const result = await new TeXToPDF(project('article', '', {}, mainfile), '').build();
          assert.deepStrictEqual(calls.map(call => call.command), ['latex']);
          assert.strictEqual(result.outcome, 'succeeded');
          assert.strictEqual(result.severity, 'info');
          assert.strictEqual(result.pdfs?.[0].fsPath, vscode.Uri.file(pdf).fsPath);
        });
      }
    }
  });

  test('does not convert missing or unchanged DVI even when an old DVI is newer than PDF', async () => {
    for (const existingPDF of [false, true]) {
      for (const existingDVI of [false, true]) {
        await withBuild(async (directory, calls) => {
          settings['compile.latex.engineSelection'] = 'fixed';
          settings['compile.latex.engine'] = 'platex';
          for (const [exists, name, time] of [[existingPDF, 'main.pdf', 1000], [existingDVI, 'main.dvi', 2000]] as const) {
            if (!exists) { continue; }
            const filename = path.join(directory, name);
            await fs.writeFile(filename, 'old output');
            await fs.utimes(filename, time, time);
          }
          const mainfile = vscode.Uri.file(path.join(directory, 'main.tex'));
          const result = await new TeXToPDF(project('article', '', {}, mainfile), '').build();
          assert.deepStrictEqual(calls.map(call => call.command), ['platex']);
          assert.strictEqual(result.outcome, 'succeeded');
          assert.strictEqual(result.severity, 'warning');
          assert.match(result.message, /No new PDF/);
          assert.deepStrictEqual(result.pdfs, []);
        });
      }
    }
  });

  test('explicit PDF skips conversion despite a new DVI and DVI output arguments', async () => {
    await withBuild(async (directory, calls) => {
      settings['compile.latex.engineSelection'] = 'fixed';
      settings['compile.latex.engine'] = 'platex';
      settings['compile.latex.engines'] = { platex: { args: ['-output-format=dvi'], output: 'pdf' } };
      const record = runProgram;
      runProgram = async (...args) => {
        await record(...args);
        await fs.writeFile(path.join(directory, 'main.dvi'), 'DVI');
        return 0;
      };
      const mainfile = vscode.Uri.file(path.join(directory, 'main.tex'));
      const result = await new TeXToPDF(project('article', '', {}, mainfile), '').build();
      assert.deepStrictEqual(calls, [{ command: 'platex', args: [...commonArgs, '-output-format=dvi', 'main.tex'] }]);
      assert.strictEqual(result.outcome, 'succeeded');
      assert.strictEqual(result.severity, 'warning');
      assert.match(result.message, /No new PDF/);
    });
  });

  test('explicit DVI runs conversion even when PDF was produced and DVI was unchanged', async () => {
    await withBuild(async (directory, calls) => {
      settings['compile.latex.engineSelection'] = 'fixed';
      settings['compile.latex.engine'] = 'custom';
      settings['compile.latex.engines'] = { custom: { output: 'dvi' } };
      const dvi = path.join(directory, 'main.dvi');
      const pdf = path.join(directory, 'main.pdf');
      await fs.writeFile(dvi, 'existing DVI');
      const record = runProgram;
      runProgram = async (command, args, cwd) => {
        await record(command, args, cwd);
        await fs.writeFile(pdf, command === 'custom' ? 'direct PDF' : 'converted PDF');
        return 0;
      };
      const mainfile = vscode.Uri.file(path.join(directory, 'main.tex'));
      const result = await new TeXToPDF(project('article', '', {}, mainfile), '').build();
      assert.deepStrictEqual(calls.map(call => call.command), ['custom', 'dvipdfmx']);
      assert.strictEqual(await fs.readFile(dvi, 'utf8'), 'existing DVI');
      assert.strictEqual(await fs.readFile(pdf, 'utf8'), 'converted PDF');
      assert.strictEqual(result.outcome, 'succeeded');
      assert.strictEqual(result.severity, 'info');
    });
  });

  test('decides conversion after all LaTeX passes using the build-start snapshots', async () => {
    for (const finalPDF of [false, true]) {
      await withBuild(async (directory, calls) => {
        settings['compile.latex.engineSelection'] = 'fixed';
        settings['compile.latex.engine'] = 'custom';
        const aux = path.join(directory, 'main.aux');
        await fs.writeFile(aux, 'old auxiliary contents');
        const record = runProgram;
        let passes = 0;
        runProgram = async (command, args, cwd) => {
          await record(command, args, cwd);
          if (command === 'custom') {
            passes++;
            await fs.writeFile(aux, 'stable auxiliary contents');
            if (passes === 1) { await fs.writeFile(path.join(directory, 'main.dvi'), 'DVI'); }
            else if (finalPDF) { await fs.writeFile(path.join(directory, 'main.pdf'), 'direct PDF'); }
          } else {
            assert.strictEqual(passes, 2);
            await fs.writeFile(path.join(directory, 'main.pdf'), 'converted PDF');
          }
          return 0;
        };
        const mainfile = vscode.Uri.file(path.join(directory, 'main.tex'));
        const result = await new TeXToPDF(project('article', '', {}, mainfile), '').build();
        assert.strictEqual(passes, 2);
        assert.deepStrictEqual(calls.map(call => call.command), finalPDF ? ['custom', 'custom'] : ['custom', 'custom', 'dvipdfmx']);
        assert.strictEqual(result.outcome, 'succeeded');
        assert.strictEqual(result.severity, 'info');
      });
    }
  });

  test('never converts a new DVI after a failed or cancelled LaTeX pass', async () => {
    for (const cancel of [false, true]) {
      await withBuild(async (directory, calls) => {
        settings['compile.latex.engineSelection'] = 'fixed';
        settings['compile.latex.engine'] = 'custom';
        const cancellation = new vscode.CancellationTokenSource();
        const record = runProgram;
        runProgram = async (...args) => {
          await record(...args);
          await fs.writeFile(path.join(directory, 'main.dvi'), 'DVI');
          if (cancel) { cancellation.cancel(); }
          return cancel ? 0 : 1;
        };
        try {
          const mainfile = vscode.Uri.file(path.join(directory, 'main.tex'));
          const result = await new TeXToPDF(project('article', '', {}, mainfile), '').build({ token: cancellation.token });
          assert.deepStrictEqual(calls.map(call => call.command), ['custom']);
          assert.strictEqual(result.outcome, cancel ? 'cancelled' : 'failed');
        } finally { cancellation.dispose(); }
      });
    }
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
        if (command === 'platex') { await fs.writeFile(path.join(directory, 'main.dvi'), 'DVI'); }
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

  test('prioritizes and repeats bibliography processing, succeeding when inputs stabilize at the LaTeX pass limit', async () => {
    await withBuild(async (directory, calls) => {
      settings['compile.latex.engineSelection'] = 'fixed';
      settings['compile.latex.engine'] = 'custom';
      settings['compile.latex.engines'] = { custom: { command: 'engine', output: 'pdf' } };
      settings['compile.bibtex'] = { command: 'bib-helper' };
      settings['compile.maxLaTeXRuns'] = 3;
      const record = runProgram;
      let latexRuns = 0;
      runProgram = async (command, args, cwd) => {
        await record(command, args, cwd);
        if (command === 'engine') {
          const key = ++latexRuns === 1 ? 'one' : 'two';
          await fs.writeFile(path.join(directory, 'main.aux'), `\\citation{${key}}\n\\bibdata{refs}\n`);
          await fs.writeFile(path.join(directory, 'main.pdf'), 'PDF');
        } else if (command === 'bib-helper') {
          await fs.writeFile(path.join(directory, 'main.aux'), '\\citation{two}\n\\bibdata{refs}\n');
        }
        return 0;
      };
      const result = await new TeXToPDF(project('article', '', {}, vscode.Uri.file(path.join(directory, 'main.tex'))), '').build();
      assert.strictEqual(result.outcome, 'succeeded');
      assert.deepStrictEqual(calls.map(call => call.command), ['engine', 'bib-helper', 'engine', 'bib-helper', 'engine']);
    });
  });

  test('does not retry unchanged bibliography input when citations, remote sources or active requests persist', async () => {
    for (const backend of ['bib-helper', 'biber']) {
      await withBuild(async (directory, calls) => {
        settings['compile.latex.engineSelection'] = 'fixed';
        settings['compile.latex.engine'] = 'custom';
        settings['compile.latex.engines'] = { custom: { command: 'engine', output: 'pdf' } };
        settings['compile.bibtex'] = { command: backend };
        const record = runProgram;
        runProgram = async (command, args, cwd) => {
          await record(command, args, cwd);
          if (command === 'engine') {
            await fs.writeFile(path.join(directory, 'main.aux'), '\\citation{missing}\n\\bibdata{refs}\n');
            await fs.writeFile(path.join(directory, 'main.bcf'),
              '<bcf:controlfile xmlns:bcf="urn:test"><bcf:datasource>https://example.invalid/refs.bib</bcf:datasource></bcf:controlfile>');
            await fs.writeFile(path.join(directory, 'main.run.xml'), '<requests><external active="1"><generic>biber</generic></external></requests>');
            await fs.writeFile(path.join(directory, 'main.pdf'), 'PDF');
          }
          return 0;
        };
        const result = await new TeXToPDF(project('article', '', {}, vscode.Uri.file(path.join(directory, 'main.tex'))), '').build();
        assert.strictEqual(result.outcome, 'succeeded');
        assert.deepStrictEqual(calls.map(call => call.command), ['engine', backend, 'engine']);
        await assert.rejects(fs.stat(path.join(directory, 'main.bbl')), { code: 'ENOENT' });
      });
    }
  });

  test('detects a database update on a later LaTeX pass after an earlier negative bibliography check', async () => {
    await withBuild(async (directory, calls) => {
      settings['compile.latex.engineSelection'] = 'fixed';
      settings['compile.latex.engine'] = 'custom';
      settings['compile.latex.engines'] = { custom: { command: 'engine', output: 'pdf' } };
      settings['compile.bibtex'] = { command: 'bib-helper' };
      const declarations = '\\citation{one}\n\\bibcite{one}{1}\n\\bibdata{refs}\n\\bibstyle{plain}\n';
      await fs.writeFile(path.join(directory, 'main.aux'), declarations + '\\newlabel{body}{{1}{1}}\n');
      for (const name of ['refs.bib', 'plain.bst', 'main.bbl']) {
        await fs.writeFile(path.join(directory, name), 'data');
        await fs.utimes(path.join(directory, name), 1000, name === 'main.bbl' ? 2000 : 1000);
      }
      const record = runProgram;
      let latexRuns = 0;
      runProgram = async (command, args, cwd) => {
        await record(command, args, cwd);
        if (command === 'engine') {
          await fs.writeFile(path.join(directory, 'main.aux'), declarations + '\\newlabel{body}{{1}{2}}\n');
          await fs.writeFile(path.join(directory, 'main.pdf'), 'PDF');
          if (++latexRuns === 2) { await fs.utimes(path.join(directory, 'refs.bib'), 3000, 3000); }
        }
        return 0;
      };
      const result = await new TeXToPDF(project('article', '', {}, vscode.Uri.file(path.join(directory, 'main.tex'))), '').build();
      assert.strictEqual(result.outcome, 'succeeded');
      assert.deepStrictEqual(calls.map(call => call.command), ['engine', 'engine', 'bib-helper', 'engine']);
    });
  });

  test('suppresses a failed bibliography tool even when a later LaTeX pass changes its input', async () => {
    await withBuild(async (directory, calls) => {
      settings['compile.latex.engineSelection'] = 'fixed';
      settings['compile.latex.engine'] = 'custom';
      settings['compile.latex.engines'] = { custom: { command: 'engine', output: 'pdf' } };
      settings['compile.bibtex'] = { command: 'bib-helper' };
      const record = runProgram;
      let latexRuns = 0;
      runProgram = async (command, args, cwd) => {
        await record(command, args, cwd);
        if (command === 'engine') {
          const key = ++latexRuns === 1 ? 'one' : 'two';
          await fs.writeFile(path.join(directory, 'main.aux'), `\\citation{${key}}\n\\bibdata{refs}\n`);
          await fs.writeFile(path.join(directory, 'main.pdf'), 'PDF');
        }
        return command === 'bib-helper' ? 1 : 0;
      };
      const result = await new TeXToPDF(project('article', '', {}, vscode.Uri.file(path.join(directory, 'main.tex'))), '').build();
      assert.strictEqual(result.outcome, 'succeeded');
      assert.strictEqual(result.severity, 'warning');
      assert.deepStrictEqual(calls.map(call => call.command), ['engine', 'bib-helper', 'engine', 'engine']);
      assert.deepStrictEqual(result.diagnostics?.flatMap(([, entries]) => entries.map(entry => entry.code)), ['bibliography-failed']);
    });
  });

  test('does not start a bibliography tool when the LaTeX pass limit leaves no pass to consume its result', async () => {
    await withBuild(async (directory, calls) => {
      settings['compile.latex.engineSelection'] = 'fixed';
      settings['compile.latex.engine'] = 'custom';
      settings['compile.latex.engines'] = { custom: { command: 'engine', output: 'pdf' } };
      settings['compile.bibtex'] = { command: 'bib-helper' };
      settings['compile.maxLaTeXRuns'] = 1;
      const record = runProgram;
      runProgram = async (command, args, cwd) => {
        await record(command, args, cwd);
        await fs.writeFile(path.join(directory, 'main.aux'), '\\citation{one}\n\\bibdata{refs}\n');
        return 0;
      };
      const result = await new TeXToPDF(project('article', '', {}, vscode.Uri.file(path.join(directory, 'main.tex'))), '').build();
      assert.strictEqual(result.outcome, 'failed');
      assert.match(result.message, /Maximum number of LaTeX runs \(1\) exceeded/);
      assert.deepStrictEqual(calls.map(call => call.command), ['engine']);
    });
  });

  test('allows repeated bibliography control changes beyond the default pass limit when the limit is zero', async () => {
    await withBuild(async (directory, calls) => {
      settings['compile.latex.engineSelection'] = 'fixed';
      settings['compile.latex.engine'] = 'custom';
      settings['compile.latex.engines'] = { custom: { command: 'engine', output: 'pdf' } };
      settings['compile.bibtex'] = { command: 'bib-helper' };
      settings['compile.maxLaTeXRuns'] = 0;
      const record = runProgram;
      let latexRuns = 0;
      runProgram = async (command, args, cwd) => {
        await record(command, args, cwd);
        if (command === 'engine') {
          const key = Math.min(++latexRuns, 8);
          await fs.writeFile(path.join(directory, 'main.aux'), `\\citation{key${key}}\n\\bibdata{refs}\n`);
          await fs.writeFile(path.join(directory, 'main.pdf'), 'PDF');
        }
        return 0;
      };
      const result = await new TeXToPDF(project('article', '', {}, vscode.Uri.file(path.join(directory, 'main.tex'))), '').build();
      assert.strictEqual(result.outcome, 'succeeded');
      assert.strictEqual(calls.filter(call => call.command === 'engine').length, 9);
      assert.strictEqual(calls.filter(call => call.command === 'bib-helper').length, 8);
    });
  });

  /**
   * テスト用の文献判定インターフェースを持つ新しいパイプラインを作る．
   * @param directory メインファイルを置く一時ディレクトリ．
   * @returns 新しいパイプラインの補助ファイル読込・文献判定メソッド．
   */
  function bibliographyMethods(directory: string): BibliographyMethods {
    return new TeXToPDF(project('article', '', {}, vscode.Uri.file(path.join(directory, 'main.tex'))), '') as unknown as BibliographyMethods;
  }

  /**
   * 文献判定に使用する現在の補助ファイルをまとめて読む．
   * @param methods 読み込みを行うパイプライン．
   * @param command 文献処理に使用するコマンド．
   * @returns 呼び出した時点の補助ファイルのスナップショット．
   */
  function bibliographySnapshot(methods: BibliographyMethods, command: Omit<Command, 'output'>): AuxiliarySnapshot {
    return methods.read_auxiliary_files(command, { command: 'upmendex', args: [] });
  }

  test('compares bibliography declarations with the executed snapshot without changing captured auxiliary files', async () => {
    await withBuild(async directory => {
      const aux = path.join(directory, 'main.aux');
      const before = '\\citation{one}\n\\bibcite{one}{1}\n\\bibdata{old}\n\\bibstyle{plain}\n';
      await fs.writeFile(aux, before);
      await fs.writeFile(path.join(directory, 'main.idx'), Buffer.from([0x61, 0xff]));
      for (const name of ['old.bib', 'plain.bst', 'main.bbl']) {
        await fs.writeFile(path.join(directory, name), 'data');
        await fs.utimes(path.join(directory, name), 1000, name === 'main.bbl' ? 2000 : 1000);
      }
      const methods = bibliographyMethods(directory);
      const command = { command: 'upbibtex', args: [] };
      const start = bibliographySnapshot(methods, command);
      const originalLatex = [...start.latex.entries()];
      const originalIndex = Buffer.from(start.idx!);
      await fs.writeFile(aux, before.replace('{old}', '{new}'));
      await fs.writeFile(path.join(directory, 'main.idx'), 'changed index');
      const changed = bibliographySnapshot(methods, command);
      assert.notStrictEqual(changed, start);
      assert.deepStrictEqual([...start.latex.entries()], originalLatex);
      assert.deepStrictEqual(start.idx, originalIndex);
      assert.strictEqual(await methods.bib_check(command, start, undefined, start), false,
        'A captured snapshot must not reread the changed AUX');
      assert.strictEqual(await methods.bib_check(command, start, undefined, changed), true);
      assert.strictEqual(await methods.bib_check(command, start, undefined, changed), true,
        'Checking alone must not mark the declarations as processed');
      assert.strictEqual(await methods.bib_check(command, start, changed, changed), false);
      await fs.writeFile(aux, before);
      assert.strictEqual(await methods.bib_check(command, start, changed, bibliographySnapshot(methods, command)), true,
        'Returning to older declarations still changes the input since the previous execution');
      await fs.writeFile(aux, before.replace('{one}{1}', '{one}{2}') + '\\newlabel{label}{{1}{2}}\n');
      assert.strictEqual(await methods.bib_check(command, start, start, bibliographySnapshot(methods, command)), false,
        'Bibcite and labels are LaTeX output, not bibliography control input');
      await fs.writeFile(aux, before.replace('{plain}', '{another}'));
      assert.strictEqual(await methods.bib_check(command, start, start, bibliographySnapshot(methods, command)), true);
    });
  });

  test('checks BibTeX database and style freshness until execution using the configured program context', async () => {
    await withBuild(async directory => {
      await fs.writeFile(path.join(directory, 'main.aux'), '\\citation{one,two}\n\\bibcite{one}{1}\n\\bibcite{two}{2}\n\\bibdata{refs}\n\\bibstyle{plain}');
      for (const name of ['refs.bib', 'plain.bst', 'main.bbl']) {
        await fs.writeFile(path.join(directory, name), 'data');
        await fs.utimes(path.join(directory, name), 1000, name === 'main.bbl' ? 2000 : 1000);
      }
      const methods = bibliographyMethods(directory);
      const command = { command: 'upbibtex', args: [] };
      KpsewhichResolver.resolve = async (main, names, program) => {
        assert.strictEqual(program, 'upbibtex');
        assert.deepStrictEqual(names, ['refs.bib', 'plain.bst']);
        return names.map(name => vscode.Uri.file(path.join(directory, name)));
      };
      const start = bibliographySnapshot(methods, command);
      assert.strictEqual(await methods.bib_check(command, start, undefined, start), false);
      for (const name of ['refs.bib', 'plain.bst']) {
        await fs.utimes(path.join(directory, name), 3000, 3000);
        const current = bibliographySnapshot(methods, command);
        assert.strictEqual(await methods.bib_check(command, start, undefined, current), true,
          `${name}: an earlier negative check must not consume the freshness check`);
        assert.strictEqual(await methods.bib_check(command, start, undefined, current), true, name);
        assert.strictEqual(await methods.bib_check(command, start, current, current), false,
          `${name}: unchanged control runs only once after execution`);
        await fs.utimes(path.join(directory, name), 1000, 1000);
      }
      await fs.unlink(path.join(directory, 'main.bbl'));
      const missingOutput = bibliographySnapshot(methods, command);
      assert.strictEqual(await methods.bib_check(command, start, undefined, missingOutput), true);
      assert.strictEqual(await methods.bib_check(command, start, undefined, missingOutput), true);
      assert.strictEqual(await methods.bib_check(command, start, missingOutput, missingOutput), false,
        'A missing BBL must not cause repeated runs after execution');
    });
  });

  test('checks Biber datasource and configuration freshness until execution, then compares BCF content', async () => {
    await withBuild(async directory => {
      const control = path.join(directory, 'main.bcf');
      const text = '<bcf:controlfile xmlns:bcf="urn:test"><bcf:bibdata><bcf:datasource type="file" glob="false">refs&amp;data.bib</bcf:datasource></bcf:bibdata></bcf:controlfile>';
      await fs.writeFile(control, text);
      await fs.utimes(control, 1000, 1000);
      for (const name of ['refs&data.bib', 'biber.conf']) {
        await fs.writeFile(path.join(directory, name), 'data');
        await fs.utimes(path.join(directory, name), 1000, 1000);
      }
      await fs.writeFile(path.join(directory, 'main.bbl'), 'data');
      await fs.utimes(path.join(directory, 'main.bbl'), 2000, 2000);
      const methods = bibliographyMethods(directory);
      const command = { command: 'C:\\TeX Programs\\BIBER.EXE', args: ['--configfile', 'biber.conf'] };
      const start = bibliographySnapshot(methods, command);
      await fs.utimes(control, 3000, 3000);
      assert.strictEqual(await methods.bib_check(command, start, undefined, bibliographySnapshot(methods, command)), false,
        'Rewriting an identical BCF must not rerun Biber');
      for (const name of ['refs&data.bib', 'biber.conf']) {
        await fs.utimes(path.join(directory, name), 4000, 4000);
        const current = bibliographySnapshot(methods, command);
        assert.strictEqual(await methods.bib_check(command, start, undefined, current), true, name);
        assert.strictEqual(await methods.bib_check(command, start, undefined, current), true, name);
        assert.strictEqual(await methods.bib_check(command, start, current, current), false, name);
        await fs.utimes(path.join(directory, name), 1000, 1000);
      }
      await fs.writeFile(control, text.replace('glob="false"', 'glob="true"'));
      const glob = bibliographySnapshot(methods, command);
      assert.strictEqual(await methods.bib_check(command, start, undefined, glob), true);
      assert.strictEqual(await methods.bib_check(command, start, glob, glob), false,
        'Glob inputs must not cause repeated runs after execution');
    });
  });

  test('honors current logreq requests but ignores stale requests and orphaned BCF files', async () => {
    await withBuild(async directory => {
      const control = path.join(directory, 'main.bcf');
      const requests = path.join(directory, 'main.run.xml');
      await fs.writeFile(control, '<controlfile/>');
      const methods = bibliographyMethods(directory);
      const command = { command: 'biber', args: [] };
      const start = bibliographySnapshot(methods, command);
      assert.strictEqual(await methods.bib_check(command, start, undefined, start), false);
      await fs.writeFile(requests, '<requests><external active="1"><generic>biber</generic></external></requests>');
      const requested = bibliographySnapshot(methods, command);
      assert.strictEqual(await methods.bib_check(command, start, undefined, requested), true,
        'A late logreq request must be honored before the first execution');
      assert.strictEqual(await methods.bib_check(command, start, undefined, requested), true);
      assert.strictEqual(await methods.bib_check(command, start, requested, requested), false,
        'A persistent active request runs only once after execution');
      const staleBuild = bibliographyMethods(directory);
      const stale = bibliographySnapshot(staleBuild, command);
      assert.strictEqual(await staleBuild.bib_check(command, stale, undefined, stale), false);
    });
  });

  test('distinguishes an executed missing BCF from an unexecuted request', async () => {
    await withBuild(async directory => {
      const methods = bibliographyMethods(directory);
      const command = { command: 'biber', args: [] };
      const start = bibliographySnapshot(methods, command);
      assert.strictEqual(start.bcfText, null);
      assert.strictEqual(await methods.bib_check(command, start, undefined, start), false);
      await fs.writeFile(path.join(directory, 'main.run.xml'), '<requests><external active="1"><generic>biber</generic></external></requests>');
      const requested = bibliographySnapshot(methods, command);
      assert.strictEqual(await methods.bib_check(command, start, undefined, requested), true);
      assert.strictEqual(await methods.bib_check(command, start, requested, requested), false,
        'A snapshot with null BCF must not be confused with an unexecuted request');
      await fs.writeFile(path.join(directory, 'main.bcf'), '<controlfile/>');
      const current = bibliographySnapshot(methods, command);
      assert.strictEqual(await methods.bib_check(command, start, requested, current), true);
      assert.strictEqual(await methods.bib_check(command, start, current, current), false);
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
      const methods = bibliographyMethods(directory);
      const command = { command: 'upbibtex', args: [] };
      const start = bibliographySnapshot(methods, command);
      try { await assert.rejects(methods.bib_check(command, start, undefined, start, { token: cancellation.token }), vscode.CancellationError); }
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
      await fs.writeFile(path.join(directory, 'main.aux'), '\\newlabel{body}{{1}{1}}\n');
      const record = runProgram;
      let indexed = false;
      runProgram = async (command, args, cwd) => {
        if (command === 'engine') {
          await fs.writeFile(path.join(directory, 'main.idx'), `\\indexentry{word}{${indexed ? 2 : 1}}\n`);
          await fs.writeFile(path.join(directory, 'main.aux'), `\\newlabel{body}{{1}{${indexed ? 2 : 1}}}\n`);
          await fs.writeFile(path.join(directory, 'main.pdf'), 'PDF');
        } else if (command === 'index-helper') {
          await fs.copyFile(path.join(directory, 'main.idx'), path.join(directory, 'main.ind'));
          indexed = true;
        }
        return record(command, args, cwd);
      };
      assert.strictEqual((await buildIndex(directory)).severity, 'info');
      assert.deepStrictEqual(calls.map(call => call.command), ['engine', 'index-helper', 'engine', 'engine', 'index-helper', 'engine'],
        'An extra LaTeX pass must not hide IDX changes since the previous index execution');
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
