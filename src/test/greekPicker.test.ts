import * as assert from 'assert';
import * as vscode from 'vscode';
import GreekCompletionController from '../completion/greek/GreekCompletionController';
import { GreekEntry } from '../completion/greek/GreekCatalog';

interface GreekPickerItem extends vscode.QuickPickItem {
  entry: GreekEntry;
}

class TestGreekPicker {
  items: readonly GreekPickerItem[] = [];
  activeItems: readonly GreekPickerItem[] = [];
  selectedItems: readonly GreekPickerItem[] = [];
  value = '';
  shown = false;
  disposed = false;
  private readonly changed = new vscode.EventEmitter<string>();
  private readonly accepted = new vscode.EventEmitter<void>();
  private readonly hidden = new vscode.EventEmitter<void>();
  readonly onDidChangeValue = this.changed.event;
  readonly onDidAccept = this.accepted.event;
  readonly onDidHide = this.hidden.event;

  show(): void { this.shown = true; }
  hide(): void { this.hidden.fire(); }
  input(value: string): void { this.value = value; this.changed.fire(value); }
  accept(code?: string): void {
    if (code !== undefined) {
      const selected = this.items.find((item) => item.entry.code === code);
      assert.ok(selected, `Expected a candidate for ${code}`);
      this.selectedItems = [selected];
    }
    this.accepted.fire();
  }
  dispose(): void {
    this.disposed = true;
    this.changed.dispose();
    this.accepted.dispose();
    this.hidden.dispose();
  }
}

async function waitForText(document: vscode.TextDocument, expected: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (document.getText() !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.strictEqual(document.getText(), expected);
}

suite('Greek completion candidate picker', function () {
  this.timeout(10000);
  let controller: GreekCompletionController;
  let picker: TestGreekPicker;
  let originalCreateQuickPick: typeof vscode.window.createQuickPick;
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
    picker = new TestGreekPicker();
    originalCreateQuickPick = vscode.window.createQuickPick;
    vscode.window.createQuickPick = (() => picker) as unknown as typeof originalCreateQuickPick;
  });

  teardown(async () => {
    vscode.window.createQuickPick = originalCreateQuickPick;
    controller?.dispose();
    picker?.dispose();
    await vscode.workspace.getConfiguration('vscode-fortex').update('mathShortcuts.enabled', previousSetting, configurationTarget);
  });

  async function openSession(code = ''): Promise<vscode.TextDocument> {
    const document = await vscode.workspace.openTextDocument({ language: 'latex', content: '$  $' });
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(0, 2, 0, 2);
    await controller.start();
    for (const text of code) {
      await controller.input({ text });
    }
    await controller.showCandidates();
    assert.strictEqual(picker.shown, true);
    return document;
  }

  test('filters ph to phi and varphi and inserts the explicitly selected variant', async () => {
    const document = await openSession('ph');
    assert.strictEqual(picker.value, 'ph');
    assert.deepStrictEqual(picker.items.map((item) => [item.description, item.label]), [
      ['ph', '\\phi'], ['ph-', '\\varphi']
    ]);
    assert.strictEqual(picker.activeItems[0]?.entry.code, 'ph');
    assert.strictEqual(document.getText(), '$  $');
    picker.accept('ph-');
    await waitForText(document, '$ \\varphi $');
    assert.strictEqual(picker.disposed, true);
  });

  test('offers all abbreviations at the start and filters picker input case-sensitively', async () => {
    const document = await openSession();
    assert.strictEqual(picker.value, '');
    assert.strictEqual(picker.items.length, 44);
    assert.strictEqual(new Set(picker.items.map((item) => item.entry.command)).size, 40);
    picker.input('TH');
    assert.strictEqual(picker.items.length, 0);
    assert.strictEqual(picker.activeItems.length, 0);
    picker.input('Th');
    assert.deepStrictEqual(picker.items.map((item) => item.label), ['\\Theta']);
    assert.strictEqual(document.getText(), '$  $');
    picker.accept();
    await waitForText(document, '$ \\Theta $');
  });

  test('closing the picker cancels the preview without a document edit', async () => {
    const document = await openSession('ph');
    const initialVersion = document.version;
    picker.input('ph-');
    assert.strictEqual(picker.activeItems[0]?.entry.command, '\\varphi');
    picker.hide();
    assert.strictEqual(picker.disposed, true);
    await controller.commit();
    assert.strictEqual(document.getText(), '$  $');
    assert.strictEqual(document.version, initialVersion);
  });
});
