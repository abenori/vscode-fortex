# vscode-fortex

## Build security

Run **Build LaTeX Project** from the Command Palette or press `Ctrl+T T T`. For this shortcut and the PDF shortcuts below, press `Ctrl+T`, release Ctrl, then press the remaining keys without Shift.

Builds and PDF previews discover their main file from saved source files. Builds also obtain the document class, input files, and build directives from those saved sources. Save changes to `%#main`, `\documentclass`, `\input`, `\include`, and `%#` build directives before using them. Editing can continue while discovery runs: each discovery reads a source once and uses the main-file strategy order captured at its start. Later edits or configuration changes are used by the next request.

Programs named by source-file build directives such as `%#!`, `%#bibtex`, `%#makeindex`, and `%#dvipdf` must be listed in `vscode-fortex.compile.allowedPrograms`. The default list contains common TeX engines and helper programs. Matching is exact; add another program explicitly when a document needs it. An empty list rejects every `%#`-selected program, while adding `*` permits any program. The setting is machine-scoped so an opened workspace cannot silently widen its own permissions.

Fortex parses `%#!` command lines itself and starts the executable with `shell: false`. Quotes may be used for arguments containing spaces. Shell operators such as `|`, `&&`, `<`, and `>` are passed as ordinary arguments and are not interpreted. Semicolons outside quotes retain their existing meaning as separators between build actions. All programs named by `%#` directives are checked before the first build process starts. Programs selected without a `%#` directive are not restricted by this setting.

LaTeX builds, PDF previews, SyncTeX, SumatraPDF, `kpsewhich`, and `texdoc` execution run only when VS Code trusts the current workspace. In Restricted Mode, the corresponding commands and keybindings are disabled, and runtime checks also block programmatic calls. Citation completion can still read bibliography files resolved directly from the project, but does not start `kpsewhich`. Editing, navigation, and other completion features remain available.

## TeX documentation

Press `Ctrl+T`, release Ctrl, then press `I` and `C` without Shift in a LaTeX editor, or run **Fortex: Open Documentation** from the Command Palette. Enter a package, class, or documentation name. The input is prefilled with selected text or the literal name at the cursor in `\usepackage{...}`, `\RequirePackage{...}`, or `\documentclass{...}` when available. The Command Palette also works without an open editor.

Fortex searches installed documentation using TeX Live's `texdoc --list --machine`. Choose a result from Quick Pick, which shows its description, language, and file path in texdoc's relevance order. Even a single result is offered for selection. The selected document opens through `texdoc --just-view`, using texdoc's configured viewer. Cancelling either the input, search, or picker does not open a document.

Set `vscode-fortex.texdoc.path` to the full executable path when `texdoc` is not on `PATH`. This feature targets TeX Live's texdoc; MiKTeX's separate help utility is not supported. Documentation opens on the machine running the extension, so a remote extension host needs its own TeX installation and a usable viewer.

## PDF preview

Run **View LaTeX PDF** from the Command Palette or press `Ctrl+T T P`. Select the default viewer with `vscode-fortex.pdfViewer`:

- `internal` renders the PDF in a VS Code tab and refreshes it after successful builds.
- `sumatra` opens SumatraPDF and performs forward search to the current source line.

The commands **View LaTeX PDF in VS Code** and **View LaTeX PDF in SumatraPDF** select a viewer for one invocation. Set `vscode-fortex.openPdfAfterBuild` to open the configured viewer automatically after a build. For a non-standard SumatraPDF installation, set `vscode-fortex.sumatraPDF.path` to the full path of `SumatraPDF.exe`.

To use SumatraPDF by default, configure:

```json
{
  "vscode-fortex.pdfViewer": "sumatra",
  "vscode-fortex.sumatraPDF.path": "C:\\Program Files\\SumatraPDF\\SumatraPDF.exe"
}
```

The path may be left empty when SumatraPDF is installed in its standard per-user or Program Files location.

SumatraPDF inverse search is enabled by default. When opening SumatraPDF normally, Fortex passes `-inverse-search` with `"<VS Code path>" -r -g "%f:%l"`, so invoking inverse search in SumatraPDF opens the corresponding source line in VS Code. `Ctrl+T T J` only sends `-forward-search` and does not repeat the inverse-search setting. The running VS Code executable is detected automatically. To override it, set `vscode-fortex.sumatraPDF.inverseSearch.vscodePath`; inverse search can be disabled with `vscode-fortex.sumatraPDF.inverseSearch.enabled`.

