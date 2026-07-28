import * as vscode from 'vscode';
import { CitationEntry } from './Citation';
import { findCitationContext } from './CitationSearch';
import CitationService from './CitationService';

interface CitationQuickPickItem extends vscode.QuickPickItem {
  entry: CitationEntry;
}

export async function showCitationQuickPick(service: CitationService): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'latex') {
    void vscode.window.showInformationMessage('Open a LaTeX editor before inserting a citation.');
    return;
  }

  const entries = await service.entriesFor(editor.document);
  if (entries.length === 0) {
    void vscode.window.showInformationMessage('No bibliography entries were found in the .bib files referenced by this document.');
    return;
  }

  const quickPick = vscode.window.createQuickPick<CitationQuickPickItem>();
  quickPick.title = 'Insert Citation';
  quickPick.placeholder = 'Search by author or title';
  quickPick.canSelectMany = true;
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;

  const entriesByKey = new Map(entries.map((entry) => [entry.key, entry]));
  const selectedKeys = new Set<string>();
  let refreshing = false;
  const updateItems = () => {
    refreshing = true;
    const items = service.search(entries, quickPick.value).map(toQuickPickItem);
    quickPick.items = items;
    quickPick.selectedItems = items.filter((item) => selectedKeys.has(item.entry.key));
    refreshing = false;
  };
  updateItems();

  const disposables: vscode.Disposable[] = [];
  disposables.push(
    quickPick.onDidChangeValue(updateItems),
    quickPick.onDidChangeSelection((selectedItems) => {
      if (refreshing) {
        return;
      }
      const visibleKeys = new Set(quickPick.items.map((item) => item.entry.key));
      const currentKeys = new Set(selectedItems.map((item) => item.entry.key));
      for (const key of visibleKeys) {
        if (!currentKeys.has(key)) {
          selectedKeys.delete(key);
        }
      }
      for (const key of currentKeys) {
        selectedKeys.add(key);
      }
    }),
    quickPick.onDidAccept(async () => {
      const pickedEntries = selectedKeys.size > 0
        ? Array.from(selectedKeys, (key) => entriesByKey.get(key)).filter((entry): entry is CitationEntry => entry !== undefined)
        : quickPick.activeItems.map((item) => item.entry);
      if (pickedEntries.length === 0) {
        return;
      }
      const keys = pickedEntries.map((entry) => entry.key).join(', ');
      quickPick.hide();
      await insertCitations(editor, keys);
    }),
    quickPick.onDidHide(() => {
      for (const disposable of disposables) {
        disposable.dispose();
      }
      quickPick.dispose();
    })
  );
  quickPick.show();
}

function toQuickPickItem(entry: CitationEntry): CitationQuickPickItem {
  return {
    label: entry.key,
    description: [entry.author, entry.year].filter(Boolean).join(' · '),
    detail: entry.title || '(No title)',
    alwaysShow: true,
    entry
  };
}

async function insertCitations(editor: vscode.TextEditor, keys: string): Promise<void> {
  const document = editor.document;
  await editor.edit((edit) => {
    for (const selection of editor.selections) {
      const offset = document.offsetAt(selection.active);
      const context = selection.isEmpty ? findCitationContext(document.getText(), offset) : undefined;
      if (context) {
        edit.replace(new vscode.Range(document.positionAt(context.queryStart), selection.active), keys);
      } else if (!selection.isEmpty) {
        edit.replace(selection, `\\cite{${keys}}`);
      } else {
        edit.insert(selection.active, `\\cite{${keys}}`);
      }
    }
  });
}
