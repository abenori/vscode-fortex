/** Completion-only text collection. Outer comments/literals/definitions are searchable. */
export interface RawLabel { key: string; offset: number; end: number }
export interface RawCommand { name: string; argumentCount: number; optionalFirstArgument: boolean }
interface Argument { start: number; end: number; text: string }

/** Balances arguments while honoring comments and escaped delimiters inside them. */
class ArgumentReader {
  constructor(readonly source: string) {}

  trivia(offset: number): number {
    while (offset < this.source.length) {
      if (/\s/.test(this.source[offset])) { offset++; }
      else if (this.source[offset] === '%') { offset = this.afterComment(offset); }
      else { break; }
    }
    return offset;
  }

  argument(offset: number, opening: '{' | '[' = '{'): Argument | undefined {
    const start = this.trivia(offset);
    if (this.source[start] !== opening) { return undefined; }
    const stack: string[] = [opening === '{' ? '}' : ']'];
    const parts: string[] = [];
    let part = start + 1;
    for (let cursor = part; cursor < this.source.length; cursor++) {
      const character = this.source[cursor];
      if (character === '\\') { cursor++; continue; }
      if (character === '%') {
        parts.push(this.source.slice(part, cursor));
        cursor = this.afterComment(cursor) - 1;
        part = cursor + 1;
        continue;
      }
      if (character === '{') { stack.push('}'); }
      else if (opening === '[' && character === '[' && stack.at(-1) !== '}') { stack.push(']'); }
      else if (character === stack.at(-1)) {
        stack.pop();
        if (stack.length === 0) {
          parts.push(this.source.slice(part, cursor));
          return { start, end: cursor + 1, text: parts.join('') };
        }
      }
    }
    return undefined;
  }

  private afterComment(offset: number): number {
    while (offset < this.source.length && this.source[offset] !== '\r' && this.source[offset] !== '\n') { offset++; }
    if (this.source[offset] === '\r') { offset++; }
    if (this.source[offset] === '\n') { offset++; }
    return offset;
  }
}

export function collectRawLabels(source: string): RawLabel[] {
  const reader = new ArgumentReader(source);
  const pattern = /\\label(?![A-Za-z@])/g;
  const labels: RawLabel[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const argument = reader.argument(pattern.lastIndex);
    const key = argument?.text.trim();
    if (argument && key) { labels.push({ key, offset: match.index, end: argument.end }); }
  }
  return labels;
}

const classicCommands = new Set(['newcommand', 'renewcommand', 'providecommand', 'DeclareRobustCommand']);
const documentCommands = new Set(['NewDocumentCommand', 'RenewDocumentCommand', 'ProvideDocumentCommand',
  'DeclareDocumentCommand', 'NewExpandableDocumentCommand', 'RenewExpandableDocumentCommand',
  'ProvideExpandableDocumentCommand', 'DeclareExpandableDocumentCommand']);
const primitiveCommands = new Set(['def', 'gdef', 'edef', 'xdef']);
const environmentCommands = new Set(['newenvironment', 'renewenvironment', 'provideenvironment',
  'NewDocumentEnvironment', 'RenewDocumentEnvironment', 'ProvideDocumentEnvironment', 'DeclareDocumentEnvironment', 'newtheorem']);

/** Last textual declaration wins; xparse signatures remain name-only. */
export function collectRawCommands(source: string): RawCommand[] {
  const reader = new ArgumentReader(source);
  const pattern = /\\([A-Za-z@]+)/g;
  const commands = new Map<string, RawCommand>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const declaration = match[1];
    if (!classicCommands.has(declaration) && !documentCommands.has(declaration)
      && !primitiveCommands.has(declaration) && declaration !== 'DeclareMathOperator') { continue; }
    let cursor = reader.trivia(pattern.lastIndex);
    if (source[cursor] === '*') { cursor = reader.trivia(cursor + 1); }
    const grouped = !primitiveCommands.has(declaration) ? reader.argument(cursor) : undefined;
    const rawName = grouped?.text.trim() ?? source.slice(cursor).match(/^\\[A-Za-z@]+/)?.[0];
    if (!rawName || !/^\\[A-Za-z@]+$/.test(rawName)) { continue; }
    const name = rawName.slice(1);
    cursor = grouped?.end ?? cursor + rawName.length;
    let argumentCount = 0;
    let optionalFirstArgument = false;
    if (classicCommands.has(declaration)) {
      const count = reader.argument(cursor, '[');
      if (count) {
        if (!/^[0-9]$/.test(count.text.trim())) { continue; }
        argumentCount = Number(count.text.trim());
        cursor = count.end;
        const defaultArgument = reader.argument(cursor, '[');
        optionalFirstArgument = Boolean(defaultArgument && argumentCount > 0);
      }
    } else if (primitiveCommands.has(declaration)) {
      let parameters = '';
      cursor = reader.trivia(cursor);
      while (cursor < source.length && source[cursor] !== '{') {
        const next = reader.trivia(cursor);
        if (next !== cursor) { cursor = next; continue; }
        parameters += source[cursor++];
      }
      for (const parameter of parameters.matchAll(/#([1-9])/g)) { argumentCount = Math.max(argumentCount, Number(parameter[1])); }
    }
    commands.set(name, { name, argumentCount, optionalFirstArgument });
  }
  return [...commands.values()];
}

/** Includes named uses and supported declarations even in examples/comments. */
export function collectRawEnvironments(source: string): string[] {
  const reader = new ArgumentReader(source);
  const names = new Set<string>();
  const pattern = /\\([A-Za-z@]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    if (match[1] !== 'begin' && match[1] !== 'end' && !environmentCommands.has(match[1])) { continue; }
    let cursor = reader.trivia(pattern.lastIndex);
    if (source[cursor] === '*') { cursor++; }
    const argument = reader.argument(cursor);
    const name = argument?.text.trim();
    if (name && !/[\\{}\s]/.test(name)) { names.add(name); }
  }
  return [...names];
}
