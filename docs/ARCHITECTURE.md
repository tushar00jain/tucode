# Architecture

Tscode keeps VS Code's editor and workbench frontend, with Explorer, search,
source control, a Sapling smartlog, and terminals. Tauri's OS webview replaces
Electron's bundled Chromium; a Rust backend replaces the Node backend.
There is no extension host, language server, debugger, or shared process.
Bundled themes, icons, and syntax grammars remain as data-only assets.

```text
+--------------------------------------+
| VS Code frontend in the OS webview   |
+--------------------------------------+
          | requests     ^ responses / events
          | IChannel over Tauri invoke / listen
          v              |
+--------------------------------------+
| Rust backend, hosted by Tauri        |
| Files, watching, search, SCM, PTYs   |
+--------------------------------------+
          | OS APIs / subprocesses
          v
+--------------------------------------+
| Filesystem, shells, Git / Sapling    |
+--------------------------------------+
```

The frontend keeps VS Code's service interfaces; a Tauri transport connects them
to Rust through six channels: `file`, `watch`, `search`, `scm`, `sl`, and `pty`.
Upstream frontend code is copied wherever possible; adapters live under `tauri/`.
See [UPGRADING.md](UPGRADING.md) for maintaining the copied source.

## Required watcher settings

Add these exclusions to **tscode's** `settings.json`, then restart the app.
Settings in ordinary VS Code alone do not configure tscode.

```json
{
  "files.watcherExclude": {
    "**/.git/sl/**": true,
    "**/.sl/**": true
  }
}
```

These exclude Sapling bookkeeping writes that can trigger repeated smartlog reads.
Metadata-only changes may require a manual refresh of the Sapling view.
