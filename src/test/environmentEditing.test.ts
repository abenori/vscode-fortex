import * as assert from 'assert';
import * as vscode from 'vscode';
import { insertOrRenameEnvironment } from '../completion/environment/EnvironmentCommand';
import { closeEnvironment } from '../completion/environment/EnvironmentCloseCommand';
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

async function wrapEnvironment(source: string, startOffset: number, endOffset: number, name = 'quote', reversed = false): Promise<string> {
	const document = await vscode.workspace.openTextDocument({ language: 'latex', content: source });
	const editor = await vscode.window.showTextDocument(document);
	await editor.edit(edit => edit.setEndOfLine(source.includes('\r\n') ? vscode.EndOfLine.CRLF : vscode.EndOfLine.LF));
	const start = document.positionAt(startOffset);
	const end = document.positionAt(endOffset);
	editor.selection = reversed ? new vscode.Selection(end, start) : new vscode.Selection(start, end);
	const original = vscode.window.showQuickPick;
	vscode.window.showQuickPick = (async (items: readonly EnvironmentItem[]) => {
		const item = items.find(candidate => candidate.name === name);
		assert.ok(item, `Expected a candidate for ${name}`);
		return item;
	}) as unknown as typeof original;
	try {
		await insertOrRenameEnvironment();
		return document.getText();
	} finally {
		vscode.window.showQuickPick = original;
	}
}

