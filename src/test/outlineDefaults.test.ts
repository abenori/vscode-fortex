import * as assert from 'assert';
import * as vscode from 'vscode';

suite('LaTeX Outline defaults', () => {
  test('starts collapsed and allows a language-specific user override', async () => {
    const scope = { languageId: 'latex' };
    const config = vscode.workspace.getConfiguration('outline', scope);
    const original = config.inspect<string>('collapseItems');
    assert.ok(original);
    assert.strictEqual(original.defaultLanguageValue, 'alwaysCollapse');
    try {
      await config.update('collapseItems', 'alwaysExpand', vscode.ConfigurationTarget.Global, true);
      assert.strictEqual(vscode.workspace.getConfiguration('outline', scope).get('collapseItems'), 'alwaysExpand');
    } finally {
      await config.update('collapseItems', original.globalLanguageValue, vscode.ConfigurationTarget.Global, true);
    }
  });
});
