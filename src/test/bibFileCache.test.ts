import * as assert from 'assert';
import * as fs from 'fs/promises';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { runInThisContext } from 'vm';
import * as vscode from 'vscode';
import BibFileCache from '../completion/citation/BibFileCache';

function bibliography(key: string): string {
	return `@article{${key}, author={A. Author}, title={A {Title}}, year={2026}}`;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
	return { promise, resolve };
}

class TestWatcher implements vscode.FileSystemWatcher {
	readonly ignoreCreateEvents = false;
	readonly ignoreChangeEvents = false;
	readonly ignoreDeleteEvents = false;
	private readonly created = new vscode.EventEmitter<vscode.Uri>();
	private readonly changed = new vscode.EventEmitter<vscode.Uri>();
	private readonly deleted = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidCreate = this.created.event;
	readonly onDidChange = this.changed.event;
	readonly onDidDelete = this.deleted.event;
	disposed = false;

	constructor(readonly pattern: vscode.GlobPattern) {}
	create(uri: vscode.Uri): void { this.created.fire(uri); }
	change(uri: vscode.Uri): void { this.changed.fire(uri); }
	delete(uri: vscode.Uri): void { this.deleted.fire(uri); }
	dispose(): void {
		this.disposed = true;
		this.created.dispose();
		this.changed.dispose();
		this.deleted.dispose();
	}
}

async function withMockFiles(
	run: (Cache: typeof BibFileCache, watchers: TestWatcher[], reads: vscode.Uri[], setReader: (reader: (uri: vscode.Uri) => Promise<Uint8Array>) => void) => Promise<void>
): Promise<void> {
	const watchers: TestWatcher[] = [];
	const reads: vscode.Uri[] = [];
	let read = async (_uri: vscode.Uri): Promise<Uint8Array> => Buffer.from(bibliography('initial'));
	try {
		// VS Code freezes workspace.fs. Keep the cache and its shared source
		// reader on one private facade, leaving real watcher tests intact.
		const fakeVscode = {
			Uri: vscode.Uri,
			RelativePattern: vscode.RelativePattern,
			Disposable: vscode.Disposable,
			workspace: {
				get textDocuments() { return vscode.workspace.textDocuments; },
				createFileSystemWatcher: (pattern: vscode.GlobPattern) => {
					const watcher = new TestWatcher(pattern);
					watchers.push(watcher);
					return watcher;
				},
				fs: {
					readFile: async (uri: vscode.Uri) => {
						reads.push(uri);
						return read(uri);
					}
				}
			}
		};
		const filename = require.resolve('../completion/citation/BibFileCache');
		const filenames = [filename, require.resolve('../workspace'), require.resolve('../workspace/DocumentText'), require.resolve('../workspace/UriIdentity')];
		const sources = new Map(await Promise.all(filenames.map(async file => [file, await fs.readFile(file, 'utf8')] as const)));
		const modules = new Map<string, { exports: unknown }>();
		const loadModule = (file: string): unknown => {
			const existing = modules.get(file);
			if (existing) { return existing.exports; }
			const isolatedModule = { exports: {} };
			modules.set(file, isolatedModule);
			const localRequire = createRequire(file);
			const load = runInThisContext(`(function (exports, require, module, __filename, __dirname) {\n${sources.get(file)}\n})`, { filename: file });
			load(isolatedModule.exports, (id: string) => {
				if (id === 'vscode') { return fakeVscode; }
				const dependency = localRequire.resolve(id);
				return sources.has(dependency) ? loadModule(dependency) : localRequire(id);
			}, isolatedModule, file, path.dirname(file));
			return isolatedModule.exports;
		};
		const isolated = loadModule(filename) as { default: typeof BibFileCache };
		await run(isolated.default, watchers, reads, (reader) => { read = reader; });
	} finally {
		watchers.forEach((watcher) => watcher.dispose());
	}
}

function testUri(name = 'references.bib'): vscode.Uri {
	return vscode.Uri.file(path.join(os.tmpdir(), 'fortex-mocked-bibliography', name));
}