SyncTeX from the editor uses the viewer selected by `vscode-fortex.pdfViewer`. Running **SyncTeX from Cursor**, or pressing `Ctrl+T T J`, jumps to the PDF output for the current source position in either the internal viewer or SumatraPDF. The internal viewer centers the SyncTeX marker in the visible area. Set `vscode-fortex.synctex.forwardSearch.focus` to `editor` to keep focus in the source editor without changing its cursor or scroll position (the default), or `viewer` to move focus to the PDF viewer. In the internal viewer, double-click a position in the PDF to open the corresponding TeX file and line. Set `vscode-fortex.synctex.path` if the `synctex` command is not available on `PATH`.

## Citation completion

Fortex reads bibliography files referenced by `\bibliography{...}` or `\addbibresource{...}` throughout the current LaTeX project. Bibliography names are resolved with `kpsewhich --format=bib`, using the main document directory as the working directory, so both relative files and files on the TeX search path are available. Set `vscode-fortex.kpsewhich.path` when `kpsewhich` is not on `PATH`. Inside `\cite{...}` and common cite-like commands, IntelliSense searches the `author` and `title` fields together and inserts the selected BibTeX key. Multiple citations are supported after a comma.

When completion is requested from a subfile, Fortex first determines the main file and recursively follows `\input` and `\include` from it. Bibliography commands in any loaded file are included. Main-file detection follows `vscode-fortex.mainFileOrder`; `magic` reads `%#main main.tex`, `guess` searches the current and every ancestor directory for a document containing `\documentclass` that recursively loads the current file, and `current` treats the current file as the main file. For example:

```json
{
  "vscode-fortex.mainFileOrder": ["magic", "guess", "current"]
}
```

Run **Fortex: Insert Citation** from the Command Palette, or press `Ctrl+T [`, for a larger Quick Pick search. Search terms may match either authors or titles without selecting a field. Select one or more entries; Fortex replaces the current citation fragment when the cursor is already inside a cite command, or inserts a complete `\cite{...}` command otherwise.

Resolved bibliography files are cached and watched through VS Code, including files outside the workspace that are not open in an editor. Changes, deletion, and recreation invalidate the cached entries; the next citation request reads the current contents. Open bibliography documents use their unsaved contents. Watches are shared between documents and released when their last referencing document closes or a later citation request no longer uses that bibliography.

## LaTeX structure

The Explorer's **LaTeX Structure** view shows headings, theorems, display equations, figures, and tables in document order. Labels are attached to their heading or containing environment and shown beside its title. Select an item to open its source, or use **Go to Attached Label** from its context menu to jump directly to a label. Labels without an identifiable owner appear as standalone items.

By default, Fortex uses the same main-file detection as a build (`vscode-fortex.mainFileOrder`, including `%#main`), then expands literal `\input` and `\include` commands at their source positions. Included headings participate in the surrounding document hierarchy. Set `vscode-fortex.outline.followIncludes` to `false` to display only the current file without main-file discovery. This setting affects structure display only. The view identifies its main file or indicates **Current file only**. Untitled documents are local only.

The view's toolbar offers **Go to LaTeX Label** and **Filter LaTeX Structure**. The filter chooses visible categories and whether to show labeled, all, or no display equations. Its menu also switches to **Show Labels in Name Order**, toggles attached label names, and enables **Show Only Labeled Items**. Hidden parents promote visible descendants; labeled-only mode keeps the headings needed to locate visible items. Label mode and label search include every label in the selected scope, independently of category filters. Labels declared at different positions with the same key are marked as duplicates; repeated inclusion of one declaration shows its inclusion count. Display choices are saved for the workspace (or in the window's workspace state when no folder is open).

`\newtheorem` and `\newtheorem*` declarations in the parsed sources supply theorem environment names and titles. Use `vscode-fortex.outline.theoremEnvironments` to add names defined in a class or package, for example `{ "claim": "Claim" }`. Headings use their full titles; theorems use their declared name and optional title, figures and tables use their first caption, and equations show a source excerpt. An `align` block remains one item with all its labels. Inline math and nested equation helpers such as `aligned` are not separate items.

The structure is first read when needed, then updated when a document is saved. Editing keeps the previous project tree; navigation into a changed document is blocked until its snapshot is updated. Saving one document does not reparse another unsaved document. A save reads the persisted source before updating its snapshot, so concurrent edits remain pending. Repeated notifications for unchanged saved text reuse its analysis and trees. The previous tree also remains visible during an update or after an update failure. External dependency changes, file creation/deletion, target changes, and related configuration changes also update the view. There is no manual refresh command. Comments, verbatim examples, and macro definition bodies are ignored. Missing files and circular includes appear at the relevant inclusion site. This is a source structure index: macros, conditionals, and `\includeonly` are not evaluated, and LaTeX-generated numbering is not reproduced. Label attachment describes source containment, rather than guaranteeing the counter to which a compiled reference resolves.

