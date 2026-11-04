import * as assert from 'assert';
import * as vscode from 'vscode';
import GreekCompletionController from '../completion/greek/GreekCompletionController';

async function withEvent<T>(event: vscode.Event<T>, matches: (value: T) => boolean, action: () => void | Thenable<unknown>): Promise<void> {
  let subscription: vscode.Disposable | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const changed = new Promise<void>((resolve, reject) => {
    subscription = event((value) => {
      if (matches(value)) {
        resolve();
      }
    });
    timer = setTimeout(() => reject(new Error('Expected VS Code event did not arrive')), 3000);
  });
  try {
    await action();
    await changed;
  } finally {
    subscription?.dispose();
    clearTimeout(timer);
  }
}

async function openEditor(content = '', offset = content.length, language = 'latex'): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument({ content, language });
  const editor = await vscode.window.showTextDocument(document);
  const position = document.positionAt(offset);
  editor.selection = new vscode.Selection(position, position);
  return editor;
}

async function moveCursor(editor: vscode.TextEditor, offset: number): Promise<void> {
  const position = editor.document.positionAt(offset);
  await withEvent(vscode.window.onDidChangeTextEditorSelection,
    (event) => event.textEditor === editor && event.selections.length === 1 && event.selections[0].active.isEqual(position),
    () => { editor.selection = new vscode.Selection(position, position); });
}

