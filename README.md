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

SyncTeX from the editor uses the viewer selected by `vscode-fortex.pdfViewer`. Running **SyncTeX from Cursor**, or pressing `Ctrl+T J`, jumps to the PDF output for the current source position in either the internal viewer or SumatraPDF. In the internal viewer, double-click a position in the PDF to open the corresponding TeX file and line. Set `vscode-fortex.synctex.path` if the `synctex` command is not available on `PATH`.

## What is this?

This is a Visual Studio Code version of "祝鳥" which is the macro package of Hidemaru for supporting LaTeX editing.
