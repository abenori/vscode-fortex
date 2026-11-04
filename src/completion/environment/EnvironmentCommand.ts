import * as vscode from 'vscode';
import * as LaTeXParser from '../../latex-parser';
import { environmentContentIndentation, environmentSnippet } from './EnvironmentCompletionProvider';
import EnvironmentRenameProvider, { normalizeNewName } from './EnvironmentRenameProvider';
import { collectEnvironmentNames } from './EnvironmentParser';

interface EnvironmentQuickPickItem extends vscode.QuickPickItem {
  /** 対象の名前． */
  name: string;
}

/**
 * Ctrl+T Bで，現在位置に応じて環境の名前変更・挿入・囲み込みを行う．
 * 引数はない．
 * @returns 処理の完了を表すPromise．値は返さない．
 */
export async function insertOrRenameEnvironment(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'latex') {
    void vscode.window.showWarningMessage('Open a LaTeX editor before inserting an environment.');
    return;
  }

  const source = editor.document.getText();
  const syntax = new LaTeXParser.LaTeXSource(source);
  const selection = editor.selection;
  const version = editor.document.version;
  const offset = editor.document.offsetAt(selection.active);
  // 空でない選択範囲は常に囲み込みとして扱う．名前変更は，既存の環境コマンド上の空の選択範囲だけに適用する．
  const parser = syntax.createEnvironmentParser([], ['named', 'display']);
  const currentToken = selection.isEmpty ? parser.tokenAt(offset) : undefined;
  const token = currentToken?.style === 'named' || currentToken?.style === 'display' ? currentToken : undefined;
  if (token && !parser.pairAt(offset)) {
    void vscode.window.showWarningMessage(`A matching ${token.kind === 'begin' ? '\\end' : '\\begin'} was not found.`);
    return;
  }

  const items: EnvironmentQuickPickItem[] = [
    {
      label: '\\[ … \\]',
      description: 'Display math',
      name: LaTeXParser.DISPLAY_MATH_ENVIRONMENT
    },
    ...collectEnvironmentNames(syntax).map((name) => ({ label: name, name }))
  ];
  const picked = token
    ? await pickReplacementEnvironment(items, token.name)
    : await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a LaTeX environment to insert',
      matchOnDescription: true
    });
  if (!picked) {
    return;
  }
  if (editor.document.isClosed || editor.document.version !== version) {
    void vscode.window.showWarningMessage('The document changed while selecting an environment. Please try again.');
    return;
  }
  if (token) {
    const edit = new EnvironmentRenameProvider().provideRenameEdits(editor.document, selection.active, picked.name);
    await vscode.workspace.applyEdit(edit);
    return;
  }

  const position = selection.active;
  const eol = editor.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const opening = picked.name === LaTeXParser.DISPLAY_MATH_ENVIRONMENT ? '\\[' : `\\begin{${picked.name}}`;
  const closing = picked.name === LaTeXParser.DISPLAY_MATH_ENVIRONMENT ? '\\]' : `\\end{${picked.name}}`;

  if (selection.isEmpty) {
    await editor.insertSnippet(environmentSnippet(editor.document, position, picked.name, true), selection);
    return;
  }

  // TM_SELECTED_TEXTを使い，複数行の選択範囲を1回のスニペット編集で保持する．
  const snippet = new vscode.SnippetString();
  snippet.appendText(`${opening}${eol}${environmentContentIndentation(editor.document.uri)}`);
  snippet.appendVariable('TM_SELECTED_TEXT', '');
  snippet.appendText(`${eol}${closing}`);
  await editor.insertSnippet(snippet, selection);
}

/**
 * 候補を表示しながら，F2と同様に新しい名前も入力できるようにする．
 * @param items 選択または変換する項目の一覧．
 * @param currentName 現在の環境名．
 * @returns 選択または新規入力された環境名を持つ項目．取り消した場合はundefined．Promiseで返す．
 */
function pickReplacementEnvironment(
  items: EnvironmentQuickPickItem[],
  currentName: string
): Promise<EnvironmentQuickPickItem | undefined> {
  const quickPick = vscode.window.createQuickPick<EnvironmentQuickPickItem>();
  quickPick.title = 'Rename LaTeX Environment';
  quickPick.placeholder = `Select or enter an environment (currently ${currentName}). Use [ for display math.`;
  quickPick.matchOnDescription = true;
  quickPick.items = items;
  quickPick.activeItems = items.filter((item) => item.name === currentName);

  return new Promise((resolve) => {
    let picked: EnvironmentQuickPickItem | undefined;
    const disposables = [
      quickPick.onDidChangeValue((value) => {
        let name: string;
        try {
          name = normalizeNewName(value);
        } catch {
          quickPick.items = items;
          return;
        }
        if (name === LaTeXParser.DISPLAY_MATH_ENVIRONMENT) {
          // 従来の閉じ区切りの別名でも，ディスプレイ数式の項目に一致する必要がある．
          quickPick.items = items.filter((item) => item.name === name).map((item) => ({ ...item, alwaysShow: true }));
        } else {
          quickPick.items = items.some((item) => item.name === name)
            ? items
            : [...items, { label: `Use "${name}"`, description: 'New environment name', name, alwaysShow: true }];
          // 入力途中の名前を新しい名前として採用するより，既存の環境名への補完を優先する．新規入力の項目は明示的に選べるよう残す．
          const suggestion = items.find((item) => item.name === name)
            ?? items.find((item) => item.name.toLowerCase().startsWith(name.toLowerCase()));
          if (suggestion) {
            quickPick.activeItems = [suggestion];
          }
        }
      }),
      quickPick.onDidAccept(() => {
        picked = quickPick.selectedItems[0] ?? quickPick.activeItems[0];
        if (picked) {
          quickPick.hide();
        }
      }),
      quickPick.onDidHide(() => {
        resolve(picked);
        for (const disposable of disposables) {
          disposable.dispose();
        }
        quickPick.dispose();
      })
    ];
    quickPick.show();
  });
}
