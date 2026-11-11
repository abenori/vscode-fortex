import * as vscode from 'vscode';
import * as LaTeXParser from '../../latex-parser';

/**
 * カーソルより前にある，実際に閉じていない最も内側の環境を閉じる．
 * 引数はない．
 * @returns 処理の完了を表すPromise．値は返さない．
 */
export async function closeEnvironment(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'latex') {
    void vscode.window.showWarningMessage('Open a LaTeX editor before closing an environment.');
    return;
  }

  const document = editor.document;
  const cursor = editor.selection.active;
  const offset = document.offsetAt(cursor);
  const environment = new LaTeXParser.LaTeXSource(document.getText()).createEnvironmentParser([], ['named', 'display']).unclosed
    .filter(token => (token.style === 'named' || token.style === 'display') && token.end <= offset).at(-1);
  if (!environment) {
    vscode.window.setStatusBarMessage('fortex: No unclosed environment was found before the cursor.', 3000);
    return;
  }

  const openingLine = document.lineAt(document.positionAt(environment.start).line).text;
  const indentation = openingLine.match(/^\s*/)?.[0] ?? '';
  const closing = environment.name === LaTeXParser.DISPLAY_MATH_ENVIRONMENT ? '\\]' : `\\end{${environment.name}}`;
  const currentLine = document.lineAt(cursor.line);
  let finalPosition: vscode.Position;

  if (currentLine.text.trim() === '') {
    // 空行があれば新しい行を追加せず再利用し，その空白を開始コマンドと同じ字下げに置き換える．
    await editor.edit((edit) => edit.replace(currentLine.range, indentation + closing));
    finalPosition = new vscode.Position(cursor.line, indentation.length + closing.length);
  } else {
    // 同じ行の前後に本文があれば，カーソル位置に改行や字下げを追加せず挿入する．
    await editor.edit((edit) => edit.insert(cursor, closing));
    finalPosition = new vscode.Position(cursor.line, cursor.character + closing.length);
  }

  editor.selection = new vscode.Selection(finalPosition, finalPosition);
  editor.revealRange(new vscode.Range(finalPosition, finalPosition));
}
