import * as assert from 'assert';

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { parseBibTeX } from '../completion/citation/BibTeXParser';
import { CitationEntry } from '../completion/citation/Citation';
import { findCitationContext, latexToPlainText, searchCitations } from '../completion/citation/CitationSearch';
import LaTeXProject from '../project/LaTeXProject';
import CitationService from '../completion/citation/CitationService';
import { ReferenceParser } from '../latex-parser';
import {
	DEFAULT_ALLOWED_PROGRAMS,
	assertProgramAllowed,
	findCommandSeparator,
	isProgramAllowed,
	parseCommandLine,
	singleProgramFromDirective
} from '../compile/BuildSecurity';

suite('Extension Test Suite', () => {
	test('parses nested BibTeX fields and string concatenation', () => {
		const entries = parseBibTeX(`
@string{publisher = "Example Press"}
% @book{ignored, author = {Nobody}, title = {Comment}}
@book{knuth1984,
  author = {Donald E. Knuth},
  title = {The {T}eXbook, a practical guide},
  publisher = publisher # " Japan",
  year = 1984
}`);

		assert.strictEqual(entries.length, 1);
		assert.strictEqual(entries[0].key, 'knuth1984');
		assert.strictEqual(entries[0].fields.title, 'The {T}eXbook, a practical guide');
		assert.strictEqual(entries[0].fields.publisher, 'Example Press Japan');
		assert.strictEqual(entries[0].fields.year, '1984');
	});

	test('searches author and title as one field-independent index', () => {
		const sourceUri = vscode.Uri.file('/tmp/references.bib');
		const entries: CitationEntry[] = [{
			key: 'knuth1984',
			type: 'book',
			author: 'Donald E. Knuth',
			title: 'The TeXbook',
			year: '1984',
			sourceUri
		}, {
			key: 'lamport1994',
			type: 'book',
			author: 'Leslie Lamport',
			title: 'LaTeX: A Document Preparation System',
			year: '1994',
			sourceUri
		}];

		assert.deepStrictEqual(searchCitations(entries, 'knuth tex').map((entry) => entry.key), ['knuth1984']);
		assert.deepStrictEqual(searchCitations(entries, 'lamport document').map((entry) => entry.key), ['lamport1994']);
		assert.deepStrictEqual(searchCitations(entries, 'knuth1984'), []);
	});

	test('finds the current citation fragment after a comma', () => {
		const source = '\\cite[see]{existing, knuth tex';
		const context = findCitationContext(source);
		assert.ok(context);
		assert.strictEqual(context.query, 'knuth tex');
		assert.strictEqual(source.slice(context.queryStart), 'knuth tex');
		assert.strictEqual(findCitationContext('% \\cite{ignored'), undefined);
	});

	test('finds the main file and aggregates a nested source bibliography from the main directory', async () => {
		const root = vscode.Uri.file(path.join(os.tmpdir(), `vscode-fortex-citation-${process.pid}-${Date.now()}`));
		const main = vscode.Uri.joinPath(root, 'main.tex');
		const first = vscode.Uri.joinPath(root, 'chapters', 'first.tex');
		const current = vscode.Uri.joinPath(root, 'chapters', 'nested', 'current.tex');
		const magic = vscode.Uri.joinPath(root, 'magic.tex');
		const bibliography = vscode.Uri.joinPath(root, 'references.bib');
		const write = (uri: vscode.Uri, source: string) => vscode.workspace.fs.writeFile(uri, Buffer.from(source, 'utf8'));

		try {
			await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, 'chapters', 'nested'));
			await write(main, '\\documentclass{article}\n\\input{chapters/first}\n');
			await write(first, '\\include{chapters/nested/current}\n');
			await write(current, '\\bibliography{references}\nCitation: \\cite{}\n');
			await write(magic, '%#main main.tex\n');
			await write(bibliography, '@book{nested-entry, author={Project Author}, title={Root Bibliography}}\n');
			await write(vscode.Uri.joinPath(current, '..', 'references.bib'),
				'@book{wrong-directory-entry, title={Must not be used}}\n');

			const guessed = await LaTeXProject.resolveMainFile(current);
			assert.strictEqual(path.normalize(guessed.fsPath), path.normalize(main.fsPath));
			const fromMagic = await LaTeXProject.resolveMainFile(magic);
			assert.strictEqual(path.normalize(fromMagic.fsPath), path.normalize(main.fsPath));

			const project = await LaTeXProject.create(main);
			const files = project.filelist.filter(entry => entry.exists).map(entry => entry.uri);
			assert.deepStrictEqual(files.map((uri) => path.normalize(uri.fsPath)), [main, first, current].map((uri) => path.normalize(uri.fsPath)));

			const document = await vscode.workspace.openTextDocument(current);
			const citations = new CitationService();
			try {
				const entries = await citations.entriesFor(document);
				assert.deepStrictEqual(entries.map((entry) => entry.key), ['nested-entry']);
			} finally {
				citations.dispose();
			}
		} finally {
			await vscode.workspace.fs.delete(root, { recursive: true, useTrash: false });
		}
	});

	test('finds label declarations in document structure while ignoring comments', () => {
		const source = `\\section{Introduction}
\\label{sec:introduction}
This section explains the document.

% \\label{sec:ignored}
\\begin{equation}
  E = mc^2 \\label{eq:energy}
\\end{equation}`;
		const labels = new ReferenceParser(source).tokens.filter(token => token.kind === 'label');

		assert.deepStrictEqual(labels.map((label) => label.key), ['sec:introduction', 'eq:energy']);
		assert.strictEqual(source.slice(labels[0].commandStart, labels[0].commandEnd), '\\label{sec:introduction}');
		assert.strictEqual(source.slice(labels[1].commandStart, labels[1].commandEnd), '\\label{eq:energy}');
	});

	test('does not mistake LaTeX commands for accent commands', () => {
		assert.strictEqual(latexToPlainText('\\begin{proposition}'), 'proposition');
		assert.strictEqual(latexToPlainText('\\v{C}ech and \\"O'), 'Cech and O');
	});

	test('parses percent-sharp command lines without shell interpretation', () => {
		assert.deepStrictEqual(
			parseCommandLine('pdflatex "document with spaces.tex" --jobname=output | ignored'),
			{
				executable: 'pdflatex',
				args: ['document with spaces.tex', '--jobname=output', '|', 'ignored']
			}
		);
		assert.deepStrictEqual(
			parseCommandLine('"C:\\TeX Programs\\latex.exe" "C:\\Documents\\main.tex"'),
			{
				executable: 'C:\\TeX Programs\\latex.exe',
				args: ['C:\\Documents\\main.tex']
			}
		);
		assert.strictEqual(findCommandSeparator('pdflatex "name;part.tex"; bibtex main'), 24);
		assert.strictEqual(singleProgramFromDirective('  pdflatex  '), 'pdflatex');
		assert.strictEqual(singleProgramFromDirective('pdflatex main.tex'), undefined);
		assert.throws(() => parseCommandLine('pdflatex "unclosed'));
	});

	test('allows only configured percent-sharp programs unless wildcarded', () => {
		assert.deepStrictEqual([...DEFAULT_ALLOWED_PROGRAMS], [
			'tex', 'pdftex', 'luatex', 'xetex', 'ptex', 'uptex',
			'latex', 'pdflatex', 'lualatex', 'xelatex', 'platex', 'uplatex',
			'dvipdfmx', 'dvipsk', 'bibtex', 'upbibtex', 'biber',
			'mendex', 'makeindex', 'upmendex'
		]);
		assert.strictEqual(isProgramAllowed('pdflatex', DEFAULT_ALLOWED_PROGRAMS), true);
		assert.strictEqual(isProgramAllowed('powershell', DEFAULT_ALLOWED_PROGRAMS), false);
		assert.strictEqual(isProgramAllowed('anything', ['*']), true);
		assert.throws(
			() => assertProgramAllowed('powershell', DEFAULT_ALLOWED_PROGRAMS, '%#!'),
			/not allowed/
		);
	});
});
