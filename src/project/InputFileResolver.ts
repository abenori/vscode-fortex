import * as path from 'path';
import * as vscode from 'vscode';
import LaTeXSource from '../latex-parser/LaTeXSource';
import { readInputFilename } from '../latex-parser/InputFilename';
import type { InputToken, MacroLookup } from '../latex-parser/InputFilename';

export { readInputFilename } from '../latex-parser/InputFilename';
export type { FilenameResult, InputToken } from '../latex-parser/InputFilename';

interface InputResultBase {
  readonly consumedEnd: number;
  readonly checkedCandidates: readonly { readonly uri: vscode.Uri; readonly exists: boolean }[];
}

export type InputResolution = InputResultBase & (
  | { readonly status: 'resolved'; readonly filename: string; readonly uri: vscode.Uri }
  | { readonly status: 'missing'; readonly filename: string }
  | { readonly status: 'unresolved'; readonly reason: string }
);

const knownExtensions = new Set(['.tex', '.sty', '.cls', '.fd', '.aux', '.bbl', '.def', '.clo', '.ldf']);

/** Resolves one direct input/include against the compilation directory. */
export async function resolveInputFile(
  source: LaTeXSource,
  command: InputToken,
  compilationDirectory: vscode.Uri,
  macros?: MacroLookup
): Promise<InputResolution> {
  const read = readInputFilename(source, command, macros);
  const checkedCandidates: { uri: vscode.Uri; exists: boolean }[] = [];
  if (read.status === 'unresolved') { return { ...read, checkedCandidates }; }
  const { filename, consumedEnd } = read;
  const names = command.name === 'include'
    ? [filename.replace(/\.tex$/, '') + '.tex']
    : knownExtensions.has(path.posix.extname(filename).toLowerCase())
      ? [filename]
      : [filename + '.tex', filename];
  for (const name of names) {
    const uri = compilationDirectory.scheme === 'file'
      ? vscode.Uri.file(path.resolve(compilationDirectory.fsPath, name))
      : vscode.Uri.joinPath(compilationDirectory, name);
    let exists = false;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      exists = (stat.type & vscode.FileType.File) !== 0;
    } catch (error) {
      if ((error as { code?: string }).code !== 'FileNotFound') { throw error; }
    }
    checkedCandidates.push({ uri, exists });
    if (exists) { return { status: 'resolved', filename, uri, consumedEnd, checkedCandidates }; }
  }
  return { status: 'missing', filename, consumedEnd, checkedCandidates };
}
