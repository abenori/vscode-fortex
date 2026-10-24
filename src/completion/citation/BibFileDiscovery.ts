import * as path from 'path';
import * as vscode from 'vscode';
import * as LaTeXParser from '../../latex-parser';

/** Finds literal bibliography paths declared by classic BibTeX or biblatex. */
export function discoverBibReferences(texSource: string): string[] {
  const scanner = new LaTeXParser.SourceScanner(texSource);
  const document = new LaTeXParser.DocumentParser(scanner);
  const references: string[] = [];
  const seen = new Set<string>();

  const add = (reference: string, appendExtension: boolean) => {
    let normalized = reference.trim();
    // Macro-expanded filenames cannot be resolved statically; defer them rather
    // than presenting a misleading path to kpsewhich.
    if (!normalized || /[\\#${}]/.test(normalized)) {
      return;
    }
    if (appendExtension && !normalized.toLocaleLowerCase().endsWith('.bib')) {
      normalized += '.bib';
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      references.push(normalized);
    }
  };

  for (const declaration of document.declarations) {
    if (declaration.kind !== 'bibliography' || !declaration.complete || !declaration.argument) {
      continue;
    }
    const argument = declaration.argument;
    const raw = scanner.textWithoutComments(argument.contentStart, argument.contentEnd) ?? '';
    for (const reference of declaration.command === 'bibliography' ? raw.split(',') : [raw]) {
      add(reference, true);
    }
  }

  return references;
}

export function resolveBibUri(texUri: vscode.Uri, reference: string): vscode.Uri {
  // Preserve non-file URI schemes (remote workspaces, virtual documents) by using
  // URI path operations unless the reference is a native absolute path.
  const normalized = reference.replace(/\\/g, '/');
  if (texUri.scheme === 'file' && path.isAbsolute(reference)) {
    return vscode.Uri.file(reference);
  }
  if (normalized.startsWith('/')) {
    return texUri.with({ path: normalized });
  }
  return vscode.Uri.joinPath(texUri, '..', normalized);
}
