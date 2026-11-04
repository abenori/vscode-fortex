import * as vscode from 'vscode';
import * as LaTeXParser from '../latex-parser';

interface NavigationQuickPickItem extends vscode.QuickPickItem {
  /** 移動先のラベルまたは参照のキーと元ソースの範囲． */
  token: LaTeXParser.ReferenceToken;
}

/**
 * 環境・ラベル・参照コマンドから，対応する宣言または参照先へ移動する．
 * 引数はない．
 * @returns 処理の完了を表すPromise．値は返さない．
 */
export async function goToCorresponding(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'latex') {
    vscode.window.setStatusBarMessage('Open a LaTeX editor before using Go to Corresponding.', 5000);
    return;
  }

  const document = editor.document;
  const source = document.getText();
  const offset = document.offsetAt(editor.selection.active);
  const syntax = new LaTeXParser.LaTeXSource(source);
  const environmentPair = syntax.createEnvironmentParser([], ['named', 'display']).pairAt(offset);
  if (environmentPair) {
    const target = isWithin(environmentPair.begin, offset) ? environmentPair.end : environmentPair.begin;
    moveCursor(editor, target.style === 'named' ? target.nameStart : target.start);
    return;
  }

  const references = syntax.referenceParser;
  const current = references.tokenAt(offset);
  if (!current) {
    vscode.window.setStatusBarMessage(
      'Place the cursor on \\begin, \\end, \\label, or a reference command.',
      5000
    );
    return;
  }

  const targetKind = current.kind === 'label' ? 'reference' : 'label';
  const targets = references.tokens.filter(
    (token) => token.kind === targetKind && token.key === current.key
  );
  if (targets.length === 0) {
    const targetName = targetKind === 'label' ? '\\label' : 'reference';
    vscode.window.setStatusBarMessage(`No matching ${targetName} was found for "${current.key}".`, 5000);
    return;
  }

  let target = targets[0];
  if (targets.length > 1) {
    const selected = await vscode.window.showQuickPick(
      targets.map((token) => createQuickPickItem(document, token)),
      {
        placeHolder: `Select the corresponding ${targetKind} for "${current.key}"`,
        matchOnDescription: true,
        matchOnDetail: true
      }
    );
    if (!selected) {
      return;
    }
    target = selected.token;
  }
  moveCursor(editor, target.keyStart);
}

/**
 * 参照の出現位置を移動先の選択項目へ変換する．
 * @param document 要求の対象となる編集中の文書．
 * @param token 元ソース中の対象トークンとその範囲．
 * @returns 表示用の行番号・周辺行と，元の参照トークンを含む項目．
 */
function createQuickPickItem(
  document: vscode.TextDocument,
  token: LaTeXParser.ReferenceToken
): NavigationQuickPickItem {
  const position = document.positionAt(token.keyStart);
  const command = document.getText(new vscode.Range(
    document.positionAt(token.commandStart),
    document.positionAt(token.commandEnd)
  ));
  return {
    label: command,
    description: `Line ${position.line + 1}`,
    detail: document.lineAt(position.line).text.trim(),
    token
  };
}

/**
 * 文書内の指定位置へカーソルを移して表示範囲を合わせる．
 * @param editor 編集または移動の対象となるエディタ．
 * @param offset 対象文字列の先頭を0とするUTF-16位置．
 * @returns なし．
 */
function moveCursor(editor: vscode.TextEditor, offset: number): void {
  const position = editor.document.positionAt(offset);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/**
 * 指定位置が環境宣言の範囲内にあるかを判定する．
 * @param token 元ソース中の対象トークンとその範囲．
 * @param offset 対象文字列の先頭を0とするUTF-16位置．
 * @returns 開始位置以上かつ終了位置以下であればtrue．
 */
function isWithin(token: LaTeXParser.EnvironmentToken, offset: number): boolean {
  return token.start <= offset && offset <= token.end;
}
