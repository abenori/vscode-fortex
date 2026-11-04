import * as assert from 'assert';
import * as vscode from 'vscode';
import { insertOrRenameEnvironment } from '../completion/environment/EnvironmentCommand';
import EnvironmentRenameProvider from '../completion/environment/EnvironmentRenameProvider';

interface EnvironmentItem extends vscode.QuickPickItem {
	name: string;
}

class TestQuickPick {
	items: readonly EnvironmentItem[] = [];
	activeItems: readonly EnvironmentItem[] = [];
	selectedItems: readonly EnvironmentItem[] = [];
	value = '';
	private readonly changed = new vscode.EventEmitter<string>();
	private readonly accepted = new vscode.EventEmitter<void>();
	private readonly hidden = new vscode.EventEmitter<void>();
	readonly onDidChangeValue = this.changed.event;
	readonly onDidAccept = this.accepted.event;
	readonly onDidHide = this.hidden.event;

	constructor(private readonly interact: (picker: TestQuickPick) => void) {}
	show(): void { this.interact(this); }
	hide(): void { this.hidden.fire(); }
	input(value: string): void { this.value = value; this.changed.fire(value); }
	accept(name?: string): void {
		if (name !== undefined) {
			const item = this.items.find((candidate) => candidate.name === name);
			assert.ok(item, `Expected a candidate for ${name}`);
			this.selectedItems = [item];
		}
		this.accepted.fire();
	}
	dispose(): void {
		this.changed.dispose();
		this.accepted.dispose();
		this.hidden.dispose();
	}
}

async function runEnvironmentCommand(source: string, offset: number, interact: (picker: TestQuickPick) => void): Promise<string> {
	const document = await vscode.workspace.openTextDocument({ language: 'latex', content: source });
	const editor = await vscode.window.showTextDocument(document);
	const position = document.positionAt(offset);
	editor.selection = new vscode.Selection(position, position);
	const original = vscode.window.createQuickPick;
	const picker = new TestQuickPick(interact);
	vscode.window.createQuickPick = (() => picker) as unknown as typeof original;
	try {
		await insertOrRenameEnvironment();
		return document.getText();
	} finally {
		vscode.window.createQuickPick = original;
		picker.dispose();
	}
}

suite('Environment editing', () => {
	test('converts only the matching nested pair with [ from either end', async () => {
		const source = '\\begin{equation}\n\\begin{equation}\nx\n\\end{equation}\n\\end{equation}';
		const expected = '\\begin{equation}\n\\[\nx\n\\]\n\\end{equation}';
		for (const offset of [source.indexOf('\\begin', 1) + 8, source.indexOf('\\end') + 6]) {
			const document = await vscode.workspace.openTextDocument({ language: 'latex', content: source });
			const edit = new EnvironmentRenameProvider().provideRenameEdits(document, document.positionAt(offset), '[');
			assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
			assert.strictEqual(document.getText(), expected);
		}
	});

	test('converts display math back to a named environment and retains old aliases', async () => {
		const provider = new EnvironmentRenameProvider();
		const source = '\\[\nx + y\n\\]';
		const document = await vscode.workspace.openTextDocument({ language: 'latex', content: source });
		const position = document.positionAt(source.lastIndexOf('\\]') + 1);
		const prepared = provider.prepareRename(document, position);
		assert.ok(prepared && 'placeholder' in prepared);
		assert.strictEqual(prepared.placeholder, '[');
		assert.strictEqual(await vscode.workspace.applyEdit(provider.provideRenameEdits(document, position, 'align*')), true);
		assert.strictEqual(document.getText(), '\\begin{align*}\nx + y\n\\end{align*}');
		for (const alias of ['\\[', '\\]']) {
			const named = await vscode.workspace.openTextDocument({ language: 'latex', content: '\\begin{equation}\nx\n\\end{equation}' });
			assert.strictEqual(await vscode.workspace.applyEdit(provider.provideRenameEdits(named, new vscode.Position(0, 8), alias)), true);
			assert.strictEqual(named.getText(), '\\[\nx\n\\]');
		}
	});

	test('offers standard and local candidates with a blank query and completes a prefix', async () => {
		const source = '\\newenvironment{localproof}{}{}\n\\begin{equation}\nx\n\\end{equation}';
		const result = await runEnvironmentCommand(source, source.indexOf('\\end') + 6, (picker) => {
			assert.strictEqual(picker.value, '');
			assert.ok(picker.items.some((item) => item.name === 'itemize'));
			assert.ok(picker.items.some((item) => item.name === 'localproof'));
			assert.ok(picker.items.some((item) => item.name === '\\['));
			picker.input('ite');
			assert.strictEqual(picker.activeItems[0]?.name, 'itemize');
			picker.accept();
		});
		assert.strictEqual(result, source.replaceAll('{equation}', '{itemize}'));
	});

	test('accepts a newly entered environment name from the candidates', async () => {
		const source = '\\begin{equation}\nx\n\\end{equation}';
		const result = await runEnvironmentCommand(source, 8, (picker) => {
			picker.input('customproof');
			picker.accept('customproof');
		});
		assert.strictEqual(result, source.replaceAll('{equation}', '{customproof}'));
	});

	test('accepts [ for display math and leaves the document unchanged on cancellation', async () => {
		const source = '\\begin{equation}\nx\n\\end{equation}';
		const result = await runEnvironmentCommand(source, 8, (picker) => {
			picker.input('[');
			assert.strictEqual(picker.items.length, 1);
			picker.accept('\\[');
		});
		assert.strictEqual(result, '\\[\nx\n\\]');
		assert.strictEqual(await runEnvironmentCommand(source, 8, (picker) => picker.hide()), source);
	});
});
