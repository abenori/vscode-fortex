import * as assert from 'assert';
import { collectRawCommands, collectRawEnvironments, collectRawLabels } from '../completion/RawCompletionCollector';

suite('Completion-only textual collection', () => {
  test('includes labels in comments, literals and definitions without changing strict parsing', () => {
    const source = [
      String.raw`% \label{comment}`,
      String.raw`\verb|\label{inline}|`,
      String.raw`\begin{verbatim}\label{literal}\end{verbatim}`,
      String.raw`\newcommand{\sample}{\label{definition}}`,
      String.raw`\labelled{wrong}\label{live}\label{}\label{unfinished`
    ].join('\r\n');
    assert.deepStrictEqual(collectRawLabels(source).map(label => label.key), ['comment', 'inline', 'literal', 'definition', 'live']);
  });

  test('balances nested and escaped braces and removes internal TeX comments', () => {
    const source = '😀\\label % before\r\n { sec:in% ignored }\r\ntro{nested}\\{escaped\\} }\r\n'
      + '\\label{sec:next}';
    const labels = collectRawLabels(source);
    assert.deepStrictEqual(labels.map(label => label.key), [String.raw`sec:intro{nested}\{escaped\}`, 'sec:next']);
    assert.strictEqual(labels[0].offset, 2);
    assert.strictEqual(source.slice(labels[1].offset, labels[1].end), '\\label{sec:next}');
  });

  test('collects supported command signatures even inside examples and nested definitions', () => {
    const source = [
      String.raw`% \newcommand{\comment}[2][{a]b}]{#1#2}`,
      '\\renewcommand % name\r\n{\\multi}\r\n[1% close ] ignored\r\n]\r\n{#1}',
      String.raw`\verb|\DeclareMathOperator{\literal}{op}|`,
      String.raw`\newcommand{\outer}{\newcommand{\inner}[3]{}}`,
      String.raw`\NewDocumentCommand{\documentcmd}{O{a}m}{}`,
      String.raw`\def\primitive#1,#2{#1#2}`,
      String.raw`\renewcommand{\multi}[2]{#1#2}`,
      String.raw`\newcommandExtra{\wrong}{}`
    ].join('\n');
    const commands = collectRawCommands(source);
    assert.deepStrictEqual(commands.map(command => command.name), ['comment', 'multi', 'literal', 'outer', 'inner', 'documentcmd', 'primitive']);
    assert.deepStrictEqual(commands.find(command => command.name === 'comment'), { name: 'comment', argumentCount: 2, optionalFirstArgument: true });
    assert.strictEqual(commands.find(command => command.name === 'multi')?.argumentCount, 2);
    assert.strictEqual(commands.find(command => command.name === 'primitive')?.argumentCount, 2);
    assert.strictEqual(commands.find(command => command.name === 'documentcmd')?.argumentCount, 0);
  });

  test('collects named uses and environment/theorem definitions from raw source', () => {
    const source = [
      String.raw`% \newenvironment{commented}{}{}`,
      String.raw`\verb|\NewDocumentEnvironment{literal}{m}{}{}|`,
      '\\newtheorem* % title\r\n{my% ignored }\r\nclaim}{Claim}',
      String.raw`\begin{used}\end{used}\end{endonly}`,
      String.raw`\beginning{wrong}\newenvironment{contains space}{}{}`
    ].join('\n');
    assert.deepStrictEqual(collectRawEnvironments(source), ['commented', 'literal', 'myclaim', 'used', 'endonly']);
  });
});