The standard **Outline**, breadcrumbs, and **Go to Symbol in Editor** (`Ctrl+Shift+O`, or `Cmd+Shift+O` on macOS) use the same document snapshots and show the current file's heading hierarchy regardless of the project view's filters. While editing, saved heading names and hierarchy remain visible, and their positions follow insertions, deletions, and replacements. Input records only numeric changes; positions are updated when symbols are requested, without reparsing the document. Editing a heading declaration temporarily omits only that heading and promotes its surviving children, so no outdated location is used. New or renamed headings appear after save. Saved-source and settings changes explicitly refresh native symbols only when their names, hierarchy, or ranges change; project-tree publication does not refresh them. The separate LaTeX Structure view retains its document-level navigation block for changed sources.

## Label reference completion

Inside `\ref{...}`, IntelliSense lists `\label{...}` names from the current LaTeX file. Only names are collected initially; the source preview is obtained when suggestion details are requested. Nested braces, escaped braces, multiline arguments, and comments within arguments are supported. Declarations in comments or verbatim examples are also collected as completion candidates. The same completion is available for common variants including `\pageref`, `\eqref`, `\autoref`, `\nameref`, `\cref`, and `\Cref`.

The label, command, and environment completion scopes can be configured independently:

```json
{
  "vscode-fortex.completion.label.scope": "document",
  "vscode-fortex.completion.command.scope": "document",
  "vscode-fortex.completion.environment.scope": "document"
}
```

All three default to `document`. Set a scope to `project` to collect from the main file and its recursive `\input`/`\include` sources. Open documents contribute their current unsaved text. When project discovery is unavailable, such as in an untitled document, completion uses the current document. Package files are not automatically loaded through `\usepackage`. Candidate collection includes declarations inside comments and literal examples, while completion context detection, project discovery, navigation, and outlines retain strict lexical rules.

Completion collects fresh sources when a new input context starts and reuses candidates only while editing that context's query. Main-file discovery and project construction retain no results between requests. Ordinary typing does not rebuild completion indexes or compute project signatures.

Press `Ctrl+T G` with the cursor on a `\label{...}` or reference command to move to the command using the same key. Moving from a label shows Quick Pick when the label has several references. This navigation currently searches the active file only.

## Environment editing

Inside `\begin{...}`, IntelliSense completes a standard, previously used, `\newenvironment`, or `\newtheorem` environment and inserts its matching `\end{...}`. Type `\[` to complete a `\[ ... \]` display-math pair.

Press `Ctrl+T B` away from an existing environment command to select an environment from Quick Pick. With selected text, the command wraps the selection; otherwise it inserts an empty pair and places the cursor inside. When the cursor is on a `\begin{...}`, `\end{...}`, `\[`, or `\]`, `Ctrl+T B` shows environment candidates for renaming the matching pair. Choose a candidate or type a new environment name; standard environments and names used or declared in the document are offered. `F2` also supports paired renaming. Renaming updates only the structurally matching pair, including nested environments. Enter `[` as the new name (or select the display-math candidate) to convert a named environment into `\[ ... \]` notation; the previous `\[` and `\]` inputs are also accepted.

Press `Ctrl+T E` to close the innermost unclosed environment before the cursor. Fortex inserts the corresponding `\end{...}` or `\]` on a line aligned with its opening command. An environment that already has a structurally matching closing command later in the document is not closed a second time.

Set `vscode-fortex.environment.indentContent` to `false` to keep inserted or wrapped environment content at the outer environment's indentation level. When enabled (the default), the indentation characters and width follow VS Code's `editor.insertSpaces` and `editor.tabSize` settings.

Press `Ctrl+T G` on `\begin{...}`, `\end{...}`, `\[`, or `\]` to move to its structurally matching opening or closing command.

## Command completion

