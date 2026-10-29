import * as vscode from 'vscode';
import { findGreekCandidates, findGreekPreview, GreekEntry } from './GreekCatalog';

interface GreekSession {
  editor: vscode.TextEditor;
  position: vscode.Position;
  version: number;
  code: string;
  generation: number;
  committed: boolean;
}

interface GreekPickerItem extends vscode.QuickPickItem {
  entry: GreekEntry;
}

const activeContext = 'fortex.greekCompletionActive';

/** Keeps the entire abbreviation and preview outside the document until acceptance. */
export default class GreekCompletionController implements vscode.Disposable {
  private session: GreekSession | undefined;
  private committingSession: GreekSession | undefined;
  private generation = 0;
  private pending = Promise.resolve();
  private pendingActions = 0;
  private typingSubscriptions: vscode.Disposable[] = [];
  private disposed = false;
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    after: { color: new vscode.ThemeColor('editorGhostText.foreground'), fontStyle: 'italic' }
  });
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  private picker: { input: vscode.QuickPick<GreekPickerItem>; subscriptions: vscode.Disposable[] } | undefined;
  private readonly subscriptions: vscode.Disposable[];

  public constructor() {
    this.status.name = 'Fortex Greek completion';
    this.subscriptions = [
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === this.session?.editor.document && event.contentChanges.length > 0) {
          this.cancel();
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (document === this.session?.editor.document) {
          this.cancel();
        }
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === this.session?.editor && !this.selectionMatches(this.session)) {
          this.cancel();
        }
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (this.session && editor !== this.session.editor) {
          this.cancel();
        }
      }),
      vscode.window.onDidChangeWindowState((state) => {
        if (!state.focused && this.session) {
          this.cancel();
        }
      })
    ];
  }

  public start(): Promise<void> {
    return this.run(async () => {
      this.cancel();
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'latex' || editor.document.isClosed
        || vscode.workspace.fs.isWritableFileSystem(editor.document.uri.scheme) === false) {
        return;
      }
      if (editor.selections.length !== 1 || !editor.selection.isEmpty) {
        vscode.window.setStatusBarMessage('Greek completion requires a single cursor with no selection.', 4000);
        return;
      }
      if (!this.captureTyping()) {
        return;
      }
      this.session = {
        editor, position: editor.selection.active, version: editor.document.version,
        code: '', generation: this.generation, committed: false
      };
      this.render(this.session);
      await vscode.commands.executeCommand('setContext', activeContext, true);
      await vscode.commands.executeCommand('hideSuggestWidget');
    });
  }

  public input(args: { text?: string } = {}): Promise<void> {
    const session = this.session ?? this.committingSession;
    return this.run(async () => {
      const text = args.text;
      if (!text || text.length !== 1 || !/^[\x21-\x7e]$/.test(text)) {
        return;
      }
      if (!session) {
        return;
      }
      if (this.session !== session) {
        await this.replay(session, 'type', { text });
        return;
      }
      if (!this.valid(session)) {
        this.cancel();
        return;
      }
      const nextCode = session.code + text;
      if (findGreekPreview(nextCode)) {
        session.code = nextCode;
        this.render(session);
      } else {
        await this.insert(session, findGreekPreview(session.code)?.command, text);
      }
    });
  }

  public commit(args: { text?: string } = {}): Promise<void> {
    const session = this.session ?? this.committingSession;
    return this.run(async () => {
      if (session && this.session === session) {
        await this.insert(session, findGreekPreview(session.code)?.command, args.text === ' ' ? ' ' : '');
      } else if (session) {
        await this.replay(session, 'type', { text: args.text === ' ' ? ' ' : '\n' });
      }
    });
  }

  public backspace(): Promise<void> {
    const session = this.session ?? this.committingSession;
    return this.run(async () => {
      if (!session) {
        return;
      }
      if (this.session !== session) {
        await this.replay(session, 'deleteLeft');
        return;
      }
      if (!this.valid(session) || !session.code) {
        this.cancel();
        return;
      }
      session.code = session.code.slice(0, -1);
      this.render(session);
    });
  }

  public showCandidates(): Promise<void> {
    const session = this.session ?? this.committingSession;
    return this.run(async () => {
      if (!session) {
        return;
      }
      if (this.session !== session) {
        await this.replay(session, 'tab');
        return;
      }
      if (!this.valid(session)) {
        this.cancel();
        return;
      }
      this.closePicker();
      const input = vscode.window.createQuickPick<GreekPickerItem>();
      const subscriptions: vscode.Disposable[] = [];
      this.picker = { input, subscriptions };
      input.title = 'Fortex: Greek letters';
      input.placeholder = 'YaTeX abbreviation (case-sensitive)';
      input.value = session.code;
      const update = () => {
        input.items = findGreekCandidates(input.value).map((entry) => ({
          label: entry.command, description: entry.code, alwaysShow: true, entry
        }));
        const preview = findGreekPreview(input.value);
        const active = input.items.find((item) => item.entry === preview) ?? input.items[0];
        input.activeItems = active ? [active] : [];
      };
      subscriptions.push(
        input.onDidChangeValue(update),
        input.onDidAccept(() => {
          const entry = (input.selectedItems[0] ?? input.activeItems[0])?.entry;
          if (entry) {
            this.closePicker();
            void this.run(() => this.insert(session, entry.command));
          }
        }),
        input.onDidHide(() => this.cancel())
      );
      update();
      input.show();
    });
  }

  public cancel(): void {
    // Invalidate even already queued input from a session whose commit has ended.
    this.generation++;
    void this.clearPreview();
    this.releaseTyping();
  }

  private clearPreview(): Thenable<unknown> {
    const session = this.session;
    this.session = undefined;
    this.closePicker();
    if (session) {
      session.editor.setDecorations(this.decoration, []);
    }
    this.status.hide();
    return vscode.commands.executeCommand('setContext', activeContext, false);
  }

  public dispose(): void {
    this.cancel();
    this.disposed = true;
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.decoration.dispose();
    this.status.dispose();
  }

  private selectionMatches(session: GreekSession): boolean {
    const selections = session.editor.selections;
    return selections.length === 1 && selections[0].isEmpty && selections[0].active.isEqual(session.position);
  }

  private valid(session: GreekSession): boolean {
    return this.session === session && session.generation === this.generation
      && !session.editor.document.isClosed
      && session.editor.document.version === session.version
      && vscode.window.activeTextEditor === session.editor && this.selectionMatches(session);
  }

  private render(session: GreekSession): void {
    const preview = findGreekPreview(session.code)?.command;
    session.editor.setDecorations(this.decoration, [{
      range: new vscode.Range(session.position, session.position),
      renderOptions: { after: { contentText: preview ?? '⟨Greek⟩' } }
    }]);
    this.status.text = `Greek: ${session.code || '…'}${preview ? ` → ${preview}` : ''}`;
    this.status.tooltip = 'Enter: insert · Esc: cancel · Backspace: edit abbreviation · Tab: list candidates';
    this.status.show();
  }

  private async insert(session: GreekSession, command?: string, suffix = ''): Promise<void> {
    if (!this.valid(session)) {
      this.cancel();
      return;
    }
    const nextText = suffix || session.editor.document.lineAt(session.position.line).text.slice(session.position.character);
    // TeX control words must not absorb an immediately following Latin letter.
    const separator = command && /^[a-zA-Z]/.test(nextText) ? ' ' : '';
    const text = (command ?? '') + separator + suffix;
    this.committingSession = session;
    try {
      // Keep dispatches tied to this session until the context update and edit finish.
      await this.clearPreview();
      if (session.generation !== this.generation
        || session.editor.document.isClosed || session.editor.document.version !== session.version
        || vscode.window.activeTextEditor !== session.editor || !this.selectionMatches(session)) {
        this.cancel();
        return;
      }
      let applied: boolean;
      if (/^[([{]$/.test(suffix)) {
        applied = await this.insertWithBracket(session, (command ?? '') + separator, suffix);
      } else if (/^[)\]}]$/.test(suffix)) {
        applied = await this.insertWithClosingBracket(session, text);
      } else {
        applied = !text || await session.editor.insertSnippet(
          new vscode.SnippetString().appendText(text), session.position,
          { undoStopBefore: true, undoStopAfter: true }
        );
      }
      if (applied) {
        session.committed = true;
      } else {
        this.cancel();
      }
    } finally {
      if (this.committingSession === session) {
        this.committingSession = undefined;
      }
    }
  }

  private async replay(session: GreekSession, command: string, args?: { text: string }): Promise<void> {
    // Replay only keys captured before a normal commit finished. Explicit cancellation,
    // a new session, or changing editors must never send old keys into another context.
    if (!session.committed || session.generation !== this.generation || this.session
      || session.editor.document.isClosed
      || vscode.window.activeTextEditor !== session.editor
      || session.editor.document.languageId !== 'latex'
      || session.editor.selections.length !== 1 || !session.editor.selection.isEmpty) {
      return;
    }
    await vscode.commands.executeCommand(command === 'type' ? 'default:type' : command, ...(args ? [args] : []));
  }

  private async insertWithBracket(session: GreekSession, prefix: string, bracket: string): Promise<boolean> {
    const editor = session.editor;
    // Native opening-bracket input places its own undo stop. Type it first, then
    // prepend the command to the same undo group; native auto-close/caret tracking survives.
    const prepared = await editor.edit(edit => edit.insert(session.position, ''), { undoStopBefore: true, undoStopAfter: false });
    if (!prepared || session.generation !== this.generation || vscode.window.activeTextEditor !== editor
      || editor.document.isClosed
      || editor.document.version !== session.version || !this.selectionMatches(session)) {
      return false;
    }
    await vscode.commands.executeCommand('default:type', { text: bracket });
    if (session.generation !== this.generation || vscode.window.activeTextEditor !== editor
      || editor.document.isClosed || editor.document.version !== session.version + 1
      || editor.selections.length !== 1 || !editor.selection.isEmpty
      || !editor.selection.active.isEqual(session.position.translate(0, 1))
      || editor.document.getText(new vscode.Range(session.position, session.position.translate(0, 1))) !== bracket) {
      return false;
    }
    return editor.edit(edit => edit.insert(session.position, prefix), { undoStopBefore: false, undoStopAfter: true });
  }

  private async insertWithClosingBracket(session: GreekSession, text: string): Promise<boolean> {
    const editor = session.editor;
    const prepared = await editor.edit(edit => edit.insert(session.position, ''), { undoStopBefore: true, undoStopAfter: false });
    if (!prepared || session.generation !== this.generation || vscode.window.activeTextEditor !== editor
      || editor.document.isClosed || editor.document.version !== session.version || !this.selectionMatches(session)) {
      return false;
    }
    // Type the whole control word and closer natively so overtype/electric-indent
    // see the committed word. Unlike an opener, a closer keeps this typing undo group.
    await vscode.commands.executeCommand('default:type', { text });
    if (session.generation !== this.generation || vscode.window.activeTextEditor !== editor || editor.document.isClosed) {
      return false;
    }
    return editor.edit(edit => edit.insert(editor.selection.active, ''), { undoStopBefore: false, undoStopAfter: true });
  }

  private captureTyping(): boolean {
    if (this.typingSubscriptions.length) {
      return true;
    }
    try {
      // Receive layout-translated text, not physical key names (notably ^/_ on JIS/US).
      this.typingSubscriptions.push(vscode.commands.registerCommand('type', (args: { text: string }) => {
        const session = this.session ?? this.committingSession;
        if (!session) {
          // Preserve order for text arriving while the last queued commit is finishing.
          const editor = vscode.window.activeTextEditor;
          const generation = this.generation;
          return this.run(async () => {
            if (editor && vscode.window.activeTextEditor === editor && generation === this.generation) {
              await vscode.commands.executeCommand('default:type', args);
            }
          });
        }
        if (!this.picker && vscode.window.activeTextEditor === session.editor && args?.text === ' ') {
          return this.commit({ text: ' ' });
        }
        if (!this.picker && vscode.window.activeTextEditor === session.editor
          && typeof args?.text === 'string' && /^[\x21-\x7e]$/.test(args.text)) {
          return this.input(args);
        }
        // IME/non-ASCII/bulk input remains ordinary editor input, with no preview committed.
        this.cancel();
        return vscode.commands.executeCommand('default:type', args);
      }));
      this.typingSubscriptions.push(vscode.commands.registerCommand('compositionStart', (args: unknown) => {
        this.cancel();
        return vscode.commands.executeCommand('default:compositionStart', args);
      }));
      return true;
    } catch {
      this.releaseTyping();
      void vscode.window.showWarningMessage('Greek input could not start because another extension is handling typing.');
      return false;
    }
  }

  private releaseTyping(): void {
    for (const subscription of this.typingSubscriptions) {
      subscription.dispose();
    }
    this.typingSubscriptions = [];
  }

  private closePicker(): void {
    const picker = this.picker;
    this.picker = undefined;
    if (picker) {
      for (const subscription of picker.subscriptions) {
        subscription.dispose();
      }
      picker.input.hide();
      picker.input.dispose();
    }
  }

  private run(action: () => void | Promise<void>): Promise<void> {
    this.pendingActions++;
    const next = this.pending.then(() => { if (!this.disposed) { return action(); } }).finally(() => {
      this.pendingActions--;
      if (!this.session && this.pendingActions === 0) {
        this.releaseTyping();
      }
    });
    this.pending = next.catch(() => undefined);
    return next;
  }
}
