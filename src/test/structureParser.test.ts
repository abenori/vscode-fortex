import * as assert from 'assert';
import { isStructureTrivia, parseStructureEvents, structurePlainText } from '../structure/LaTeXStructureParser';

suite('LaTeX structure parser', () => {
  test('shares commented input paths and ignores malformed dollar syntax in skipped arguments', () => {
    const source = '\\newcommand{\\fake}{$}\r\n\\section{Title $}\r\n\\input{chap% comment\r\nter}\r\n$x$$y$ $$ z $$';
    const events = parseStructureEvents(source);
    assert.deepStrictEqual(events.map(event => event.type), ['heading', 'include', 'begin', 'end']);
    assert.strictEqual(events[1].type === 'include' && events[1].path, 'chapter');
    assert.strictEqual(events[2].type === 'begin' && events[2].name, '$$');
  });

  test('reads every standard heading level and starred headings', () => {
    const source = String.raw`\part{Part}\chapter{Chapter}\section*{Section}\subsection{Subsection}\subsubsection{Subsubsection}\paragraph{Paragraph}\subparagraph{Subparagraph}`;
    const headings = parseStructureEvents(source).filter(event => event.type === 'heading');
    assert.deepStrictEqual(headings.map(event => [event.command, event.level]), [
      ['part', 0], ['chapter', 1], ['section', 2], ['subsection', 3],
      ['subsubsection', 4], ['paragraph', 5], ['subparagraph', 6]
    ]);
    assert.strictEqual(source.slice(headings[2].start, headings[2].end), String.raw`\section*{Section}`);
  });

  test('balances multiline and nested titles and uses the full title', () => {
    const source = '\\section*[Short {nested}]\r\n{Long \\textbf{bold}\r\n title with \\{braces\\}}';
    const events = parseStructureEvents(source);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, 'heading');
    if (events[0].type === 'heading') {
      assert.strictEqual(events[0].title, 'Long bold title with {braces}');
      assert.strictEqual(events[0].end, source.length);
    }
  });

  test('ignores comments, escaped slashes, and commands nested in heading arguments', () => {
    const source = String.raw`% \section{Comment}
\\section{Escaped}
\section{Real \textbf{nested \section{Not another heading}}}
\% \subsection{After escaped percent}
`;
    const headings = parseStructureEvents(source).filter(event => event.type === 'heading');
    assert.deepStrictEqual(headings.map(event => event.command), ['section', 'subsection']);
  });

  test('skips literal environment contents and inline verbatim', () => {
    const source = String.raw`\begin{verbatim}
\section{Example}\label{fake}$$
\end{verbatim}
\verb|\section{Inline}| \verb*+\label{inline}+
\lstinline[language=TeX]|\section{Listing}|
\lstinline{\section{Braced listing}}
\mintinline{latex}{\section{Inline minted}% literal}
\mintinline[breaklines]{latex}|\label{inline:minted}|
\begin{minted}{latex}\section{Code}\end{minted}
\begin{comment}\section{Hidden}\end{comment}
\section{Visible}`;
    const events = parseStructureEvents(source);
    assert.deepStrictEqual(events.filter(event => event.type === 'heading').map(event => event.title), ['Visible']);
    assert.strictEqual(events.filter(event => event.type === 'label').length, 0);
    assert.deepStrictEqual(events.filter(event => event.type === 'begin').map(event => event.name), ['verbatim', 'minted', 'comment']);
    assert.deepStrictEqual(events.filter(event => event.type === 'end').map(event => event.name), ['verbatim', 'minted', 'comment']);
  });

  test('handles comments between literal environment commands and names', () => {
    const events = parseStructureEvents('\\begin% \\section{Comment}\n{verbatim}\n\\section{Example}\n\\end{verbatim}\\section{Real}');
    assert.deepStrictEqual(events.map(event => event.type), ['begin', 'end', 'heading']);
  });

  test('reports labels and captions inside titles with original offsets', () => {
    const source = String.raw`😀\section{題名 \textbf{with \label{sec:one}} \caption{Nested \label{fig:one}}}`;
    const events = parseStructureEvents(source);
    assert.deepStrictEqual(events.map(event => event.type), ['heading', 'label', 'caption', 'label']);
    assert.strictEqual(events[0].start, 2);
    if (events[0].type === 'heading') {
      assert.ok(!events[0].title.includes('label'));
    }
    for (const event of events.filter(event => event.type === 'label')) {
      assert.strictEqual(source.slice(event.start, event.end), `\\label{${event.key}}`);
    }
  });

  test('emits environments, proof titles, captions and labels', () => {
    const source = String.raw`\begin{proof}[A \emph{sketch}]\label{proof:key}\end{proof}
\begin{figure}\caption[Short]{A \textbf{long} caption}\label{fig:key}\end{figure}`;
    const events = parseStructureEvents(source);
    assert.deepStrictEqual(events.map(event => event.type), ['begin', 'label', 'end', 'begin', 'caption', 'label', 'end']);
    assert.deepStrictEqual(events[0], { type: 'begin', name: 'proof', title: 'A sketch', start: 0, end: source.indexOf('\\label') });
    const caption = events.find(event => event.type === 'caption');
    assert.strictEqual(caption?.title, 'A long caption');
  });

  test('recognizes display math delimiters while respecting escaped dollars', () => {
    const source = String.raw`\$ \[ x=1 \label{eq:one} \] $inline$ $$ y=2 $$`;
    const events = parseStructureEvents(source);
    assert.deepStrictEqual(events.map(event => event.type === 'label' ? event.key : 'name' in event ? `${event.type}:${event.name}` : event.type), [
      'begin:\\[', 'eq:one', 'end:\\[', 'begin:$$', 'end:$$'
    ]);
  });

  test('keeps leading intervals in display equation bodies', () => {
    for (const environment of ['equation', 'align', 'alignat', 'gather', 'multline', 'flalign', 'displaymath']) {
      for (const suffix of ['', '*']) {
        const name = environment + suffix;
        const opening = `\\begin{${name}}`;
        const body = String.raw`[0,1] \subseteq \mathbb R`;
        const source = `${opening}${body}\\end{${name}}`;
        const events = parseStructureEvents(source);
        assert.strictEqual(events[0].type, 'begin');
        if (events[0].type === 'begin') {
          assert.strictEqual(events[0].end, opening.length, name);
          assert.strictEqual(events[0].title, undefined, name);
          assert.strictEqual(source.slice(events[0].end, events[1].start), body, name);
        }
      }
    }
  });

  test('reads theorem declarations with stars and shared counters', () => {
    const source = String.raw`\newtheorem{thm}{Theorem}[section]
\newtheorem{lem}[thm]{A \textbf{lemma}}
\newtheorem*{remark}{Remark}
\begin{lem}[Optional name]Text\end{lem}`;
    const definitions = parseStructureEvents(source).filter(event => event.type === 'theoremDefinition');
    assert.deepStrictEqual(definitions.map(event => [event.name, event.title]), [['thm', 'Theorem'], ['lem', 'A lemma'], ['remark', 'Remark']]);
  });

  test('skips ordinary, primitive, environment and xparse definitions', () => {
    const source = String.raw`\newcommand{\fake}[1][default]{\section{Fake}\label{fake}}
\renewcommand\another{\caption{Fake}}
\def\primitive#1{\section{Fake}}
\newenvironment{example}{\section{Fake}}{\section{Fake}}
\NewDocumentCommand{\custom}{m O{default}}{\section{Fake}}
\NewDocumentEnvironment{customenv}{m}{\section{Fake}}{\section{Fake}}
\section{Real}`;
    const events = parseStructureEvents(source);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, 'heading');
  });

  test('reads literal braced input paths and rejects dynamic paths', () => {
    const source = String.raw`\input{chapters/one.tex}
\include {chapters/two}
\input{chapters/three.tex}
\input{\jobname-part}
% \include{ignored}
`;
    const events = parseStructureEvents(source).filter(event => event.type === 'include');
    assert.deepStrictEqual(events.map(event => event.path), [
      'chapters/one.tex', 'chapters/two', 'chapters/three.tex'
    ]);
  });

  test('uses TeX filename whitespace and quote rules for literal input events', () => {
    const source = '\\input{"with space"}\n\\input{"quoted file"}\n' +
      '\\input{with  spaces}\n\\input{trailing }\n\\input{chap% comment\n   ter}\n' +
      '\\input{line\n   break}\n\\section{After}';
    const events = parseStructureEvents(source);
    const inputs = events.filter(event => event.type === 'include');
    assert.deepStrictEqual(inputs.map(event => event.path),
      ['with space', 'quoted file', 'with spaces', 'trailing ', 'chapter', 'line break']);
    assert.strictEqual(source.slice(inputs[1].start, inputs[1].end), '\\input{"quoted file"}');
    assert.deepStrictEqual(events.filter(event => event.type === 'heading').map(event => event.title), ['After']);
  });

  test('ignores inputs inside definitions and does not execute wrapper macros', () => {
    const source = String.raw`\newcommand\X{\input{a.tex}}
\newenvironment{wrapped}{\include{b}}{\input{c}}
\def\load{\input{d}}
\X\load
\input{\directory/x}
\section{Visible}`;
    assert.deepStrictEqual(parseStructureEvents(source).map(event => event.type), ['heading']);
  });

  test('ignores unbraced input forms and recovers later headings and braced inputs', () => {
    for (const unsupported of [
      String.raw`\input child.tex`,
      String.raw`\input "with space"`,
      String.raw`\input \dir/child.tex`
    ]) {
      const events = parseStructureEvents(unsupported + '\n\\section{Recovered}\n\\input{literal}');
      assert.deepStrictEqual(events.map(event => event.type), ['heading', 'include'], unsupported);
      assert.strictEqual(events[0].type === 'heading' && events[0].title, 'Recovered');
      assert.strictEqual(events[1].type === 'include' && events[1].path, 'literal');
    }
  });

  test('hides completed defaults and argument specifications when a definition body is missing', () => {
    for (const prefix of [
      String.raw`\newcommand{\custom}[1][\section{Fake}\label{fake}]`,
      String.raw`\NewDocumentCommand{\custom}{O{\section{Fake}\label{fake}}}`
    ]) {
      const events = parseStructureEvents(prefix + String.raw`\section{Real}`);
      assert.deepStrictEqual(events.map(event => event.type), ['heading']);
      assert.strictEqual(events[0].type === 'heading' ? events[0].title : undefined, 'Real');
    }
  });

  test('hides a closed theorem title while recovering after an unfinished trailing counter', () => {
    const source = '\\newtheorem{custom}{\\section{Fake}\\label{fake}}[unfinished\r\n\\section{Real}';
    const events = parseStructureEvents(source);
    assert.deepStrictEqual(events.map(event => event.type), ['heading']);
    assert.strictEqual(events[0].type === 'heading' ? events[0].title : undefined, 'Real');
  });

  test('hides closed syntax of definitions with invalid names', () => {
    for (const prefix of [
      String.raw`\newcommand{garbage\section{Fake}}`,
      String.raw`\newcommand{garbage}{\section{Fake}\label{fake}}`,
      String.raw`\NewDocumentCommand{garbage}{O{\section{Fake}}}{\label{fake}}`,
      String.raw`\newenvironment{\dynamic}{\section{Fake}}{\label{fake}}`,
      String.raw`\newtheorem{bad{name}}{\section{Fake}\label{fake}}[section]`
    ]) {
      const events = parseStructureEvents(prefix + String.raw`\section{Real}`);
      assert.deepStrictEqual(events.map(event => event.type), ['heading']);
      assert.strictEqual(events[0].type === 'heading' ? events[0].title : undefined, 'Real');
    }
  });

  test('recovers from unclosed titles and optional arguments', () => {
    const source = String.raw`\section{Unclosed
\subsection{Recovered}
\section[Unclosed short
\section{Also recovered}`;
    const headings = parseStructureEvents(source).filter(event => event.type === 'heading');
    assert.deepStrictEqual(headings.map(event => event.title), ['Recovered', 'Also recovered']);
  });

  test('normalizes formatting and labels while retaining math macros', () => {
    assert.strictEqual(structurePlainText(String.raw`\begin{verbatim}\end{verbatim}`), String.raw`\begin{verbatim}\end{verbatim}`);
    assert.strictEqual(structurePlainText(String.raw`A \textbf{bold} $\frac{x}{y}$ and \alpha \label{hidden}`), String.raw`A bold $\frac{x}{y}$ and \alpha`);
    assert.strictEqual(structurePlainText('First % hidden\n second'), 'First second');
    assert.strictEqual(structurePlainText(String.raw`\v{C}ech and \"O \LaTeX`), 'Cech and O LaTeX');
    assert.strictEqual(structurePlainText(String.raw`Code \verb|{%}| \label{hidden}`), 'Code {%}');
  });

  test('omits nested environment commands only when requested for display text', () => {
    const source = String.raw`\textbf{Title} \begin{aligned}a\begin{gathered}b\end{gathered}c\end{aligned}`;
    assert.strictEqual(structurePlainText(source), String.raw`Title \begin{aligned}a\begin{gathered}b\end{gathered}c\end{aligned}`);
    assert.strictEqual(structurePlainText(source, { omitEnvironmentCommands: true }), 'Title a b c');
  });

  test('omits environment commands with comments and CRLF before their names', () => {
    const source = 'x\\begin% \\begin{fake}\r\n{aligned}y\\end% closing\r\n{aligned}z';
    assert.strictEqual(structurePlainText(source, { omitEnvironmentCommands: true }), 'x y z');
  });

  test('preserves apparent environment commands inside inline literals', () => {
    const samples = [
      String.raw`\verb|\begin{fake}|`,
      String.raw`\lstinline[language=TeX]+\begin{fake}+`,
      String.raw`\mintinline{latex}|\begin{fake}|`
    ];
    for (const sample of samples) {
      const source = String.raw`\begin{aligned}` + sample + String.raw`\end{aligned}`;
      assert.strictEqual(structurePlainText(source, { omitEnvironmentCommands: true }), String.raw`\begin{fake}`, sample);
    }
  });

  test('preserves unknown macros and separates text at omitted environment boundaries', () => {
    const source = String.raw`\foo\begin{aligned}bar\end{aligned}baz\baz{qux}`;
    assert.strictEqual(structurePlainText(source, { omitEnvironmentCommands: true }), String.raw`\foo bar baz\baz{qux}`);
  });

  test('does not omit escaped commands or incomplete and dynamic environment names', () => {
    const samples = [
      String.raw`a\\begin{aligned}b`,
      String.raw`\begin{unfinished`,
      String.raw`\end{unfinished`,
      String.raw`\begin{\dynamic}x\end{\dynamic}`,
      String.raw`\begin{bad{name}}x\end{bad{name}}`
    ];
    for (const source of samples) {
      assert.strictEqual(structurePlainText(source, { omitEnvironmentCommands: true }), structurePlainText(source), source);
    }
  });

  test('recognizes only whitespace and comments as trivia', () => {
    assert.strictEqual(isStructureTrivia(' \r\n% comment\r\n\t% another'), true);
    assert.strictEqual(isStructureTrivia(String.raw`\%`), false);
    assert.strictEqual(isStructureTrivia(String.raw`\label{key}`), false);
  });
});
