export interface GreekEntry {
  readonly code: string;
  readonly command: string;
}

/**
 * YaTeX's standard Greek abbreviations, in their original order.
 * Package-dependent uppercase variants and the upstream `f`/`foo` placeholder
 * are deliberately excluded.
 * https://github.com/hiroseyuuji/yatex/blob/master/yatexmth.el
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

/** Return case-sensitive prefix matches, retaining YaTeX's candidate order. */
export function findGreekCandidates(code: string): readonly GreekEntry[] {
  return GREEK_ENTRIES.filter(entry => entry.code.startsWith(code));
}

/** Prefer a complete abbreviation; otherwise preview its first continuation. */
export function findGreekPreview(code: string): GreekEntry | undefined {
  if (!code) {
    return undefined;
  }
  const candidates = findGreekCandidates(code);
  return candidates.find(entry => entry.code === code) ?? candidates[0];
}
