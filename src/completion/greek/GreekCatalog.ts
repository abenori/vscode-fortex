export interface GreekEntry {
  /** 大文字小文字を区別するギリシャ文字の略記． */
  readonly code: string;
  /** 挿入するLaTeXコマンド．先頭のバックスラッシュを含む． */
  readonly command: string;
}

/**
 * YaTeX標準のギリシャ文字の略記を元の順序で保持する．パッケージに依存する大文字の別形式と，元データのf・fooの仮項目は除外する．
 * 参照元: https://github.com/hiroseyuuji/yatex/blob/master/yatexmth.el
 */
export const GREEK_ENTRIES: readonly GreekEntry[] = [
  { code: 'a', command: '\\alpha' },
  { code: 'b', command: '\\beta' },
  { code: 'g', command: '\\gamma' },
  { code: 'G', command: '\\Gamma' },
  { code: 'd', command: '\\delta' },
  { code: 'D', command: '\\Delta' },
  { code: 'e', command: '\\epsilon' },
  { code: 'e-', command: '\\varepsilon' },
  { code: 'z', command: '\\zeta' },
  { code: 'et', command: '\\eta' },
  { code: 'th', command: '\\theta' },
  { code: 'Th', command: '\\Theta' },
  { code: 'th-', command: '\\vartheta' },
  { code: 'i', command: '\\iota' },
  { code: 'k', command: '\\kappa' },
  { code: 'l', command: '\\lambda' },
  { code: 'L', command: '\\Lambda' },
  { code: 'm', command: '\\mu' },
  { code: 'n', command: '\\nu' },
  { code: 'x', command: '\\xi' },
  { code: 'X', command: '\\Xi' },
  { code: 'p', command: '\\pi' },
  { code: 'P', command: '\\Pi' },
  { code: 'p-', command: '\\varpi' },
  { code: 'r', command: '\\rho' },
  { code: 'r-', command: '\\varrho' },
  { code: 's', command: '\\sigma' },
  { code: 'S', command: '\\Sigma' },
  { code: 's-', command: '\\varsigma' },
  { code: 't', command: '\\tau' },
  { code: 'u', command: '\\upsilon' },
  { code: 'y', command: '\\upsilon' },
  { code: 'U', command: '\\Upsilon' },
  { code: 'Y', command: '\\Upsilon' },
  { code: 'ph', command: '\\phi' },
  { code: 'Ph', command: '\\Phi' },
  { code: 'ph-', command: '\\varphi' },
  { code: 'c', command: '\\chi' },
  { code: 'ps', command: '\\psi' },
  { code: 'Ps', command: '\\Psi' },
  { code: 'o', command: '\\omega' },
  { code: 'w', command: '\\omega' },
  { code: 'O', command: '\\Omega' },
  { code: 'W', command: '\\Omega' }
];

/**
 * 大文字小文字を区別して前方一致する候補を，YaTeXの候補順で返す．
 * @param code 大文字小文字を区別するギリシャ文字の略記．
 * @returns 大文字小文字を区別して略記の前方が一致する，カタログ順の候補．
 */
export function findGreekCandidates(code: string): readonly GreekEntry[] {
  return GREEK_ENTRIES.filter(entry => entry.code.startsWith(code));
}

/**
 * 完全一致する略記を優先し，なければ最初の前方一致候補をプレビューする．
 * @param code 大文字小文字を区別するギリシャ文字の略記．
 * @returns 完全一致する略記，または最初の前方一致候補．候補がなければundefined．
 */
export function findGreekPreview(code: string): GreekEntry | undefined {
  if (!code) {
    return undefined;
  }
  const candidates = findGreekCandidates(code);
  return candidates.find(entry => entry.code === code) ?? candidates[0];
}