After typing `\`, IntelliSense lists common LaTeX commands and commands declared in the current document with `\newcommand`, `\renewcommand`, `\providecommand`, `\DeclareRobustCommand`, or xparse document-command declarations. Common commands and classic `\newcommand` declarations insert argument placeholders as snippets. Completing `\ref`, `\cite`, or `\begin` immediately opens the corresponding label, citation, or environment completion.

## Math input shortcuts

These shortcuts work in editable LaTeX documents, including macro definitions outside a math environment.

### Math alphabets

The `\mathcal` and `\mathfrak` shortcuts are disabled by default. Enable both with one setting:

```json
{
  "vscode-fortex.mathShortcuts.enabled": true
}
```

Set `vscode-fortex.mathShortcuts.enabled` to `false` to disable both math alphabet shortcuts.

In an editable LaTeX document, press `Ctrl+T`, release Ctrl, then press `X` or `F` without Shift, followed by a letter. Hold Shift for the final letter to insert an uppercase letter; otherwise a lowercase letter is inserted.

| Key sequence | Inserted text |
| --- | --- |
| `Ctrl+T → X → a` | `\mathcal{a}` |
| `Ctrl+T → X → Shift+A` | `\mathcal{A}` |
| `Ctrl+T → F → a` | `\mathfrak{a}` |
| `Ctrl+T → F → Shift+A` | `\mathfrak{A}` |

All letters from `a` to `z` and `A` to `Z` are supported. The cursor moves after the closing brace.

### Greek letters

Greek letter input is always available and does not require changing `vscode-fortex.mathShortcuts.enabled`.

Press `Ctrl+T`, release Ctrl, then press `J` without Shift to start Greek letter input. **Fortex: Insert Greek Letter** in the Command Palette starts the same input mode. Type a YaTeX-style code to preview its LaTeX command at the cursor. The preview does not change the document: `p` previews `\pi`, adding `h` changes it to `\phi`, and adding `-` changes it to `\varphi`.

| Key during Greek input | Action |
| --- | --- |
| `Enter` | Insert the previewed command without a newline |
| `Space` | Insert the command and a space |
| `Esc` | Cancel without changing the document |
| `Backspace` | Remove the last code character; cancel when the code is empty |
| `Tab` | Open a candidate picker for the current code |
| `Ctrl+Z` (`Cmd+Z` on macOS) | Cancel the preview without undoing earlier document edits |

An English letter, digit, or supported punctuation character that cannot continue the code commits the current candidate and inserts that character. For example, `a` followed by `2` inserts `\alpha2`, and `a` followed by `x` inserts `\alpha x`; the separating space prevents two command names from joining. Since `p-` means `\varpi`, use `p`, `Enter`, then `-` to insert `\pi-`.

The punctuation supported during input is `-`, `,`, `.`, `/`, `!`, `#`, `$`, `%`, `<`, `>`, and `?`. For other symbols such as `+`, `=`, `_`, `^`, and parentheses, press `Enter` to commit first, then type the symbol normally. Punctuation bindings are limited to the keys shared by standard US and Japanese layouts; using a layout-dependent key without committing first cancels the preview and performs normal input.

Codes are case-sensitive. Use Shift for uppercase letters; these keybindings do not interpret Caps Lock. The standard Greek commands and their variant forms use the following codes:

| Lowercase code | Command | Uppercase code | Command |
| --- | --- | --- | --- |
| `a` | `\alpha` | — | — |
| `b` | `\beta` | — | — |
| `g` | `\gamma` | `G` | `\Gamma` |
| `d` | `\delta` | `D` | `\Delta` |
| `e`, `e-` | `\epsilon`, `\varepsilon` | — | — |
| `z` | `\zeta` | — | — |
| `et` | `\eta` | — | — |
| `th`, `th-` | `\theta`, `\vartheta` | `Th` | `\Theta` |
| `i` | `\iota` | — | — |
| `k` | `\kappa` | — | — |
| `l` | `\lambda` | `L` | `\Lambda` |
| `m` | `\mu` | — | — |
| `n` | `\nu` | — | — |
| `x` | `\xi` | `X` | `\Xi` |
| `p`, `p-` | `\pi`, `\varpi` | `P` | `\Pi` |
| `r`, `r-` | `\rho`, `\varrho` | — | — |
| `s`, `s-` | `\sigma`, `\varsigma` | `S` | `\Sigma` |
| `t` | `\tau` | — | — |
| `u`, `y` | `\upsilon` | `U`, `Y` | `\Upsilon` |
| `ph`, `ph-` | `\phi`, `\varphi` | `Ph` | `\Phi` |
| `c` | `\chi` | — | — |
| `ps` | `\psi` | `Ps` | `\Psi` |
| `o`, `w` | `\omega` | `O`, `W` | `\Omega` |

Greek input currently requires a single cursor with no selection. Moving the cursor, switching editors, or editing the document through another command, paste, or IME cancels the preview. A committed completion is inserted as one edit and can be undone normally.

The code mapping follows [YaTeX's Greek completion table](https://github.com/hiroseyuuji/yatex/blob/master/yatexmth.el). AMS-only uppercase variants and the non-Greek `foo` entry are not included.

## What is this?

This is a Visual Studio Code version of "祝鳥" which is the macro package of Hidemaru for supporting LaTeX editing.