async function closeEnvironmentAt(source: string, offset: number): Promise<vscode.TextEditor> {
	const document = await vscode.workspace.openTextDocument({ language: 'latex', content: source });
	const editor = await vscode.window.showTextDocument(document);
	await editor.edit(edit => edit.setEndOfLine(source.includes('\r\n') ? vscode.EndOfLine.CRLF : vscode.EndOfLine.LF));
	const position = document.positionAt(offset);
	editor.selection = new vscode.Selection(position, position);
	await closeEnvironment();
	return editor;
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

	for (const [eolName, eol] of [['LF', '\n'], ['CRLF', '\r\n']]) {
		for (const name of ['quote', '\\[']) {
			test(`closes ${name} inline at the cursor with surrounding text (${eolName})`, async () => {
				const opening = name === '\\[' ? '\\[' : '\\begin{quote}';
				const closing = name === '\\[' ? '\\]' : '\\end{quote}';
				const prefix = `  ${opening}${eol}`;
				for (const [before, after] of [['', 'abcdef'], ['abc', 'def'], ['abcdef', ''], ['  ', 'abc \t'], ['abc ', ' \t'], ['abc😀', 'def']]) {
					const source = `${prefix}${before}${after}${eol}next`;
					const offset = prefix.length + before.length;
					const editor = await closeEnvironmentAt(source, offset);
					assert.strictEqual(editor.document.getText(), `${prefix}${before}${closing}${after}${eol}next`);
					assert.ok(editor.selection.isEmpty);
					assert.strictEqual(editor.document.offsetAt(editor.selection.active), offset + closing.length);
				}
				const source = `  ${opening}abcdef${eol}next`;
				const offset = `  ${opening}abc`.length;
				const editor = await closeEnvironmentAt(source, offset);
				assert.strictEqual(editor.document.getText(), `  ${opening}abc${closing}def${eol}next`);
				assert.strictEqual(editor.document.offsetAt(editor.selection.active), offset + closing.length);
			});

			test(`aligns ${name}'s closing command with its opening on a blank line (${eolName})`, async () => {
				const opening = name === '\\[' ? '\\[' : '\\begin{quote}';
				const closing = name === '\\[' ? '\\]' : '\\end{quote}';
				const prefix = `  ${opening}${eol}`;
				for (const whitespace of ['', ' \t  ']) {
					const source = `${prefix}${whitespace}${eol}next`;
					const editor = await closeEnvironmentAt(source, prefix.length + Math.floor(whitespace.length / 2));
					assert.strictEqual(editor.document.getText(), `${prefix}  ${closing}${eol}next`);
					assert.ok(editor.selection.isEmpty);
					assert.strictEqual(editor.document.offsetAt(editor.selection.active), prefix.length + 2 + closing.length);
				}
			});

			test(`wraps ${name} inline with text before, after, or on both sides (${eolName})`, async () => {
				const opening = name === '\\[' ? '\\[' : '\\begin{quote}';
				const closing = name === '\\[' ? '\\]' : '\\end{quote}';
				const cases = [
					{ before: 'abc', body: 'def', after: '' },
					{ before: '', body: 'abc', after: 'def' },
					{ before: 'abc', body: 'def', after: 'ghi' },
					{ before: '  abc ', body: 'def', after: ' \t' },
					{ before: '\t ', body: 'def', after: ' ghi' },
					{ before: 'abc', body: '\\alpha + ${value} + $0', after: 'ghi' }
				];
				for (const { before, body, after } of cases) {
					const source = `${before}${body}${after}${eol}next`;
					for (const reversed of [false, true]) {
						const result = await wrapEnvironment(source, before.length, before.length + body.length, name, reversed);
						assert.strictEqual(result, `${before}${opening}${body}${closing}${after}${eol}next`);
					}
				}
			});

			test(`preserves selected ${eolName} line breaks and indentation inside inline ${name}`, async () => {
				const opening = name === '\\[' ? '\\[' : '\\begin{quote}';
				const closing = name === '\\[' ? '\\]' : '\\end{quote}';
				const body = `alpha${eol}\t beta${eol}    gamma`;
				for (const [before, after] of [['  before ', ''], ['  ', ' after'], ['before ', ' after']]) {
					const source = `${before}${body}${after}${eol}next`;
					for (const reversed of [false, true]) {
						const result = await wrapEnvironment(source, before.length, before.length + body.length, name, reversed);
						assert.strictEqual(result, `${before}${opening}${body}${closing}${after}${eol}next`);
					}
				}
			});

			test(`keeps the final ${eolName} after inline ${name} whether selected or not`, async () => {
				const before = 'before ';
				const body = `alpha${eol}  beta`;
				const source = `${before}${body}${eol}next`;
				const opening = name === '\\[' ? '\\[' : '\\begin{quote}';
				const closing = name === '\\[' ? '\\]' : '\\end{quote}';
				for (const includeEol of [false, true]) {
					for (const reversed of [false, true]) {
						const result = await wrapEnvironment(source, before.length, before.length + body.length + (includeEol ? eol.length : 0), name, reversed);
						assert.strictEqual(result, `${before}${opening}${body}${closing}${eol}next`);
					}
				}
			});

			test(`wraps ${name} identically with or without the selected final ${eolName}`, async () => {
				const body = `alpha${eol}beta`;
				const source = `${body}${eol}next`;
				const opening = name === '\\[' ? '\\[' : '\\begin{quote}';
				const closing = name === '\\[' ? '\\]' : '\\end{quote}';
				const expected = `${opening}${eol}${body}${eol}${closing}${eol}next`;
				let firstResult: string | undefined;
				for (const includeEol of [false, true]) {
					for (const reversed of [false, true]) {
						const result = await wrapEnvironment(source, 0, body.length + (includeEol ? eol.length : 0), name, reversed);
						// 字下げ幅の設定に依存せず，空行も含めて改行の配置を検証する．
						assert.strictEqual(result.replace(/^[\t ]+/gm, ''), expected);
						firstResult ??= result;
						assert.strictEqual(result, firstResult);
					}
				}
			});
		}

		test(`closes the innermost unclosed environment inline (${eolName})`, async () => {
			const source = `\\begin{center}${eol}\\begin{quote}${eol}abcdef`;
			const offset = source.length - 3;
			const editor = await closeEnvironmentAt(source, offset);
			assert.strictEqual(editor.document.getText(), source.slice(0, offset) + '\\end{quote}' + source.slice(offset));
		});

		test(`keeps an environment with an existing matching closing command unchanged (${eolName})`, async () => {
			const source = `\\begin{quote}${eol}abcdef${eol}\\end{quote}`;
			const offset = source.indexOf('abcdef') + 3;
			const editor = await closeEnvironmentAt(source, offset);
			assert.strictEqual(editor.document.getText(), source);
			assert.strictEqual(editor.document.offsetAt(editor.selection.active), offset);
		});

		test(`uses block wrapping when only whitespace surrounds the selection (${eolName})`, async () => {
			const source = `  alpha \t${eol}next`;
			const result = await wrapEnvironment(source, 2, 7);
			assert.strictEqual(result.replace(/^[\t ]+/gm, ''), `\\begin{quote}${eol}alpha${eol}\\end{quote} \t${eol}next`);
		});

		test(`retains intentional blank lines when moving the final ${eolName} after the environment`, async () => {
			const selected = `alpha${eol}${eol}beta${eol}${eol}`;
			const result = await wrapEnvironment(`${selected}next`, 0, selected.length);
			assert.strictEqual(result.replace(/^[\t ]+/gm, ''), `\\begin{quote}${eol}alpha${eol}${eol}beta${eol}${eol}\\end{quote}${eol}next`);
		});

		test(`preserves the final ${eolName} at the end of the document`, async () => {
			const body = `alpha${eol}beta`;
			for (const finalEol of ['', eol]) {
				const source = body + finalEol;
				for (const endOffset of new Set([body.length, source.length])) {
					const result = await wrapEnvironment(source, 0, endOffset);
					assert.strictEqual(result.replace(/^[\t ]+/gm, ''), `\\begin{quote}${eol}${body}${eol}\\end{quote}${finalEol}`);
				}
			}
		});

		test(`preserves surrounding indentation with either selection ending in ${eolName}`, async () => {
			const body = `alpha${eol}  beta`;
			const source = `  ${body}${eol}  next`;
			const withoutEol = await wrapEnvironment(source, 2, 2 + body.length);
			const withEol = await wrapEnvironment(source, 2, 2 + body.length + eol.length);
			assert.strictEqual(withEol, withoutEol);
			assert.ok(withEol.startsWith('  \\begin{quote}'));
			assert.ok(withEol.endsWith(`${eol}  \\end{quote}${eol}  next`));
		});
	}
});
