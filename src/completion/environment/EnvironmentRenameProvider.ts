import * as vscode from 'vscode';
import * as LaTeXParser from '../../latex-parser';

/** 構造上の対応が取れたLaTeX環境をF2で名前変更する． */
export default class EnvironmentRenameProvider implements vscode.RenameProvider {
  /**
   * カーソル位置の環境宣言を調べ，名前変更の対象範囲を返す．
   * @param document 要求の対象となる編集中の文書．
   * @param position 文書内の0始まりの行番号とUTF-16列位置．
   * @returns 名前の範囲，または範囲と入力初期値．対象外ならnull．
   */
  public prepareRename(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Range | {
    /** 文書内の置換または選択範囲． */
    range: vscode.Range;
    /** 名前変更の入力欄に最初に表示する文字列． */
    placeholder: string
  } | null {
    const source = document.getText();
    const offset = document.offsetAt(position);
    const parser = new LaTeXParser.LaTeXSource(source).createEnvironmentParser([], ['named', 'display']);
    const token = parser.tokenAt(offset);
    if (!token || (token.style !== 'named' && token.style !== 'display')) {
      return null;
    }
    if (!parser.pairAt(offset)) {
      throw new Error(`A matching ${token.kind === 'begin' ? '\\end' : '\\begin'} was not found.`);
    }
    return {
      range: tokenRange(document, token, token.style === 'display'),
      placeholder: token.style === 'display' ? '[' : token.name
    };
  }

  /**
   * 対応する環境の開始・終了宣言を同時に変更する編集を作る．
   * @param document 要求の対象となる編集中の文書．
   * @param position 文書内の0始まりの行番号とUTF-16列位置．
   * @param newName ユーザーが入力した新しい環境名．
   * @returns 両方の環境名または数式区切りを置き換えるワークスペース編集．
   */
  public provideRenameEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string
  ): vscode.WorkspaceEdit {
    const source = document.getText();
    const pair = new LaTeXParser.LaTeXSource(source).createEnvironmentParser([], ['named', 'display']).pairAt(document.offsetAt(position));
    if (!pair || (pair.begin.style !== 'named' && pair.begin.style !== 'display')) {
      throw new Error('A matching LaTeX environment pair was not found.');
    }

    const targetName = normalizeNewName(newName);
    const edit = new vscode.WorkspaceEdit();
    replaceToken(edit, document, pair.begin, pair, targetName);
    replaceToken(edit, document, pair.end, pair, targetName);
    return edit;
  }
}

/**
 * 入力された環境名や数式区切りを名前変更用に正規化する．
 * @param value 変換または検証する値．
 * @returns 外側の空白や環境コマンドを取り除いた名前．
 */
export function normalizeNewName(value: string): string {
  // 開き角括弧だけの入力，またはディスプレイ数式のいずれかの区切りは，角括弧形式の数式へ変換する．
  const name = value.trim();
  if (name === '[' || name === '\\[' || name === '\\]') {
    return LaTeXParser.DISPLAY_MATH_ENVIRONMENT;
  }
  if (!name || /[\s{}\\]/.test(name)) {
    throw new Error('Enter an environment name without whitespace, braces, or backslashes. Use [ for display math.');
  }
  return name;
}

/**
 * 環境宣言の記法に合わせた置換をワークスペース編集へ追加する．
 * @param edit 置換を追加するワークスペース編集．
 * @param document 要求の対象となる編集中の文書．
 * @param token 元ソース中の対象トークンとその範囲．
 * @param pair 対応する環境または数式の開始・終了宣言の組．
 * @param targetName 置換後の環境名または数式区切り．
 * @returns なし．
 */
function replaceToken(
  edit: vscode.WorkspaceEdit,
  document: vscode.TextDocument,
  token: LaTeXParser.EnvironmentToken,
  pair: LaTeXParser.EnvironmentPair,
  targetName: string
): void {
  // 名前付き環境と数式の形式を切り替える場合はコマンド全体を置き換える．名前付き環境同士の変更では波括弧内の名前だけを編集する．
  if (targetName === LaTeXParser.DISPLAY_MATH_ENVIRONMENT) {
    edit.replace(document.uri, tokenRange(document, token, true), token === pair.begin ? '\\[' : '\\]');
  } else if (token.style === 'display') {
    const replacement = token === pair.begin ? `\\begin{${targetName}}` : `\\end{${targetName}}`;
    edit.replace(document.uri, tokenRange(document, token, true), replacement);
  } else {
    edit.replace(document.uri, tokenRange(document, token, false), targetName);
  }
}

/**
 * 環境宣言全体または環境名だけの範囲をVS Codeの範囲へ変換する．
 * @param document 要求の対象となる編集中の文書．
 * @param token 元ソース中の対象トークンとその範囲．
 * @param full 環境名だけでなく宣言全体を対象にする場合はtrue．
 * @returns 指定した部分の文書内の範囲．
 */
function tokenRange(document: vscode.TextDocument, token: LaTeXParser.EnvironmentToken, full: boolean): vscode.Range {
  const start = full ? token.start : token.nameStart;
  const end = full ? token.end : token.nameEnd;
  return new vscode.Range(document.positionAt(start), document.positionAt(end));
}