async function eventually(assertion: () => Promise<void>): Promise<void> {
	const deadline = Date.now() + 10000;
	for (;;) {
		try {
			await assertion();
			return;
		} catch (error) {
			if (Date.now() >= deadline) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
}

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fortex-bib-cache-'));
	try {
		await run(directory);
	} finally {
		assert.strictEqual(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
		assert.ok(path.basename(directory).startsWith('fortex-bib-cache-'));
		await fs.rm(directory, { recursive: true, force: true });
	}
}

suite('Bibliography file cache', () => {
	test('registers one nonrecursive watcher before reading and shares it across owners', async () => {
		await withMockFiles(async (Cache, watchers, reads) => {
			const cache = new Cache();
			const uri = testUri();
			try {
				cache.setReferences('first.tex', [uri, uri]);
				cache.setReferences('second.tex', [uri]);
				assert.strictEqual(watchers.length, 1);
				assert.strictEqual(reads.length, 0);
				assert.ok(watchers[0].pattern instanceof vscode.RelativePattern);
				assert.strictEqual(watchers[0].pattern.pattern, '*');
				assert.strictEqual(watchers[0].pattern.baseUri.toString(), vscode.Uri.joinPath(uri, '..').toString());
				const entries = await cache.read(uri);
				assert.deepStrictEqual(entries.map((entry) => entry.key), ['initial']);
				assert.strictEqual(entries[0].title, 'A Title');
				assert.strictEqual(entries[0].author, 'A. Author');
				assert.strictEqual(entries[0].year, '2026');
				cache.release('first.tex');
				assert.strictEqual(watchers[0].disposed, false);
				await cache.read(uri);
				assert.strictEqual(reads.length, 1);
				cache.release('second.tex');
				assert.strictEqual(watchers[0].disposed, true);
				cache.setReferences('third.tex', [uri]);
				await cache.read(uri);
				assert.strictEqual(watchers.length, 2);
				assert.strictEqual(reads.length, 2);
			} finally {
				cache.dispose();
			}
		});
	});

	test('replacing an owner bibliography list releases only unshared files', async () => {
		await withMockFiles(async (Cache, watchers) => {
			const cache = new Cache();
			const first = testUri('first.bib');
			const shared = testUri('shared.bib');
			try {
				cache.setReferences('first.tex', [first, shared]);
				cache.setReferences('second.tex', [shared]);
				cache.setReferences('first.tex', []);
				assert.strictEqual(watchers.filter((watcher) => watcher.disposed).length, 1);
				assert.strictEqual(watchers.filter((watcher) => !watcher.disposed).length, 1);
				cache.release('second.tex');
				assert.ok(watchers.every((watcher) => watcher.disposed));
			} finally {
				cache.dispose();
			}
		});
	});

	test('matches literal special characters and ignores notifications for neighboring files', async () => {
		await withMockFiles(async (Cache, watchers, reads, setReader) => {
			let changedReferences = 0;
			const cache = new Cache();
			const uri = testUri('references[1]{draft}.bib');
			try {
				cache.setReferences('main.tex', [uri]);
				await cache.read(uri);
				const neighbor = testUri('references1draft.bib');
				watchers[0].change(neighbor);
				watchers[0].create(neighbor);
				watchers[0].delete(neighbor);
				await cache.read(uri);
				assert.strictEqual(reads.length, 1);
				assert.strictEqual(changedReferences, 0);
				setReader(async () => Buffer.from(bibliography('updated')));
				watchers[0].change(uri);
				assert.deepStrictEqual((await cache.read(uri)).map((entry) => entry.key), ['updated']);
				assert.strictEqual(changedReferences, 0);
				watchers[0].delete(uri);
				watchers[0].create(uri);
				assert.deepStrictEqual((await cache.read(uri)).map(entry => entry.key), ['updated']);
			} finally {
				cache.dispose();
			}
		});
	});

	test('shares simultaneous reads and retries a result invalidated during the read', async () => {
		await withMockFiles(async (Cache, watchers, reads, setReader) => {
			const cache = new Cache();
			const uri = testUri();
			const firstRead = deferred<Uint8Array>();
			const started = deferred<void>();
			setReader(async () => {
				if (reads.length === 1) {
					started.resolve();
					return firstRead.promise;
				}
				return Buffer.from(bibliography('updated'));
			});
			try {
				cache.setReferences('main.tex', [uri]);
				const first = cache.read(uri);
				await started.promise;
				const second = cache.read(uri);
				assert.strictEqual(reads.length, 1);
				watchers[0].change(uri);
				firstRead.resolve(Buffer.from(bibliography('stale')));
				const results = await Promise.all([first, second]);
				assert.deepStrictEqual(results.map((entries) => entries.map((entry) => entry.key)), [['updated'], ['updated']]);
				await cache.read(uri);
				assert.strictEqual(reads.length, 2);
			} finally {
				firstRead.resolve(Buffer.from(bibliography('stale')));
				cache.dispose();
			}
		});
	});

	test('does not return an in-flight result after the final owner releases the file', async () => {
		await withMockFiles(async (Cache, watchers, _reads, setReader) => {
			const cache = new Cache();
			const uri = testUri();
			const pending = deferred<Uint8Array>();
			const started = deferred<void>();
			setReader(async () => { started.resolve(); return pending.promise; });
			try {
				cache.setReferences('main.tex', [uri]);
				const result = cache.read(uri);
				await started.promise;
				cache.release('main.tex');
				pending.resolve(Buffer.from(bibliography('stale')));
				assert.deepStrictEqual(await result, []);
				assert.strictEqual(watchers[0].disposed, true);
			} finally {
				pending.resolve(Buffer.from(''));
				cache.dispose();
			}
		});
	});

	test('does not repopulate or recreate watchers after disposal during a read', async () => {
		await withMockFiles(async (Cache, watchers, reads, setReader) => {
			const cache = new Cache();
			const uri = testUri();
			const pending = deferred<Uint8Array>();
			const started = deferred<void>();
			setReader(async () => { started.resolve(); return pending.promise; });
			try {
				cache.setReferences('main.tex', [uri]);
				const result = cache.read(uri);
				await started.promise;
				cache.dispose();
				pending.resolve(Buffer.from(bibliography('stale')));
				assert.deepStrictEqual(await result, []);
				cache.setReferences('new.tex', [uri]);
				assert.deepStrictEqual(await cache.read(uri), []);
				assert.strictEqual(watchers.length, 1);
				assert.strictEqual(watchers[0].disposed, true);
				assert.strictEqual(reads.length, 1);
			} finally {
				pending.resolve(Buffer.from(''));
				cache.dispose();
			}
		});
	});

	test('keeps non-file URI paths case-sensitive', async () => {
		await withMockFiles(async (Cache, watchers, reads) => {
			const cache = new Cache();
			const upper = vscode.Uri.parse('fortex-test:/external/References.bib');
			const lower = vscode.Uri.parse('fortex-test:/external/references.bib');
			try {
				cache.setReferences('main.tex', [upper, lower]);
				await Promise.all([cache.read(upper), cache.read(lower)]);
				assert.strictEqual(reads.length, 2);
				assert.strictEqual(watchers.length, 2);
				cache.invalidate(upper);
				await cache.read(lower);
				assert.strictEqual(reads.length, 2);
				await cache.read(upper);
				assert.strictEqual(reads.length, 3);
			} finally {
				cache.dispose();
			}
		});
	});

	test('normalizes Windows file paths for notifications and shared ownership', async function () {
		if (process.platform !== 'win32') {
			this.skip();
		}
		await withMockFiles(async (Cache, watchers, reads, setReader) => {
			const cache = new Cache();
			const upper = testUri('REFERENCES.BIB');
			const lower = upper.with({ path: upper.path.toLowerCase() });
			try {
				cache.setReferences('first.tex', [upper]);
				cache.setReferences('second.tex', [lower]);
				await cache.read(upper);
				await cache.read(lower);
				assert.strictEqual(watchers.length, 1);
				assert.strictEqual(reads.length, 1);
				setReader(async () => Buffer.from(bibliography('updated')));
				watchers[0].change(lower);
				assert.deepStrictEqual((await cache.read(upper)).map((entry) => entry.key), ['updated']);
				cache.release('first.tex');
				assert.strictEqual(watchers[0].disposed, false);
			} finally {
				cache.dispose();
			}
		});
	});

	test('refreshes a closed file outside the workspace after external writes, replacement, deletion and recreation', async function () {
		this.timeout(40000);
		await withTempDirectory(async (directory) => {
			const uri = vscode.Uri.file(path.join(directory, 'references[1]{draft}.bib'));
			assert.strictEqual(vscode.workspace.getWorkspaceFolder(uri), undefined);
			assert.ok(!vscode.workspace.textDocuments.some((document) => document.uri.toString() === uri.toString()));
			await fs.writeFile(uri.fsPath, bibliography('initial'));
			const cache = new BibFileCache();
			try {
				cache.setReferences('main.tex', [uri]);
				assert.deepStrictEqual((await cache.read(uri)).map((entry) => entry.key), ['initial']);
				// The public API has no registration-ready event; allow the extension
				// host to deliver its request to the filesystem watcher process.
				await new Promise((resolve) => setTimeout(resolve, 300));
				await fs.writeFile(uri.fsPath, bibliography('externallyUpdated'));
				await eventually(async () => assert.deepStrictEqual((await cache.read(uri)).map((entry) => entry.key), ['externallyUpdated']));
				const replacement = path.join(directory, 'replacement.tmp');
				await fs.writeFile(replacement, bibliography('replaced'));
				await fs.rename(replacement, uri.fsPath);
				await eventually(async () => assert.deepStrictEqual((await cache.read(uri)).map((entry) => entry.key), ['replaced']));
				await fs.unlink(uri.fsPath);
				await eventually(async () => assert.deepStrictEqual(await cache.read(uri), []));
				await fs.writeFile(uri.fsPath, bibliography('recreated'));
				await eventually(async () => assert.deepStrictEqual((await cache.read(uri)).map((entry) => entry.key), ['recreated']));
			} finally {
				cache.dispose();
			}
		});
	});

	test('uses unsaved document contents and detects document version changes', async function () {
		this.timeout(15000);
		await withTempDirectory(async (directory) => {
			const uri = vscode.Uri.file(path.join(directory, 'open.bib'));
			await fs.writeFile(uri.fsPath, bibliography('disk'));
			const cache = new BibFileCache();
			const document = await vscode.workspace.openTextDocument(uri);
			try {
				cache.setReferences('main.tex', [uri]);
				assert.deepStrictEqual((await cache.read(uri)).map((entry) => entry.key), ['disk']);
				const edit = new vscode.WorkspaceEdit();
				edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), bibliography('unsaved'));
				assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
				assert.strictEqual(document.isDirty, true);
				assert.deepStrictEqual((await cache.read(uri)).map((entry) => entry.key), ['unsaved']);
				assert.strictEqual(await fs.readFile(uri.fsPath, 'utf8'), bibliography('disk'));
			} finally {
				cache.dispose();
				await document.save();
			}
		});
	});
});
