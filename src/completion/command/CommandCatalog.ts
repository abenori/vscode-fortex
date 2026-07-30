export interface CommandCatalogEntry {
  name: string;
  snippet: string;
  detail: string;
  retriggerSuggestions?: boolean;
}

/**
 * Common LaTeX commands that are useful without inspecting installed packages.
 * Snippets include only stable, widely supported arguments; package-specific
 * options can still be typed after accepting a completion.
 */
export const COMMAND_CATALOG: readonly CommandCatalogEntry[] = [
  { name: 'documentclass', snippet: '\\documentclass{${1:class}}$0', detail: 'Document class' },
  { name: 'usepackage', snippet: '\\usepackage{${1:package}}$0', detail: 'Load a package' },
  { name: 'title', snippet: '\\title{${1:title}}$0', detail: 'Document title' },
  { name: 'author', snippet: '\\author{${1:author}}$0', detail: 'Document author' },
  { name: 'date', snippet: '\\date{${1:date}}$0', detail: 'Document date' },
  { name: 'maketitle', snippet: '\\maketitle$0', detail: 'Print the title' },
  { name: 'today', snippet: '\\today$0', detail: 'Current date' },
  { name: 'TeX', snippet: '\\TeX$0', detail: 'TeX logo' },
  { name: 'LaTeX', snippet: '\\LaTeX$0', detail: 'LaTeX logo' },
  { name: 'tableofcontents', snippet: '\\tableofcontents$0', detail: 'Table of contents' },
  { name: 'part', snippet: '\\part{${1:title}}$0', detail: 'Part heading' },
  { name: 'chapter', snippet: '\\chapter{${1:title}}$0', detail: 'Chapter heading' },
  { name: 'section', snippet: '\\section{${1:title}}$0', detail: 'Section heading' },
  { name: 'section*', snippet: '\\section*{${1:title}}$0', detail: 'Unnumbered section heading' },
  { name: 'subsection', snippet: '\\subsection{${1:title}}$0', detail: 'Subsection heading' },
  { name: 'subsection*', snippet: '\\subsection*{${1:title}}$0', detail: 'Unnumbered subsection heading' },
  { name: 'subsubsection', snippet: '\\subsubsection{${1:title}}$0', detail: 'Subsubsection heading' },
  { name: 'paragraph', snippet: '\\paragraph{${1:title}}$0', detail: 'Paragraph heading' },
  { name: 'subparagraph', snippet: '\\subparagraph{${1:title}}$0', detail: 'Subparagraph heading' },
  { name: 'appendix', snippet: '\\appendix$0', detail: 'Start appendices' },
  { name: 'begin', snippet: '\\begin{', detail: 'Begin an environment', retriggerSuggestions: true },
  { name: 'item', snippet: '\\item $0', detail: 'List item' },
  { name: 'label', snippet: '\\label{${1:key}}$0', detail: 'Define a reference target' },
  { name: 'ref', snippet: '\\ref{', detail: 'Reference a label', retriggerSuggestions: true },
  { name: 'pageref', snippet: '\\pageref{', detail: 'Reference a page', retriggerSuggestions: true },
  { name: 'eqref', snippet: '\\eqref{', detail: 'Reference an equation', retriggerSuggestions: true },
  { name: 'cite', snippet: '\\cite{', detail: 'Insert a citation', retriggerSuggestions: true },
  { name: 'footnote', snippet: '\\footnote{${1:text}}$0', detail: 'Footnote' },
  { name: 'caption', snippet: '\\caption{${1:caption}}$0', detail: 'Figure or table caption' },
  { name: 'input', snippet: '\\input{${1:file}}$0', detail: 'Input a LaTeX file' },
  { name: 'include', snippet: '\\include{${1:file}}$0', detail: 'Include a LaTeX file' },
  { name: 'includegraphics', snippet: '\\includegraphics{${1:file}}$0', detail: 'Insert an image' },
  { name: 'url', snippet: '\\url{${1:url}}$0', detail: 'URL' },
  { name: 'href', snippet: '\\href{${1:url}}{${2:text}}$0', detail: 'Hyperlink' },
  { name: 'textbf', snippet: '\\textbf{${1:text}}$0', detail: 'Bold text' },
  { name: 'textit', snippet: '\\textit{${1:text}}$0', detail: 'Italic text' },
  { name: 'texttt', snippet: '\\texttt{${1:text}}$0', detail: 'Monospaced text' },
  { name: 'textsf', snippet: '\\textsf{${1:text}}$0', detail: 'Sans-serif text' },
  { name: 'textrm', snippet: '\\textrm{${1:text}}$0', detail: 'Roman text' },
  { name: 'textsc', snippet: '\\textsc{${1:text}}$0', detail: 'Small caps text' },
  { name: 'emph', snippet: '\\emph{${1:text}}$0', detail: 'Emphasized text' },
  { name: 'underline', snippet: '\\underline{${1:text}}$0', detail: 'Underlined text' },
  { name: 'centering', snippet: '\\centering$0', detail: 'Center following content' },
  { name: 'noindent', snippet: '\\noindent$0', detail: 'Suppress paragraph indentation' },
  { name: 'newline', snippet: '\\newline$0', detail: 'Line break' },
  { name: 'newpage', snippet: '\\newpage$0', detail: 'Start a new page' },
  { name: 'clearpage', snippet: '\\clearpage$0', detail: 'Flush floats and start a page' },
  { name: 'hspace', snippet: '\\hspace{${1:length}}$0', detail: 'Horizontal space' },
  { name: 'vspace', snippet: '\\vspace{${1:length}}$0', detail: 'Vertical space' },
  { name: 'frac', snippet: '\\frac{${1:numerator}}{${2:denominator}}$0', detail: 'Fraction' },
  { name: 'sqrt', snippet: '\\sqrt{${1:value}}$0', detail: 'Square root' },
  { name: 'text', snippet: '\\text{${1:text}}$0', detail: 'Text in math mode' },
  { name: 'mathrm', snippet: '\\mathrm{${1:text}}$0', detail: 'Roman math text' },
  { name: 'mathbf', snippet: '\\mathbf{${1:value}}$0', detail: 'Bold math text' },
  { name: 'mathit', snippet: '\\mathit{${1:value}}$0', detail: 'Italic math text' },
  { name: 'mathcal', snippet: '\\mathcal{${1:value}}$0', detail: 'Calligraphic math text' },
  { name: 'mathbb', snippet: '\\mathbb{${1:value}}$0', detail: 'Blackboard-bold math text' },
  { name: 'operatorname', snippet: '\\operatorname{${1:name}}$0', detail: 'Named math operator' },
  { name: 'sum', snippet: '\\sum_{${1:i=1}}^{${2:n}}$0', detail: 'Summation' },
  { name: 'prod', snippet: '\\prod_{${1:i=1}}^{${2:n}}$0', detail: 'Product' },
  { name: 'int', snippet: '\\int_{${1:a}}^{${2:b}} $0', detail: 'Integral' },
  { name: 'lim', snippet: '\\lim_{${1:x \\to a}} $0', detail: 'Limit' },
  { name: 'sin', snippet: '\\sin$0', detail: 'Sine' },
  { name: 'cos', snippet: '\\cos$0', detail: 'Cosine' },
  { name: 'tan', snippet: '\\tan$0', detail: 'Tangent' },
  { name: 'log', snippet: '\\log$0', detail: 'Logarithm' },
  { name: 'exp', snippet: '\\exp$0', detail: 'Exponential' },
  { name: 'partial', snippet: '\\partial$0', detail: 'Partial derivative symbol' },
  { name: 'infty', snippet: '\\infty$0', detail: 'Infinity symbol' },
  { name: 'ldots', snippet: '\\ldots$0', detail: 'Low ellipsis' },
  { name: 'cdots', snippet: '\\cdots$0', detail: 'Centered ellipsis' },
  { name: 'quad', snippet: '\\quad$0', detail: 'Math spacing' },
  { name: 'qquad', snippet: '\\qquad$0', detail: 'Wide math spacing' },
  ...['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'vartheta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi', 'varpi', 'rho', 'varrho', 'sigma', 'varsigma', 'tau', 'upsilon', 'phi', 'varphi', 'chi', 'psi', 'omega'].map((name) => ({
    name,
    snippet: `\\${name}$0`,
    detail: 'Greek letter'
  })),
  ...['Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega'].map((name) => ({
    name,
    snippet: `\\${name}$0`,
    detail: 'Greek letter'
  }))
];
