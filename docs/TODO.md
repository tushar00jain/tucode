# TODO

## Shared

- Display notification errors and required actions in both frontends; the notification controller currently has no frontend consumer.
- Hide or implement commands whose service capabilities are unavailable: terminal text clipboard operations and Mac workspace-file switching.
- Handle watches on paths that do not exist yet by watching an existing parent; direct `notify` registration currently fails.
- Bound host transport queues and apply backpressure during sustained output.
- Preserve newline-containing environment values when reading a POSIX login shell's environment.
- Make Windows terminal buffer clearing reach ConPTY; the backend method is currently a no-op.

## Terminal

- Forward the text-file model's read-only state and changes into the editor configuration (`src/editor/editorAreaResolver.ts`); editing can currently disagree with the working copy.
- Report context-menu action failures through `ActionRunner.onDidRun`; awaiting `run()` does not surface them.
- Route malformed host-message diagnostics through the logger instead of writing over the terminal UI on stderr.
- Fix reported paint defects: blank rows after enlarging the window, mismatched diff gutter widths, and cursors painted in unfocused terminal regions.
- Keep very short-lived child sessions from closing before their output becomes visible.

## Mac

- Render dialog questions, details, validation feedback, and supported Quick Input flags; Swift currently drops them. Explicitly reject unsupported password presentations; native multi-select now supports checkboxes and explicit acceptance.
- Implement resource clipboard operations before enabling Explorer Cut/Copy/Paste; opening a menu must not request WebKit clipboard permission.
- Extend native graph details with upstream rich hover/avatar presentation and provider-contributed commit/reference menus.
- Add the planned native terminal surface using the existing terminal services.
