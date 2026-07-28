import * as path from 'path';
import * as vscode from 'vscode';

export function discoverBibReferences(texSource: string): string[] {
  const source = stripTeXComments(texSource);
  const references: string[] = [];
  const seen = new Set<string>();

  const add = (reference: string, appendExtension: boolean) => {
    let normalized = reference.trim();
    if (!normalized || normalized.includes('\\')) {
      return;
    }
    if (appendExtension && !normalized.toLocaleLowerCase().endsWith('.bib')) {
      normalized += '.bib';
    }
    const key = normalized.toLocaleLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      references.push(normalized);
    }
  };

  for (const match of source.matchAll(/\\bibliography\s*\{([^{}]*)\}/g)) {
    for (const reference of match[1].split(',')) {
      add(reference, true);
    }
  }
  for (const match of source.matchAll(/\\addbibresource\s*(?:\[[^\]]*\]\s*)?\{([^{}]*)\}/g)) {
    add(match[1], true);
  }

  return references;
}

export function resolveBibUri(texUri: vscode.Uri, reference: string): vscode.Uri {
  const normalized = reference.replace(/\\/g, '/');
  if (texUri.scheme === 'file' && path.isAbsolute(reference)) {
    return vscode.Uri.file(reference);
  }
  if (normalized.startsWith('/')) {
    return texUri.with({ path: normalized });
  }
  return vscode.Uri.joinPath(texUri, '..', normalized);
}

function stripTeXComments(source: string): string {
  let result = '';
  let inComment = false;
  let slashCount = 0;

  for (const char of source) {
    if (inComment) {
      if (char === '\n' || char === '\r') {
        inComment = false;
        result += char;
      }
      continue;
    }
    if (char === '%' && slashCount % 2 === 0) {
      inComment = true;
      slashCount = 0;
      continue;
    }
    result += char;
    if (char === '\\') {
      slashCount++;
    } else {
      slashCount = 0;
    }
  }
  return result;
}
