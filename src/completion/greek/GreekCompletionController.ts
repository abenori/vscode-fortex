import * as vscode from 'vscode';
import { findGreekCandidates, findGreekPreview, GreekEntry } from './GreekCatalog';

interface GreekSession {
  /** 入力開始時の対象エディタ． */
  editor: vscode.TextEditor;
  /** 入力開始時の文書内の位置． */
  position: vscode.Position;
  /** ソースを読み取った時点または投影を計算した時点の文書版番号． */
  version: number;
  /** 大文字小文字を区別するギリシャ文字の略記． */
  code: string;
  /** 古い非同期結果を識別して無視するための世代番号． */
  generation: number;
  /** この入力セッションの挿入を確定済みである場合はtrue． */
  committed: boolean;
}

interface GreekPickerItem extends vscode.QuickPickItem {
  /** 表示項目に対応する元の解析データ． */
  entry: GreekEntry;
}

const activeContext = 'fortex.greekCompletionActive';

/** 確定するまでは，略記とプレビューの全体を文書に書き込まずに保持する． */
export default class GreekCompletionController implements vscode.Disposable {
  /** 補完候補の読み込みと監視を共有するセッション． */
  private session: GreekSession | undefined;
  /** 文書への挿入を実行している入力セッション． */
  private committingSession: GreekSession | undefined;
  /** 古い非同期結果を識別して無視するための世代番号． */
  private generation = 0;
  /** 入力操作の順序を保つための末尾のPromise． */
  private pending = Promise.resolve();
  /** 順番待ちまたは実行中の入力操作の数． */
  private pendingActions = 0;
  /** ギリシャ文字入力中だけ登録する文字入力コマンド． */
  private typingSubscriptions: vscode.Disposable[] = [];
  /** 所有するリソースを解放し，新しい要求を受け付けない場合はtrue． */
  private disposed = false;
  /** 未確定のギリシャ文字を文書へ書き込まずに表示する装飾． */
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    after: { color: new vscode.ThemeColor('editorGhostText.foreground'), fontStyle: 'italic' }
  });
  /** 状態の識別値，または現在の状態を表示するUI項目． */
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  /** 現在開いている候補選択とその購読． */
  private picker: {
    /** 候補を表示して入力を受け取るQuickPick． */
    input: vscode.QuickPick<GreekPickerItem>;
    /** 所有者の終了時に解除するイベント購読． */
    subscriptions: vscode.Disposable[]
  } | undefined;
  /** 所有者の終了時に解除するイベント購読． */
  private readonly subscriptions: vscode.Disposable[];

  /**
   * GreekCompletionControllerの初期状態と所有するリソースを準備する．
   * 引数はない．
   * @returns 新しいインスタンス．コンストラクタから明示的な値は返さない．
   */
  public constructor() {
    this.status.name = 'fortex Greek completion';
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

  /**
   * 現在のカーソル位置でギリシャ文字の略記入力を開始する．
   * 引数はない．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
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

  /**
   * 入力文字をギリシャ文字の略記へ反映する．
   * @param args 入力または確定時に追加入力するtextを持つコマンド引数．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
  public input(args: {
    /** この範囲に対応する文字列． */
    text?: string
  } = {}): Promise<void> {
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

  /**
   * プレビュー中のギリシャ文字を文書へ確定する．
   * @param args 入力または確定時に追加入力するtextを持つコマンド引数．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
  public commit(args: {
    /** この範囲に対応する文字列． */
    text?: string
  } = {}): Promise<void> {
    const session = this.session ?? this.committingSession;
    return this.run(async () => {
      if (session && this.session === session) {
        await this.insert(session, findGreekPreview(session.code)?.command, args.text === ' ' ? ' ' : '');
      } else if (session) {
        await this.replay(session, 'type', { text: args.text === ' ' ? ' ' : '\n' });
      }
    });
  }

  /**
   * ギリシャ文字の略記を1文字戻し，空なら入力モードを終了する．
   * 引数はない．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
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

  /**
   * 現在の略記に対応するギリシャ文字の候補選択を表示する．
   * 引数はない．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
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
      input.title = 'fortex: Greek letters';
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

  /**
   * ギリシャ文字の入力と候補選択を取り消す．
   * 引数はない．
   * @returns なし．
   */
  public cancel(): void {
    // 確定済みのセッションに属する入力は，待機列に入っているものも無効にする．
    this.generation++;
    void this.clearPreview();
    this.releaseTyping();
  }

  /**
   * ギリシャ文字のプレビューと入力モードの表示を解除する．
   * 引数はない．
   * @returns 入力モードのコンテキスト更新が完了するThenable．Promiseで返す．
   */
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

  /**
   * 所有する監視・購読・表示などのリソースを解放する．
   * 引数はない．
   * @returns なし．
   */
  public dispose(): void {
    this.cancel();
    this.disposed = true;
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.decoration.dispose();
    this.status.dispose();
  }

  /**
   * 入力開始位置と現在の選択範囲が一致するかを調べる．
   * @param session 入力元エディタ，開始位置，文書版，略記，および確定状態．
   * @returns 同じエディタの同じ空の選択範囲にいる場合はtrue．
   */
  private selectionMatches(session: GreekSession): boolean {
    const selections = session.editor.selections;
    return selections.length === 1 && selections[0].isEmpty && selections[0].active.isEqual(session.position);
  }

  /**
   * 入力開始後に文書や選択位置が変わっていないことを確認する．
   * @param session 入力元エディタ，開始位置，文書版，略記，および確定状態．
   * @returns 現在の入力セッションを続行できる場合はtrue．
   */
  private valid(session: GreekSession): boolean {
    return this.session === session && session.generation === this.generation
      && !session.editor.document.isClosed
      && session.editor.document.version === session.version
      && vscode.window.activeTextEditor === session.editor && this.selectionMatches(session);
  }

  /**
   * 略記に対応するギリシャ文字のプレビューとステータス表示を更新する．
   * @param session 入力元エディタ，開始位置，文書版，略記，および確定状態．
   * @returns なし．
   */
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

  /**
   * 選択したギリシャ文字のコマンドと後続文字を文書へ挿入する．
   * @param session 入力元エディタ，開始位置，文書版，略記，および確定状態．
   * @param command 実行または解析するコマンド．省略可能．
   * @param suffix 確定したコマンドの後へ挿入する文字列．省略時は''．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
  private async insert(session: GreekSession, command?: string, suffix = ''): Promise<void> {
    if (!this.valid(session)) {
      this.cancel();
      return;
    }
    const nextText = suffix || session.editor.document.lineAt(session.position.line).text.slice(session.position.character);
    // TeXの制御綴が直後のラテン文字まで取り込まないようにする．
    const separator = command && /^[a-zA-Z]/.test(nextText) ? ' ' : '';
    const text = (command ?? '') + separator + suffix;
    this.committingSession = session;
    try {
      // コンテキストの更新と編集が終わるまで，入力操作をこのセッションに関連付けておく．
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

  /**
   * 入力モードを終え，保留していた通常のエディタ操作を再実行する．
   * @param session 入力元エディタ，開始位置，文書版，略記，および確定状態．
   * @param command 実行または解析するコマンド．
   * @param args 入力または確定時に追加入力するtextを持つコマンド引数．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
  private async replay(session: GreekSession, command: string, args?: {
    /** この範囲に対応する文字列． */
    text: string
  }): Promise<void> {
    // 通常の確定が終わる前に捕捉したキーだけを再実行する．明示的な取消し，新しいセッション，エディタの変更後に，古いキーを別の入力先へ送らない．
    if (!session.committed || session.generation !== this.generation || this.session
      || session.editor.document.isClosed
      || vscode.window.activeTextEditor !== session.editor
      || session.editor.document.languageId !== 'latex'
      || session.editor.selections.length !== 1 || !session.editor.selection.isEmpty) {
      return;
    }
    await vscode.commands.executeCommand(command === 'type' ? 'default:type' : command, ...(args ? [args] : []));
  }

  /**
   * 開き括弧の入力に合わせてギリシャ文字と括弧を挿入する．
   * @param session 入力元エディタ，開始位置，文書版，略記，および確定状態．
   * @param prefix 括弧の前へ挿入するコマンド文字列．
   * @param bracket 入力された開き括弧．
   * @returns 括弧を含む挿入を処理できた場合はtrue．Promiseで返す．
   */
  private async insertWithBracket(session: GreekSession, prefix: string, bracket: string): Promise<boolean> {
    const editor = session.editor;
    // 開き括弧の通常入力は元に戻す操作の区切りを作る．先に括弧を入力し，同じ編集単位の先頭へコマンドを追加して，自動閉じ括弧とカーソル追従を保つ．
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

  /**
   * 閉じ括弧の入力に合わせてギリシャ文字の確定とカーソル移動を行う．
   * @param session 入力元エディタ，開始位置，文書版，略記，および確定状態．
   * @param text 処理対象の文字列．
   * @returns 閉じ括弧の入力を処理できた場合はtrue．Promiseで返す．
   */
  private async insertWithClosingBracket(session: GreekSession, text: string): Promise<boolean> {
    const editor = session.editor;
    const prepared = await editor.edit(edit => edit.insert(session.position, ''), { undoStopBefore: true, undoStopAfter: false });
    if (!prepared || session.generation !== this.generation || vscode.window.activeTextEditor !== editor
      || editor.document.isClosed || editor.document.version !== session.version || !this.selectionMatches(session)) {
      return false;
    }
    // コマンド全体と閉じ括弧を通常の入力で渡し，既存の閉じ括弧を飛ばす操作や自動字下げに確定済みの綴りを認識させる．閉じ括弧の入力は同じ編集単位にまとめる．
    await vscode.commands.executeCommand('default:type', { text });
    if (session.generation !== this.generation || vscode.window.activeTextEditor !== editor || editor.document.isClosed) {
      return false;
    }
    return editor.edit(edit => edit.insert(editor.selection.active, ''), { undoStopBefore: false, undoStopAfter: true });
  }

  /**
   * 通常の文字入力をギリシャ文字入力へ渡すコマンドを登録する．
   * 引数はない．
   * @returns 入力の捕捉に成功した場合はtrue．
   */
  private captureTyping(): boolean {
    if (this.typingSubscriptions.length) {
      return true;
    }
    try {
      // 物理キー名ではなく，キーボード配列で変換済みの文字を受け取る．特にJIS・US配列の^と_を考慮する．
      this.typingSubscriptions.push(vscode.commands.registerCommand('type', (args: {
        /** この範囲に対応する文字列． */
        text: string
      }) => {
        const session = this.session ?? this.committingSession;
        if (!session) {
          // 直前の確定処理が終了する間に届いた文字も，入力順を保つ．
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
        // IME，非ASCII文字，まとめて入力された文字列は通常の編集として扱い，プレビューを確定しない．
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

  /**
   * ギリシャ文字入力中に登録した文字入力コマンドを解除する．
   * 引数はない．
   * @returns なし．
   */
  private releaseTyping(): void {
    for (const subscription of this.typingSubscriptions) {
      subscription.dispose();
    }
    this.typingSubscriptions = [];
  }

  /**
   * 候補選択と，それに付随するイベント購読を閉じる．
   * 引数はない．
   * @returns なし．
   */
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

  /**
   * ギリシャ文字入力の操作を直前の操作の後へ直列化する．
   * @param action 実行する処理．
   * @returns 処理の完了を表すPromise．値は返さない．
   */
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
