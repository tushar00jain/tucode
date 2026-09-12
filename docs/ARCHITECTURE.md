# Architecture

Two frontends reuse VS Code's services and models, with a Rust backend for OS work.
Documents, undo, saves, search, editor groups, and commands stay in VS Code's JavaScript.
Each frontend creates its own service graph; Rust is not the owner of all application state.
There is no extension host, language server, debugger, or Electron runtime.

## Frontends and communication

```text
TERMINAL: one Node process                    Separate Rust child
+------------------------------------+       +--------------------------+
| VS Code services / models          | <---> | tscode-host              |
|      ^ direct JS calls / events    |       | Files, watching, search, |
|      v                             |       | Git / Sapling, PTYs      |
| TUI bridge: DOM shim + native ANSI  |       +--------------------------+
+------------------------------------+         IChannel requests/events
       ^ stdin keys   | ANSI output            as JSON lines over stdio
       |              v
             User's terminal

MAC: WebKit content process                        Native Mac app process
+------------------------------------+             +-----------------------------+
| VS Code services / models          | < Wry IPC > | Rust backend (Tokio workers)|
|                                    |    JSON     +-----------------------------+
|                                    |             +-----------------------------+
|                                    | <---------> | Swift / AppKit: Apple bridge|
+-----------------+------------------+ UI state /  | Native controls / input     |
                  ^                    input       +-----------------------------+
                  | direct JS calls / events
                  v
+------------------------------------+
| HTML bridge: VS Code editor panes  |
+------------------------------------+
```

- **Terminal:** VS Code services and the TUI run together in Node, without a browser.
- **Mac UI:** Swift owns windows, menus, input, and layout. Wry hosts the editor WebView.
- **Mac JavaScript boundary:** VS Code services and models already execute in WebKit's content
  process, across the bridge from AppKit. They share that JavaScript runtime with the DOM editor;
  they are not separate worker services. Swift does not implement search, filtering, or sorting.
- **Mac backend:** Rust starts with the app and runs on Tokio workers, keeping both UI event loops responsive.
- **Window lifecycle:** Each Mac editor has its own backend connection. Closing and shutdown are asynchronous.
- **Shared IPC:** Both frontends use the same `IChannel` adapter and Rust JSON dispatcher for files, watching, search, Git/Sapling, and PTYs.

## What paints each surface

| Surface | Terminal | Mac |
| --- | --- | --- |
| Explorer | VS Code view/tree + shared path filter -> DOM shim -> ANSI | VS Code model/filter/sorter/compact tree + shared path filter -> serialized rows -> AppKit |
| Text / diff editor | VS Code models -> native presentation controllers -> ANSI | Actual VS Code browser editor panes -> HTML |
| Editor tabs | VS Code group state/events -> ANSI | VS Code group state/events -> serialized tabs -> AppKit |
| Changes / SCM | VS Code view/controller/tree/row renderers -> DOM shim -> ANSI | VS Code SCM models/tree adapters -> serialized rows -> AppKit |
| SCM history graph | VS Code history view model -> native ANSI graph | VS Code history model/lazy tree + shared graph geometry -> AppKit outline |
| Sapling smartlog | Sapling graph data/text renderer -> ANSI | Not implemented |
| Search | VS Code view/widget/controller/tree + shared result filter -> DOM shim -> ANSI | VS Code Search model/QueryBuilder + shared refresh/query controllers + lazy branches -> changed rows -> AppKit |
| Quick Input / Quick Open | Upstream QuickInputService/controller/list and providers -> DOM shim -> ANSI | Native IQuickInputService adapter + upstream providers -> Apple bridge -> AppKit |
| One-shot pick / input | Shared upstream operations with terminal input widgets | Same operations with native input widgets |
| Dialogs | VS Code DialogsModel -> shared handler -> terminal picker | Same model/handler -> native picker |
| Markdown preview | Document + Markdown tokens + syntax tokenization -> ANSI | Existing MarkdownPreviewEditor + VS Code renderers -> HTML |
| Embedded terminal | VS Code PTY service + xterm terminal state -> ANSI | Native terminal surface not implemented |

- Adapters handle input, layout, focus, and paint; VS Code APIs own state changes.
- Mac uses shared modules independently of the TUI. Native rows reflect VS Code models.
- Entry points: `src/main.ts` / `src/boot.ts` (terminal); `src/macWebMain.ts` and `mac/` (Mac).

Native navigator updates send changed records and child lists. VS Code's `Throttler` waits for
AppKit's acknowledgement and coalesces pending publications before reading the next state.
Swift decodes the JSON and computes standard `CollectionDifference` values on a serial queue;
`NSOutlineView` applies batched insertions/removals and manages cell reuse, scrolling, and layout.
Graph is a separate native navigator beside Source Control. History fetches begin when it is shown; commit changes are fetched on expansion. Shared
TypeScript geometry supplies native path commands and colors, and a separate unindented AppKit
column continues lanes through changed-file rows. Graph reuses native Quick Input for repository
and reference selection, and upstream single-file and Multi Diff editor inputs for historical changes.
Control-only changes do not resend result rows. Search uses the same refresh controller as the
browser/terminal view, and collapsed branches defer child enumeration until expansion.

## Source control watchers

Repository watches use the application's `files.watcherExclude` settings. For Sapling
repositories, these patterns exclude bookkeeping writes that can trigger repeated
smartlog reads. Configure them in tucode's settings, then restart the app:

```json
{
  "files.watcherExclude": {
    "**/.git/sl/**": true,
    "**/.sl/**": true
  }
}
```

Metadata-only changes may require a manual Sapling refresh. File-change refreshes
reuse the discovered repositories; explicit refreshes and workspace-folder changes
also run discovery.
