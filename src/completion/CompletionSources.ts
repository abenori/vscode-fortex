import * as vscode from 'vscode';
import Config from '../Config';
import LaTeXProject from '../project/LaTeXProject';
import * as Workspace from '../workspace';

export type CompletionKind = 'label' | 'command' | 'environment';
export interface CompletionSource { uri: vscode.Uri; source: string }

/** A fresh request reads current buffers and never retains project/source state. */
export async function completionSources(
  document: vscode.TextDocument,
  kind: CompletionKind,
  token: vscode.CancellationToken,
  watch: (uris: readonly vscode.Uri[], directories?: readonly vscode.Uri[]) => void = () => undefined
): Promise<CompletionSource[]> {
  if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
  if (Config.completionScope(kind, document.uri) === 'document') {
    return [{ uri: document.uri, source: document.getText() }];
  }
  // The request owns one source snapshot. Query-only edits must not restart
  // project discovery or copy the active buffer on every keystroke.
  const sourcesByUri = new Map<string, Promise<string>>();
  const currentSource = document.getText();
  sourcesByUri.set(Workspace.uriKey(document.uri), Promise.resolve(currentSource));
  const readSource = (uri: vscode.Uri): Promise<string> => {
    if (token.isCancellationRequested) { return Promise.reject(new vscode.CancellationError()); }
    const key = Workspace.uriKey(uri);
    let source = sourcesByUri.get(key);
    if (!source) { source = Workspace.readDocumentText(uri); sourcesByUri.set(key, source); }
    return source;
  };
  let project: LaTeXProject;
  try {
    project = await LaTeXProject.create(document.uri, {
      readSource,
      onDependency: uri => watch([uri]),
      onDirectory: directory => watch([], [directory])
    });
  } catch (error) {
    if (token.isCancellationRequested || error instanceof vscode.CancellationError) { throw new vscode.CancellationError(); }
    // Scratch buffers and incomplete projects still have useful local candidates.
    return [{ uri: document.uri, source: currentSource }];
  }
  if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
  const files = new Map<string, vscode.Uri>();
  files.set(Workspace.uriKey(project.mainfile), project.mainfile);
  for (const file of project.filelist) {
    if (file.exists) { files.set(Workspace.uriKey(file.uri), file.uri); }
  }
  // The current buffer remains useful even if an explicit main omits it.
  files.set(Workspace.uriKey(document.uri), document.uri);
  watch([project.mainfile, ...project.filelist.map(file => file.uri), document.uri]);
  const sources: CompletionSource[] = [];
  for (const uri of files.values()) {
    if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
    try {
      const source = await readSource(uri);
      if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
      sources.push({ uri, source });
    } catch (error) {
      if (error instanceof vscode.CancellationError) { throw error; }
      // A missing include must not prevent candidates from readable sources.
      if ((error as { code?: string }).code !== 'FileNotFound') { throw error; }
    }
  }
  return sources;
}
