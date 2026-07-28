# vscode-fortex

## PDF preview

Run **View LaTeX PDF** from the Command Palette or press `Ctrl+T P`. Select the default viewer with `vscode-fortex.pdfViewer`:

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

SumatraPDF inverse search is enabled by default. When opening SumatraPDF normally, Fortex passes `-inverse-search` with `"<VS Code path>" -r -g "%f:%l"`, so invoking inverse search in SumatraPDF opens the corresponding source line in VS Code. `Ctrl+T J` only sends `-forward-search` and does not repeat the inverse-search setting. The running VS Code executable is detected automatically. To override it, set `vscode-fortex.sumatraPDF.inverseSearch.vscodePath`; inverse search can be disabled with `vscode-fortex.sumatraPDF.inverseSearch.enabled`.

SyncTeX from the editor uses the viewer selected by `vscode-fortex.pdfViewer`. Running **SyncTeX from Cursor**, or pressing `Ctrl+T J`, jumps to the PDF output for the current source position in either the internal viewer or SumatraPDF. The internal viewer centers the SyncTeX marker in the visible area. Set `vscode-fortex.synctex.forwardSearch.focus` to `editor` to keep focus in the source editor without changing its cursor or scroll position (the default), or `viewer` to move focus to the PDF viewer. In the internal viewer, double-click a position in the PDF to open the corresponding TeX file and line. Set `vscode-fortex.synctex.path` if the `synctex` command is not available on `PATH`.

## Citation completion

Fortex reads bibliography files referenced by `\bibliography{...}` or `\addbibresource{...}` throughout the current LaTeX project. Bibliography names are resolved with `kpsewhich --format=bib`, using the main document directory as the working directory, so both relative files and files on the TeX search path are available. Set `vscode-fortex.kpsewhich.path` when `kpsewhich` is not on `PATH`. Inside `\cite{...}` and common cite-like commands, IntelliSense searches the `author` and `title` fields together and inserts the selected BibTeX key. Multiple citations are supported after a comma.

When completion is requested from a subfile, Fortex first determines the main file and recursively follows `\input` and `\include` from it. Bibliography commands in any loaded file are included. Main-file detection follows `vscode-fortex.mainFileOrder`; `magic` reads `%#main main.tex`, `guess` searches the current and every ancestor directory for a document containing `\documentclass` that recursively loads the current file, and `current` treats the current file as the main file. For example:

```json
{
  "vscode-fortex.mainFileOrder": ["magic", "guess", "current"]
}
```

Run **Fortex: Insert Citation** from the Command Palette, or press `Ctrl+T [`, for a larger Quick Pick search. Search terms may match either authors or titles without selecting a field. Select one or more entries; Fortex replaces the current citation fragment when the cursor is already inside a cite command, or inserts a complete `\cite{...}` command otherwise.

## Label reference completion

Inside `\ref{...}`, IntelliSense lists `\label{...}` targets from the current LaTeX file. Selecting a suggestion shows the target line and its nearby LaTeX source in the suggestion details popup. The same completion is available for common variants including `\pageref`, `\eqref`, `\autoref`, `\nameref`, `\cref`, and `\Cref`.

## What is this?

This is a Visual Studio Code version of "祝鳥" which is the macro package of Hidemaru for supporting LaTeX editing.
