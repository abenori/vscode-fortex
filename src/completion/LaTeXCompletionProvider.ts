import * as vscode from 'vscode';
import CitationCompletionProvider from './citation/CitationCompletionProvider';
import CommandCompletionProvider from './command/CommandCompletionProvider';
import { findCompletionContext } from './CompletionContext';
import EnvironmentCompletionProvider from './environment/EnvironmentCompletionProvider';
import LabelCompletionProvider from './reference/LabelCompletionProvider';

interface CompletionProviders {
  reference: Pick<LabelCompletionProvider, 'complete'>;
  citation: Pick<CitationCompletionProvider, 'complete'>;
  environment: Pick<EnvironmentCompletionProvider, 'complete'>;
  command: Pick<CommandCompletionProvider, 'complete'>;
}

/** Reads the current line once and invokes only the matching candidate provider. */
export default class LaTeXCompletionProvider implements vscode.CompletionItemProvider {
  public constructor(private readonly providers: CompletionProviders) {}

  public provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.CompletionList> {
    if (token.isCancellationRequested) {
      return undefined;
    }
    const line = document.lineAt(position.line);
    const lineOffset = document.offsetAt(line.range.start);
    const context = findCompletionContext(line.text, position.character, lineOffset);
    switch (context?.kind) {
      case 'reference':
        return this.providers.reference.complete(document, position, context, token);
      case 'citation':
        return this.providers.citation.complete(document, position, context, token);
      case 'environment':
        return this.providers.environment.complete(document, position, context, token);
      case 'command':
        return this.providers.command.complete(document, position, context, token);
      default:
        return undefined;
    }
  }
}
