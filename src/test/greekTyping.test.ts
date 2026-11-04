import * as assert from 'assert';
import * as vscode from 'vscode';
import GreekCompletionController from '../completion/greek/GreekCompletionController';

async function openEditor(content = '', offset = content.length): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument({ language: 'latex', content });
  const editor = await vscode.window.showTextDocument(document);
  const position = document.positionAt(offset);
  editor.selection = new vscode.Selection(position, position);
  return editor;
}

async function type(text: string): Promise<void> {
  await vscode.commands.executeCommand('type', { text });
}

async function waitForText(document: vscode.TextDocument, expected: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (document.getText() !== expected && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.strictEqual(document.getText(), expected);
}

suite('Greek completion through ordinary typing', function () {
  this.timeout(15000);
  let controller: GreekCompletionController;
  let controllerDisposed: boolean;
  let configurationTarget: vscode.ConfigurationTarget;
  let editorConfiguration: vscode.WorkspaceConfiguration;
  const previousSettings = new Map<string, unknown>();
  const languageConfigurations: vscode.Disposable[] = [];

  async function configure(key: string, value: unknown): Promise<void> {
    if (!previousSettings.has(key)) {
      const inspected = editorConfiguration.inspect(key);
      previousSettings.set(key, configurationTarget === vscode.ConfigurationTarget.Workspace
        ? inspected?.workspaceLanguageValue : inspected?.globalLanguageValue);
    }
    await editorConfiguration.update(key, value, configurationTarget, true);
  }

  setup(async () => {
    configurationTarget = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    editorConfiguration = vscode.workspace.getConfiguration('editor', { languageId: 'latex' });
    await configure('autoClosingBrackets', 'never');
    await configure('autoClosingQuotes', 'never');
    controller = new GreekCompletionController();
    controllerDisposed = false;
  });

  teardown(async () => {
    if (!controllerDisposed) {
      controller?.dispose();
    }
    for (const disposable of languageConfigurations.splice(0)) {
      disposable.dispose();
    }
    for (const [key, value] of previousSettings) {
      await editorConfiguration.update(key, value, configurationTarget, true);
    }
    previousSettings.clear();
  });

  test('commits gamma before every directly typed ASCII symbol and digit', async () => {
    const symbols = Array.from({ length: 94 }, (_, index) => String.fromCharCode(index + 33))
      .filter(character => !/[a-zA-Z]/.test(character));
    for (const symbol of symbols) {
      const editor = await openEditor();
      await controller.start();
      await type('g');
      assert.strictEqual(editor.document.getText(), '', 'The abbreviation must remain a preview');
      await type(symbol);
      assert.strictEqual(editor.document.getText(), `\\gamma${symbol}`, `Terminating character ${JSON.stringify(symbol)}`);
      assert.strictEqual(editor.selection.active.character, `\\gamma${symbol}`.length);
    }
  });

  test('keeps valid continuations as previews and separates a following Latin letter', async () => {
    const editor = await openEditor();
    const version = editor.document.version;
    await controller.start();
    for (const text of ['p', 'h', '-']) {
      await type(text);
      assert.strictEqual(editor.document.getText(), '');
      assert.strictEqual(editor.document.version, version);
    }
    await type('^');
    assert.strictEqual(editor.document.getText(), '\\varphi^');

    const next = await openEditor();
    await controller.start();
    await type('g');
    await type('x');
    assert.strictEqual(next.document.getText(), '\\gamma x');
  });

  test('uses the actual uppercase character delivered by the keyboard', async () => {
    const editor = await openEditor();
    await controller.start();
    await type('G');
    assert.strictEqual(editor.document.getText(), '');
    await type('_');
    assert.strictEqual(editor.document.getText(), '\\Gamma_');
  });

  test('inserts only the ordinary character when no candidate is displayed', async () => {
    for (const text of ['^', '_', '+', 'q']) {
      const editor = await openEditor();
      await controller.start();
      await type(text);
      assert.strictEqual(editor.document.getText(), text);
      await type('g');
      assert.strictEqual(editor.document.getText(), `${text}g`, 'Input mode should have ended');
    }
  });

  test('undoes and redoes the candidate and terminating character together', async () => {
    const editor = await openEditor();
    await type('before ');
    await controller.start();
    await type('g');
    await type('^');
    assert.strictEqual(editor.document.getText(), 'before \\gamma^');
    await vscode.commands.executeCommand('undo');
    await waitForText(editor.document, 'before ');
    await vscode.commands.executeCommand('redo');
    await waitForText(editor.document, 'before \\gamma^');
  });

  test('preserves queued ordinary typing after a terminating character', async () => {
    for (const suffix of ['^', '(']) {
      const editor = await openEditor();
      await controller.start();
      await type('g');
      await Promise.all([type(suffix), type('2'), type('x')]);
      assert.strictEqual(editor.document.getText(), `\\gamma${suffix}2x`);
    }
  });

  test('respects bracket auto-closing and keeps the native caret inside the pair', async () => {
    languageConfigurations.push(vscode.languages.setLanguageConfiguration('latex', {
      brackets: [['(', ')'], ['[', ']'], ['{', '}']],
      autoClosingPairs: [
        { open: '(', close: ')' }, { open: '[', close: ']' }, { open: '{', close: '}' }
      ]
    }));
    for (const setting of ['always', 'never']) {
      await configure('autoClosingBrackets', setting);
      for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
        const editor = await openEditor('before ');
        await controller.start();
        await type('g');
        await type(open);
        const expected = `before \\gamma${open}${setting === 'always' ? close : ''}`;
        assert.strictEqual(editor.document.getText(), expected, `${setting}: ${open}`);
        assert.strictEqual(editor.selection.active.character, `before \\gamma${open}`.length);
        await vscode.commands.executeCommand('undo');
        await waitForText(editor.document, 'before ');
        await vscode.commands.executeCommand('redo');
        await waitForText(editor.document, expected);
      }
    }
  });

  test('commits before an existing auto-closed bracket without inserting a second closer', async () => {
    languageConfigurations.push(vscode.languages.setLanguageConfiguration('latex', {
      brackets: [['(', ')'], ['[', ']'], ['{', '}']],
      autoClosingPairs: [
        { open: '(', close: ')' }, { open: '[', close: ']' }, { open: '{', close: '}' }
      ]
    }));
    await configure('autoClosingBrackets', 'always');
    await configure('autoClosingOvertype', 'auto');
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      const editor = await openEditor();
      await type(open);
      assert.strictEqual(editor.document.getText(), `${open}${close}`);
      assert.strictEqual(editor.selection.active.character, 1);
      await controller.start();
      await type('g');
      await type(close);
      const expected = `${open}\\gamma${close}`;
      assert.strictEqual(editor.document.getText(), expected);
      assert.strictEqual(editor.selection.active.character, expected.length);
      await vscode.commands.executeCommand('undo');
      await waitForText(editor.document, `${open}${close}`);
      assert.strictEqual(editor.selection.active.character, 1, 'Undo should restore the caret inside the original pair');
    }
  });

  test('keeps auto-closing overtype available after committing with an opening bracket', async () => {
    languageConfigurations.push(vscode.languages.setLanguageConfiguration('latex', {
      brackets: [['(', ')'], ['[', ']'], ['{', '}']],
      autoClosingPairs: [
        { open: '(', close: ')' }, { open: '[', close: ']' }, { open: '{', close: '}' }
      ]
    }));
    await configure('autoClosingBrackets', 'always');
    await configure('autoClosingOvertype', 'auto');
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      const editor = await openEditor();
      await controller.start();
      await type('g');
      await type(open);
      const expected = `\\gamma${open}${close}`;
      assert.strictEqual(editor.document.getText(), expected);
      assert.strictEqual(editor.selection.active.character, expected.length - 1);
      await type(close);
      assert.strictEqual(editor.document.getText(), expected);
      assert.strictEqual(editor.selection.active.character, expected.length);
    }
  });

  test('leaves another typing handler intact when starting Greek input is unavailable', async () => {
    const editor = await openEditor();
    const originalShowWarningMessage = vscode.window.showWarningMessage;
    const warnings: string[] = [];
    const intercepted: string[] = [];
    let otherHandler: vscode.Disposable | undefined;
    vscode.window.showWarningMessage = ((message: string) => {
      warnings.push(message);
      return Promise.resolve(undefined);
    }) as typeof originalShowWarningMessage;
    try {
      otherHandler = vscode.commands.registerCommand('type', (args: { text: string }) => {
        intercepted.push(args.text);
        return vscode.commands.executeCommand('default:type', args);
      });
      await controller.start();
      await type('g');
      assert.strictEqual(warnings.length, 1);
      assert.deepStrictEqual(intercepted, ['g']);
      assert.strictEqual(editor.document.getText(), 'g');
      await controller.commit();
      assert.strictEqual(editor.document.getText(), 'g');
      otherHandler.dispose();
      otherHandler = undefined;
      await controller.start();
      await type('g');
      await type('^');
      assert.strictEqual(editor.document.getText(), 'g\\gamma^');
      assert.deepStrictEqual(intercepted, ['g']);
    } finally {
      otherHandler?.dispose();
      vscode.window.showWarningMessage = originalShowWarningMessage;
    }
  });

  test('cancels on composition start and lets IME input proceed normally', async () => {
    const editor = await openEditor();
    await controller.start();
    await type('g');
    await vscode.commands.executeCommand('compositionStart');
    try {
      await type('a');
    } finally {
      await vscode.commands.executeCommand('compositionEnd');
    }
    await controller.commit();
    assert.strictEqual(editor.document.getText(), 'a');
  });

  test('does not convert non-ASCII text into a Greek completion', async () => {
    const editor = await openEditor();
    await controller.start();
    await type('g');
    await type('あ');
    await controller.commit();
    assert.strictEqual(editor.document.getText(), 'あ');
  });

  test('cancels for a paste rather than committing the displayed candidate', async () => {
    const editor = await openEditor();
    await controller.start();
    await type('g');
    await vscode.commands.executeCommand('paste', { text: '^', pasteOnNewLine: false });
    await waitForText(editor.document, '^');
    await controller.commit();
    assert.strictEqual(editor.document.getText(), '^');
  });

  test('restores ordinary typing after repeated starts, cancellation, and disposal', async () => {
    const editor = await openEditor();
    for (let count = 0; count < 3; count++) {
      await controller.start();
      await type('g');
      controller.cancel();
      await type('x');
      assert.strictEqual(editor.document.getText(), 'x'.repeat(count + 1));
    }
    await controller.start();
    await type('g');
    controller.dispose();
    controllerDisposed = true;
    await type('x');
    assert.strictEqual(editor.document.getText(), 'xxxx');
  });
});
