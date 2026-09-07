# Terminal end-to-end tests

The harness sends keys to the TUI over stdin and reads its ANSI output through xterm/headless.
It waits for the app's settle response between steps and creates isolated fixtures under `.build/test-fixtures/`.
Run from the repository root with Node, Rust, Git, and Sapling (`sl`) installed:

```sh
npm install
npm run e2e           # builds the frontend and Rust host, then runs all terminal workflows
npm run test:host     # tests the Rust channels over stdio
```

Set `TUCODE_E2E_DUMP=1` to print captured frames. Tests live in `test/e2e/`; shared drivers and probes are in `lib/`.
Mac uses a separate [foreground XCUITest harness](../../mac/README.md).
