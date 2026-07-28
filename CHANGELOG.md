# Change Log

All notable changes to the "vscode-fortex" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Added author/title citation search through IntelliSense and the **Fortex: Insert Citation** Quick Pick command.
- Added the `Ctrl+T [` keybinding for citation Quick Pick.
- Resolve referenced bibliography files through `kpsewhich` and the Kpathsea search path.
- Search bibliography commands from the detected main file through recursively loaded `\\input` and `\\include` files.
- Added current-file label completion for `\\ref` with a nearby-source preview.
- Initial release
