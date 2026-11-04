import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { openDocumentation } from '../documentation/DocumentationCommand';
import TexdocService, { TexdocEntry } from '../documentation/TexdocService';

interface DocumentationItem extends vscode.QuickPickItem {
  entry: TexdocEntry;
}

suite('Documentation command', () => {
  let originalInput: typeof vscode.window.showInputBox;
  let originalPicker: typeof vscode.window.showQuickPick;
  let originalProgress: typeof vscode.window.withProgress;
  let originalInformation: typeof vscode.window.showInformationMessage;
  let cancellation: vscode.CancellationTokenSource;
  let input: string | undefined;
  let inputOptions: vscode.InputBoxOptions | undefined;
  let selectedIndex: number | undefined;
  let pickerItems: readonly DocumentationItem[] | undefined;
  let entries: TexdocEntry[];
  let searches: string[];
  let opened: string[];
  let information: string[];
  let cancelSearch: boolean;
  let service: Pick<TexdocService, 'list' | 'open'>;

  setup(() => {
    originalInput = vscode.window.showInputBox;
    originalPicker = vscode.window.showQuickPick;
    originalProgress = vscode.window.withProgress;
    originalInformation = vscode.window.showInformationMessage;
    cancellation = new vscode.CancellationTokenSource();
    input = 'amsmath';
    inputOptions = undefined;
    selectedIndex = undefined;
    pickerItems = undefined;
    entries = [{
      query: 'amsmath',
      score: 10,
      filePath: path.resolve('test documents', 'amsmath-guide.pdf'),
      language: 'en',
      description: 'User guide'
    }, {
      query: 'amsmath',
      score: 8,
      filePath: path.resolve('test documents', 'amsmath-implementation.pdf'),
      description: 'Implementation'
    }];
    searches = [];
    opened = [];
    information = [];
    cancelSearch = false;
    service = {
      async list(query, token) {
        searches.push(query);
        assert.strictEqual(token, cancellation.token);
        if (cancelSearch) {
          cancellation.cancel();
        }
        return entries;
      },
      async open(filePath) {
        opened.push(filePath);
      }
    };
    vscode.window.showInputBox = async options => {
      inputOptions = options;
      return input;
    };
    vscode.window.showQuickPick = (async (items: readonly DocumentationItem[]) => {
      pickerItems = items;
      return selectedIndex === undefined ? undefined : items[selectedIndex];
    }) as unknown as typeof originalPicker;
    vscode.window.withProgress = async (_options, task) => task({ report() {} }, cancellation.token);
    vscode.window.showInformationMessage = (async (message: string) => {
      information.push(message);
      return undefined;
    }) as typeof originalInformation;
  });

  teardown(() => {
    vscode.window.showInputBox = originalInput;
    vscode.window.showQuickPick = originalPicker;
    vscode.window.withProgress = originalProgress;
    vscode.window.showInformationMessage = originalInformation;
    cancellation.dispose();
  });

  async function showSource(source: string, offset: number, selectionEnd = offset): Promise<void> {
    const document = await vscode.workspace.openTextDocument({ language: 'latex', content: source });
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(document.positionAt(offset), document.positionAt(selectionEnd));
  }

  test('canceling the name input does not search or open documentation', async () => {
    input = undefined;
    await openDocumentation(service);
    assert.deepStrictEqual(searches, []);
    assert.strictEqual(pickerItems, undefined);
    assert.deepStrictEqual(opened, []);
  });

  test('canceling the candidate picker does not open documentation', async () => {
    await openDocumentation(service);
    assert.deepStrictEqual(searches, ['amsmath']);
    assert.strictEqual(pickerItems?.length, 2);
    assert.deepStrictEqual(opened, []);
  });

  test('preserves relevance order and opens the explicitly selected full path', async () => {
    input = '  amsmath  ';
    selectedIndex = 1;
    await openDocumentation(service);
    assert.deepStrictEqual(searches, ['amsmath']);
    assert.deepStrictEqual(pickerItems?.map(item => item.entry), entries);
    assert.deepStrictEqual(pickerItems?.map(item => item.label), ['User guide', 'Implementation']);
    assert.ok(pickerItems?.[0].description?.includes('en'));
    assert.strictEqual(pickerItems?.[1].detail, entries[1].filePath);
    assert.deepStrictEqual(opened, [entries[1].filePath]);
  });

  test('shows the picker even when there is only one document', async () => {
    entries = [entries[0]];
    selectedIndex = 0;
    await openDocumentation(service);
    assert.strictEqual(pickerItems?.length, 1);
    assert.deepStrictEqual(opened, [entries[0].filePath]);
  });

  test('uses the file name when a result has no description', async () => {
    entries = [{ query: 'amsmath', score: 1, filePath: entries[0].filePath }];
    await openDocumentation(service);
    assert.strictEqual(pickerItems?.[0].label, path.basename(entries[0].filePath));
    assert.strictEqual(pickerItems?.[0].detail, entries[0].filePath);
  });

  test('reports no results without showing a picker', async () => {
    entries = [];
    await openDocumentation(service);
    assert.strictEqual(pickerItems, undefined);
    assert.deepStrictEqual(opened, []);
    assert.deepStrictEqual(information, ['No local documentation found for "amsmath".']);
  });

  test('does not show stale results after the progress operation is canceled', async () => {
    cancelSearch = true;
    await assert.rejects(openDocumentation(service), vscode.CancellationError);
    assert.strictEqual(pickerItems, undefined);
    assert.deepStrictEqual(opened, []);
    assert.deepStrictEqual(information, []);
  });

  test('prefills the selected text without leading or trailing whitespace', async () => {
    const source = '  mathtools  ';
    await showSource(source, 0, source.length);
    input = undefined;
    await openDocumentation(service);
    assert.strictEqual(inputOptions?.value, 'mathtools');
  });

  test('prefills the package at the cursor in a comma-separated package list', async () => {
    const source = '\\usepackage{amsmath,mathtools}';
    await showSource(source, source.indexOf('mathtools') + 3);
    input = undefined;
    await openDocumentation(service);
    assert.strictEqual(inputOptions?.value, 'mathtools');
  });

  test('does not prefill a multiline selection', async () => {
    const source = 'amsmath\nmathtools';
    await showSource(source, 0, source.length);
    input = undefined;
    await openDocumentation(service);
    assert.strictEqual(inputOptions?.value, '');
  });
});
