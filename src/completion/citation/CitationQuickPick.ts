import * as vscode from 'vscode';
import { CitationEntry } from './Citation';
import { findCitationContext, searchCitations } from './CitationSearch';
import CitationService from './CitationService';

interface CitationQuickPickItem extends vscode.QuickPickItem {
  /** 表示項目に対応する元の解析データ． */
  entry: CitationEntry;
}

/**
 * Ctrl+T [で使う，検索と複数選択に対応した文献選択画面を開く．
 * @param service 関連情報の取得や更新を担当するサービス．
 * @returns 処理の完了を表すPromise．値は返さない．
 */
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

  // 検索文字列が変わるたびに候補一覧が置き換わるため，以前の絞り込みで選んだ文献を失わないよう選択状態を別に保持する．
  const entriesByKey = new Map(entries.map((entry) => [entry.key, entry]));
  const selectedKeys = new Set<string>();
  let refreshing = false;
  const updateItems = () => {
    refreshing = true;
    const items = searchCitations(entries, quickPick.value).map(toQuickPickItem);
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

/**
 * 文献情報から選択画面の表示項目を作る．
 * @param entry 引用キー，種別，著者，題名，出版年，および元の文献ファイルのURI．
 * @returns 引用キー，著者・題名の表示，および元の文献情報を含む項目．
 */
function toQuickPickItem(entry: CitationEntry): CitationQuickPickItem {
  return {
    label: entry.key,
    description: [entry.author, entry.year].filter(Boolean).join(' · '),
    detail: entry.title || '(No title)',
    alwaysShow: true,
    entry
  };
}

/**
 * 選択された引用キーを現在の引用引数へ挿入する．
 * @param editor 編集または移動の対象となるエディタ．
 * @param keys 挿入する引用キーをカンマで連結した文字列．
 * @returns 処理の完了を表すPromise．値は返さない．
 */
async function insertCitations(editor: vscode.TextEditor, keys: string): Promise<void> {
  // カーソルごとに，引用キーの置換，選択文字列の囲み込み，空の位置へのコマンド挿入を判定する．
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
