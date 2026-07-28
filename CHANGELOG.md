# Change Log

All notable changes to the "vscode-fortex" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Added author/title citation search through IntelliSense and the **Fortex: Insert Citation** Quick Pick command.
- Added the `Ctrl+T [` keybinding for citation Quick Pick.
- Resolve referenced bibliography files through `kpsewhich` and the Kpathsea search path.
- Search bibliography commands from the detected main file through recursively loaded `\\input` and `\\include` files.
- Added current-file label completion for `\\ref` with a nearby-source preview.
- Added a setting to keep focus in the source editor or move it to the viewer after forward SyncTeX search.
- Preserve the source editor cursor and scroll position when keeping focus after forward search.
- Center the internal PDF viewer on the forward SyncTeX marker.
- Initial release
