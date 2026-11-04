import * as assert from 'assert';
import { discoverBibReferences } from '../completion/citation/BibFileDiscovery';

suite('Shared bibliography declarations', () => {
  test('uses declaration order, nested options, stars and comment continuations', () => {
    const source = [
      '\\addbibresource*[label={A [nested] label}]{first.bib}',
      '\\bibliography{sec% ignored\r\nond, first, library/third}',
      '\\addbibresource{a,comma.bib}'
    ].join('\r\n');
    assert.deepStrictEqual(discoverBibReferences(source), ['first.bib', 'second.bib', 'library/third.bib', 'a,comma.bib']);
  });

  test('excludes literals, escaped and dynamic declarations and recovers later files', () => {
    const source = [
      '% \\bibliography{commented}',
      '\\verb|\\bibliography{inline}|',
      '\\begin{minted}{tex}\\addbibresource{literal}\\end{minted}',
      '\\\\bibliography{escaped}',
      '\\bibliography{\\generated,#1,nested{path},$math}',
      '\\addbibresource[unfinished',
      '\\bibliography{recovered}'
    ].join('\r\n');
    assert.deepStrictEqual(discoverBibReferences(source), ['recovered.bib']);
  });

  test('preserves filename case and removes only exact reference duplicates', () => {
    const source = String.raw`\bibliography{Refs,refs,Refs,Refs.bib,Refs.BIB}
\addbibresource{refs.bib}
\addbibresource{Refs.BIB}`;
    assert.deepStrictEqual(discoverBibReferences(source), ['Refs.bib', 'refs.bib', 'Refs.BIB']);
  });

  test('does not turn nested macro argument fragments into bibliography filenames', () => {
    const source = [
      '\\bibliography{before,',
      ' \\choose{a,b,{c,d},\\nested{e,f,g}}, % ignored comma , {',
      ' af% ignored comma and brace , }',
      'ter, final}',
      '\\addbibresource{literal,comma.bib}'
    ].join('\r\n');
    assert.deepStrictEqual(discoverBibReferences(source), ['before.bib', 'after.bib', 'final.bib', 'literal,comma.bib']);
  });
});