suite('Greek completion preview sessions', function () {
  this.timeout(10000);
  let controller: GreekCompletionController;
  let previousSetting: boolean | undefined;
  let configurationTarget: vscode.ConfigurationTarget;

  setup(async () => {
    configurationTarget = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    const config = vscode.workspace.getConfiguration('vscode-fortex');
    const inspected = config.inspect<boolean>('mathShortcuts.enabled');
    previousSetting = configurationTarget === vscode.ConfigurationTarget.Workspace
      ? inspected?.workspaceValue : inspected?.globalValue;
    await config.update('mathShortcuts.enabled', false, configurationTarget);
    controller = new GreekCompletionController();
  });

  teardown(async () => {
    controller?.dispose();
    await vscode.workspace.getConfiguration('vscode-fortex').update('mathShortcuts.enabled', previousSetting, configurationTarget);
  });

  test('keeps p/ph/ph- outside the document and inserts one undoable command', async () => {
    const editor = await openEditor('$  $', 2);
    const document = editor.document;
    const initialVersion = document.version;
    await controller.start();
    for (const text of ['p', 'h', '-']) {
      await controller.input({ text });
      assert.strictEqual(document.getText(), '$  $');
      assert.strictEqual(document.version, initialVersion, 'A preview must not create document edits');
      assert.strictEqual(editor.selection.active.character, 2);
    }
    await controller.commit();
    assert.strictEqual(document.getText(), '$ \\varphi $');
    assert.strictEqual(editor.selection.active.character, 9);
    await withEvent(vscode.workspace.onDidChangeTextDocument,
      (event) => event.document === document && event.contentChanges.length > 0,
      () => vscode.commands.executeCommand('undo'));
    assert.strictEqual(document.getText(), '$  $');
  });

  test('backs up the abbreviation and cancels without editing text or selection', async () => {
    const editor = await openEditor('$  $', 2);
    const initialVersion = editor.document.version;
    const initialSelection = editor.selection;
    await controller.start();
    for (const text of ['p', 'h', '-']) {
      await controller.input({ text });
    }
    await controller.backspace();
    await controller.backspace();
    await controller.input({ text: 's' });
    controller.cancel();
    await controller.commit();
    assert.strictEqual(editor.document.getText(), '$  $');
    assert.strictEqual(editor.document.version, initialVersion);
    assert.deepStrictEqual(editor.selection, initialSelection);

    await controller.start();
    await controller.input({ text: 'p' });
    await controller.input({ text: 'h' });
    await controller.backspace();
    await controller.commit();
    assert.strictEqual(editor.document.getText(), '$ \\pi $');
  });

  test('backspace at the empty abbreviation cancels without deleting preceding text', async () => {
    const editor = await openEditor('before');
    const initialVersion = editor.document.version;
    await controller.start();
    await controller.input({ text: 'a' });
    await controller.backspace();
    await controller.backspace();
    await controller.commit();
    assert.strictEqual(editor.document.getText(), 'before');
    assert.strictEqual(editor.document.version, initialVersion);
  });

  test('accepts uppercase abbreviations while preserving unsupported first letters', async () => {
    for (const [code, expected] of [['Th', '\\Theta'], ['Ph', '\\Phi'], ['A', 'A'], ['q', 'q']]) {
      const editor = await openEditor();
      await controller.start();
      for (const text of code) {
        await controller.input({ text });
      }
      await controller.commit();
      assert.strictEqual(editor.document.getText(), expected, code);
    }
  });

  test('commits unmatched suffixes and separates following Latin letters', async () => {
    for (const [suffix, expected] of [['x', '\\alpha x'], ['+', '\\alpha+'], ['1', '\\alpha1']]) {
      const editor = await openEditor();
      await controller.start();
      await controller.input({ text: 'a' });
      await controller.input({ text: suffix });
      await controller.commit();
      assert.strictEqual(editor.document.getText(), expected);
    }
    const editor = await openEditor('xyz', 0);
    await controller.start();
    await controller.input({ text: 'a' });
    await controller.commit();
    assert.strictEqual(editor.document.getText(), '\\alpha xyz');
    assert.strictEqual(editor.selection.active.character, '\\alpha '.length);
  });

  test('space commits the command and inserts a single space', async () => {
    const editor = await openEditor();
    await controller.start();
    await controller.input({ text: 'p' });
    await controller.commit({ text: ' ' });
    assert.strictEqual(editor.document.getText(), '\\pi ');
  });

  test('does not replay a queued abbreviation after explicit cancellation', async () => {
    const editor = await openEditor();
    await controller.start();
    const pendingInput = controller.input({ text: 'p' });
    controller.cancel();
    await pendingInput;
    await controller.commit();
    assert.strictEqual(editor.document.getText(), '');
  });

  test('preserves queued ordinary characters and space after an automatic commit', async () => {
    const editor = await openEditor();
    await controller.start();
    await controller.input({ text: 'a' });
    await Promise.all([
      controller.input({ text: 'x' }),
      controller.commit({ text: ' ' }),
      controller.input({ text: 'y' })
    ]);
    assert.strictEqual(editor.document.getText(), '\\alpha x y');
  });

  test('replays queued backspace and enter as normal edits after a commit', async () => {
    const editor = await openEditor();
    await controller.start();
    await controller.input({ text: 'a' });
    await Promise.all([controller.input({ text: '2' }), controller.backspace()]);
    assert.strictEqual(editor.document.getText(), '\\alpha');

    const next = await openEditor();
    await controller.start();
    await controller.input({ text: 'a' });
    await Promise.all([controller.input({ text: '2' }), controller.commit()]);
    assert.strictEqual(next.document.getText().replace(/\r\n/g, '\n'), '\\alpha2\n');
  });

  test('registers the start, input, and commit commands on extension activation', async () => {
    const editor = await openEditor();
    await vscode.commands.executeCommand('vscode-fortex.greekCompletion.start');
    for (const text of ['p', 'h', '-']) {
      await vscode.commands.executeCommand('vscode-fortex.greekCompletion.input', { text });
    }
    assert.strictEqual(editor.document.getText(), '');
    await vscode.commands.executeCommand('vscode-fortex.greekCompletion.commit');
    assert.strictEqual(editor.document.getText(), '\\varphi');
  });

  test('changing the math alphabet setting does not interrupt Greek input', async () => {
    const editor = await openEditor();
    const config = vscode.workspace.getConfiguration('vscode-fortex');
    await controller.start();
    await controller.input({ text: 'p' });
    await withEvent(vscode.workspace.onDidChangeConfiguration,
      (event) => event.affectsConfiguration('vscode-fortex.mathShortcuts.enabled'),
      () => config.update('mathShortcuts.enabled', true, configurationTarget));
    await controller.input({ text: 'h' });
    await withEvent(vscode.workspace.onDidChangeConfiguration,
      (event) => event.affectsConfiguration('vscode-fortex.mathShortcuts.enabled'),
      () => config.update('mathShortcuts.enabled', false, configurationTarget));
    await controller.input({ text: '-' });
    assert.strictEqual(editor.document.getText(), '');
    await controller.commit();
    assert.strictEqual(editor.document.getText(), '\\varphi');
  });

  test('moving the cursor cancels the session even if the cursor returns', async () => {
    const editor = await openEditor('  ', 0);
    await controller.start();
    await controller.input({ text: 'a' });
    await moveCursor(editor, 1);
    await moveCursor(editor, 0);
    await controller.commit();
    assert.strictEqual(editor.document.getText(), '  ');
  });

  test('a document edit cancels the preview without interfering with the edit', async () => {
    const editor = await openEditor('  ', 0);
    await controller.start();
    await controller.input({ text: 'p' });
    await withEvent(vscode.workspace.onDidChangeTextDocument,
      (event) => event.document === editor.document && event.contentChanges.length > 0,
      () => editor.edit((edit) => edit.insert(new vscode.Position(0, 2), 'x')));
    await controller.commit();
    assert.strictEqual(editor.document.getText(), '  x');
  });

  test('rejects multiple cursors, selected text, and non-LaTeX documents', async () => {
    const editor = await openEditor('ab', 0);
    editor.selections = [new vscode.Selection(0, 0, 0, 0), new vscode.Selection(0, 2, 0, 2)];
    await controller.start();
    await vscode.commands.executeCommand('type', { text: 'a' });
    await controller.commit();
    assert.strictEqual(editor.document.getText(), 'aaba', 'Keys after a rejected start must use ordinary typing');
    assert.strictEqual(editor.selections.length, 2);

    const selected = await openEditor('ab', 0);
    selected.selection = new vscode.Selection(0, 0, 0, 2);
    await controller.start();
    await vscode.commands.executeCommand('type', { text: 'a' });
    await controller.commit();
    assert.strictEqual(selected.document.getText(), 'a');

    const plain = await openEditor('plain', 0, 'plaintext');
    await controller.start();
    await vscode.commands.executeCommand('type', { text: 'a' });
    await controller.commit();
    assert.strictEqual(plain.document.getText(), 'aplain');
  });
});
