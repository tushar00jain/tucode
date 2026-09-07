# tscode

A lightweight VS Code frontend for browsing code and reviewing changes, with
Explorer, search, multi-repository source control, a Sapling smartlog, and terminals.

- **Less memory:** a system webview and Rust backend replace Electron and Node.
- **Less bloat:** no extension host, language servers, or debugger.
- **VS Code's own frontend:** its actual source code, with minimal modifications and all changes tracked against upstream.
- **Read-only by default:** browse files without accidentally typing into them.
- **Built-in Vim:** press `V` to enter Vim mode; `:q` returns to the viewer.
- **More keyboard control:** viewer mode frees letter keys for navigation and commands.

## Quick start

```sh
npm install
npm run tauri:dev      # development
npm run tauri:build    # release build and installer
npm run typecheck
```

## Docs

[Architecture and watcher settings](docs/ARCHITECTURE.md) · [Upgrading](docs/UPGRADING.md) · [Keyboard](docs/keyboard/keys.html) · [Source provenance](docs/provenance/provenance.html) · [Known defects](docs/TODO.md)

## Credits

Derived from [VS Code](https://github.com/microsoft/vscode) (Microsoft) and [Sapling's addons](https://github.com/facebook/sapling/tree/main/addons) (Meta), under MIT; see [VS Code license](LICENSE.txt), [Sapling license](LICENSE-sapling.txt), and [third-party notices](ThirdPartyNotices.txt).

Generate the complete documentation pages with `npm run provenance` and `npm run keyboard`.
Both default to `origin/vendor`; use `-- --rev <git-ref>` or `-- --upstream <checkout>` to override it.
Provenance measures repository-wide unchanged lines, edited additions/removals, and new-file additions.
The keys page compares tscode with upstream Windows and macOS defaults in separate tables.
Shortcut declarations are read from source; context-dependent alternatives are combined and unresolved expressions are marked.
