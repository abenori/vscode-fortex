import * as assert from 'assert';
import * as vscode from 'vscode';
import Config from '../Config';
import LaTeXProject from '../project/LaTeXProject';
import LabelCompletionProvider from '../completion/reference/LabelCompletionProvider';
import CommandCompletionProvider from '../completion/command/CommandCompletionProvider';
import EnvironmentCompletionProvider from '../completion/environment/EnvironmentCompletionProvider';
import type { CompletionKind } from '../completion/CompletionSources';
import CompletionSession from '../completion/CompletionSession';

const uncancelled: vscode.CancellationToken = {
  isCancellationRequested: false, onCancellationRequested: () => new vscode.Disposable(() => undefined)
};

async function replace(document: vscode.TextDocument, source: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), source);
  assert.ok(await vscode.workspace.applyEdit(edit));
}

function snapshot(main: vscode.TextDocument, child: vscode.TextDocument): LaTeXProject {
  return {
    mainfile: main.uri,
    filelist: [
      { uri: main.uri, type: LaTeXProject.LaTeXFileType.main, exists: true },
      { uri: child.uri, type: LaTeXProject.LaTeXFileType.input, exists: true }
    ]
  } as unknown as LaTeXProject;
}

suite('Per-kind completion scopes', () => {
  test('falls back to each current unsaved document when project discovery is unavailable', async () => {
    const originalScope = Config.completionScope;
    const originalCreate = LaTeXProject.create;
    Config.completionScope = () => 'project';
    LaTeXProject.create = async () => { throw new Error('No on-disk main is available for this untitled buffer'); };
    const local = '\\label{scratch}\n\\newcommand{\\scratchcommand}{}\n\\newenvironment{scratchenvironment}{}{}\n';
    const labels = new LabelCompletionProvider();
    const commands = new CommandCompletionProvider();
    const environments = new EnvironmentCompletionProvider();
    try {
      const labelDocument = await vscode.workspace.openTextDocument({ language: 'latex', content: `${local}\\ref{` });
      assert.ok(labelDocument.isUntitled);
      const labelEnd = labelDocument.getText().length;
      const labelItems = await labels.complete(labelDocument, labelDocument.positionAt(labelEnd), { query: '', queryStart: labelEnd }, uncancelled);
      assert.deepStrictEqual(labelItems?.items.map(item => item.insertText), ['scratch']);
      const commandDocument = await vscode.workspace.openTextDocument({ language: 'latex', content: `${local}\\` });
      const commandEnd = commandDocument.getText().length;
      const commandItems = await commands.complete(commandDocument, commandDocument.positionAt(commandEnd), { query: '', start: commandEnd - 1 }, uncancelled);
      assert.ok(commandItems?.items.some(item => item.label === '\\scratchcommand'));
      const environmentDocument = await vscode.workspace.openTextDocument({ language: 'latex', content: `${local}\\begin{` });
      const environmentEnd = environmentDocument.getText().length;
      const environmentItems = await environments.complete(environmentDocument, environmentDocument.positionAt(environmentEnd), {
        style: 'named', query: '', queryStart: environmentEnd, replaceEnd: environmentEnd
      }, uncancelled);
      assert.ok(environmentItems?.items.some(item => item.label === 'scratchenvironment'));
    } finally {
      labels.dispose(); commands.dispose(); environments.dispose();
      Config.completionScope = originalScope;
      LaTeXProject.create = originalCreate;
    }
  });

  test('uses document scope independently and project scope reads nonactive unsaved sources', async () => {
    const originalScope = Config.completionScope;
    const originalCreate = LaTeXProject.create;
    const scopes: Record<CompletionKind, 'document' | 'project'> = { label: 'document', command: 'document', environment: 'document' };
    Config.completionScope = kind => scopes[kind];
    const main = await vscode.workspace.openTextDocument({ language: 'latex', content: '\\documentclass{article}\n\\usepackage{not-loaded}\n\\input{child}' });
    const child = await vscode.workspace.openTextDocument({ language: 'latex', content: '\\label{old}\n\\newcommand{\\oldcommand}{}' });
    const local = '\\label{local}\n\\newcommand{\\localcommand}{}\n\\newenvironment{localenvironment}{}{}\n';
    const labelDocument = await vscode.workspace.openTextDocument({ language: 'latex', content: `${local}\\ref{` });
    const commandDocument = await vscode.workspace.openTextDocument({ language: 'latex', content: `${local}\\` });
    const environmentDocument = await vscode.workspace.openTextDocument({ language: 'latex', content: `${local}\\begin{` });
    const labels = new LabelCompletionProvider();
    const commands = new CommandCompletionProvider();
    const environments = new EnvironmentCompletionProvider();
    let discoveries = 0;
    LaTeXProject.create = async () => { discoveries++; return snapshot(main, child); };
    const labelItems = async () => {
      const end = labelDocument.getText().length;
      return (await labels.complete(labelDocument, labelDocument.positionAt(end), { query: '', queryStart: end }, uncancelled))?.items.map(item => String(item.insertText)) ?? [];
    };
    const commandItems = async () => {
      const end = commandDocument.getText().length;
      return (await commands.complete(commandDocument, commandDocument.positionAt(end), { query: '', start: end - 1 }, uncancelled))?.items.map(item => String(item.label)) ?? [];
    };
    const environmentItems = async () => {
      const end = environmentDocument.getText().length;
      return (await environments.complete(environmentDocument, environmentDocument.positionAt(end), {
        style: 'named', query: '', queryStart: end, replaceEnd: end
      }, uncancelled))?.items.map(item => String(item.label)) ?? [];
    };
    try {
      assert.deepStrictEqual(await labelItems(), ['local']);
      assert.ok(!(await commandItems()).includes('\\projectcommand'));
      assert.ok(!(await environmentItems()).includes('projectenvironment'));
      assert.strictEqual(discoveries, 0, 'Document scopes must not discover a project');
      await replace(child, '\\label{project}\n\\newcommand{\\projectcommand}[2]{}\n\\newenvironment{projectenvironment}{}{}');
      assert.ok(child.isDirty);

      scopes.label = 'project';
      assert.deepStrictEqual(await labelItems(), ['local', 'project']);
      assert.ok(!(await commandItems()).includes('\\projectcommand'));
      assert.ok(!(await environmentItems()).includes('projectenvironment'));
      assert.strictEqual(discoveries, 1);

      scopes.command = 'project';
      assert.ok((await commandItems()).includes('\\projectcommand'));
      assert.strictEqual(discoveries, 2);
      scopes.environment = 'project';
      assert.ok((await environmentItems()).includes('projectenvironment'));
      assert.strictEqual(discoveries, 3);

      // A nonactive source edit invalidates project candidates without collecting.
      await replace(child, '\\label{newproject}\n\\newcommand{\\newprojectcommand}{}\n\\newenvironment{newprojectenvironment}{}{}');
      assert.strictEqual(discoveries, 3);
      assert.deepStrictEqual(await labelItems(), ['local', 'newproject']);
      assert.ok((await commandItems()).includes('\\newprojectcommand'));
      assert.ok((await environmentItems()).includes('newprojectenvironment'));
      assert.strictEqual(discoveries, 6);
    } finally {
      labels.dispose(); commands.dispose(); environments.dispose();
      Config.completionScope = originalScope;
      LaTeXProject.create = originalCreate;
    }
  });

  test('cancels pending project discovery without retaining its result for a later context', async () => {
    const originalScope = Config.completionScope;
    const originalCreate = LaTeXProject.create;
    Config.completionScope = () => 'project';
    const document = await vscode.workspace.openTextDocument({ language: 'latex', content: '\\label{local}\n\\ref{' });
    const child = await vscode.workspace.openTextDocument({ language: 'latex', content: '\\label{project}' });
    let release!: (project: LaTeXProject) => void;
    let started!: () => void;
    const start = new Promise<void>(resolve => { started = resolve; });
    LaTeXProject.create = () => { started(); return new Promise(resolve => { release = resolve; }); };
    const cancellation = new vscode.CancellationTokenSource();
    const provider = new LabelCompletionProvider();
    try {
      const end = document.getText().length;
      const pending = provider.complete(document, document.positionAt(end), { query: '', queryStart: end }, cancellation.token);
      await start;
      cancellation.cancel();
      assert.strictEqual(await pending, undefined);
      release(snapshot(document, child));
      LaTeXProject.create = async () => snapshot(document, child);
      const next = await provider.complete(document, document.positionAt(end), { query: '', queryStart: end }, uncancelled);
      assert.deepStrictEqual(next?.items.map(item => item.insertText), ['local', 'project']);
    } finally {
      provider.dispose(); cancellation.dispose();
      Config.completionScope = originalScope;
      LaTeXProject.create = originalCreate;
    }
  });

  test('one cancelled waiter does not cancel another request for the same input context', async () => {
    const document = await vscode.workspace.openTextDocument({ language: 'latex', content: '\\ref{' });
    const end = document.getText().length;
    const query = { start: end, end, scope: 'document' };
    const session = new CompletionSession<string[]>();
    const cancelled = new vscode.CancellationTokenSource();
    let release!: (value: string[]) => void;
    const data = new Promise<string[]>(resolve => { release = resolve; });
    let loads = 0;
    try {
      const first = session.get(document, query, cancelled.token, () => { loads++; return data; });
      const second = session.get(document, query, uncancelled, () => { loads++; return data; });
      cancelled.cancel();
      assert.strictEqual(await first, undefined);
      release(['shared']);
      assert.deepStrictEqual(await second, ['shared']);
      assert.strictEqual(loads, 1);
    } finally { session.dispose(); cancelled.dispose(); }
  });

  test('keeps one project snapshot when query typing cancels the earlier pending request', async () => {
    const originalScope = Config.completionScope;
    const originalCreate = LaTeXProject.create;
    Config.completionScope = () => 'project';
    const source = '\\label{local}\n\\ref{';
    const document = await vscode.workspace.openTextDocument({ language: 'latex', content: source });
    const child = await vscode.workspace.openTextDocument({ language: 'latex', content: '\\label{project}' });
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const start = new Promise<void>(resolve => { started = resolve; });
    let discoveries = 0;
    LaTeXProject.create = async (_file, options) => {
      discoveries++;
      assert.ok(options?.readSource, 'Completion discovery must own a source snapshot');
      assert.strictEqual(await options.readSource(document.uri), source);
      started();
      await gate;
      assert.strictEqual(await options.readSource(document.uri), source, 'Query typing must not replace or reread the snapshot');
      return snapshot(document, child);
    };
    const cancelled = new vscode.CancellationTokenSource();
    const provider = new LabelCompletionProvider();
    try {
      const end = source.length;
      const first = provider.complete(document, document.positionAt(end), { query: '', queryStart: end }, cancelled.token);
      await start;
      const edit = new vscode.WorkspaceEdit();
      edit.insert(document.uri, document.positionAt(end), 'p');
      assert.ok(await vscode.workspace.applyEdit(edit));
      // VS Code may cancel before it invokes the provider for the new fragment.
      cancelled.cancel();
      assert.strictEqual(await first, undefined);
      const second = provider.complete(document, document.positionAt(end + 1), { query: 'p', queryStart: end }, uncancelled);
      release();
      assert.deepStrictEqual((await second)?.items.map(item => item.insertText), ['project']);
      assert.strictEqual(discoveries, 1);
    } finally {
      release(); provider.dispose(); cancelled.dispose();
      Config.completionScope = originalScope;
      LaTeXProject.create = originalCreate;
    }
  });
});
