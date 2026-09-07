# End-to-end tests

The Windows/WebView2 harness launches the built app and drives it with Playwright over CDP.
It creates temporary repositories and isolated settings, rejects stale binaries, and cleans up its own processes.
Run from the repository root with Node 24, Rust, Git, Sapling (`sl`), and PowerShell available:

```sh
npm install
npm run build:fast
npm run e2e             # editor, source control watcher, and terminal sessions
npm run e2e:terminal    # terminal session only
```

Tests live in `suites/`; shared setup and UI probes live in `lib/`. Set `TSCODE_E2E_WINDOW_POSITION=screen` to watch a run.
