# Change Log

All notable changes to the "vscode-fortex" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Added an allowlist for programs selected by `%#` build directives and reject disallowed programs before starting a build.
- Parse `%#!` command lines internally and execute them with `shell: false`.
- Disable manual, save-triggered, and programmatic LaTeX builds in untrusted workspaces.
- Disable PDF previews, SyncTeX, SumatraPDF, and `kpsewhich` execution in untrusted workspaces.
- Grouped all completion sources under `src/completion` and moved PDF preview sources under `src/compile/preview`.
- Added author/title citation search through IntelliSense and the **Fortex: Insert Citation** Quick Pick command.
- Added the `Ctrl+T [` keybinding for citation Quick Pick.
- Resolve referenced bibliography files through `kpsewhich` and the Kpathsea search path.
- Search bibliography commands from the detected main file through recursively loaded `\\input` and `\\include` files.
- Added current-file label completion for `\\ref` with a nearby-source preview.
- Added a setting to keep focus in the source editor or move it to the viewer after forward SyncTeX search.
- Preserve the source editor cursor and scroll position when keeping focus after forward search.
- Center the internal PDF viewer on the forward SyncTeX marker.
- Added LaTeX environment insertion and wrapping through IntelliSense and `Ctrl+T B`.
- Added paired environment renaming with `F2` or `Ctrl+T B`, including `\\[ ... \\]` display math.
- Added `vscode-fortex.environment.indentContent` to disable the extra indentation inside inserted environments.
- Added `Ctrl+T E` to close the innermost unclosed named or display-math environment.
- Cached and incrementally refreshed label indexes so `\\ref` completion opens immediately in large documents.
- Added IntelliSense snippets for common LaTeX commands and commands declared in the current document.
- Added `Ctrl+T G` navigation between matching `\\begin`/`\\end` and `\\label`/reference commands.
- Initial release
