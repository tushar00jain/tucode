//! Terminal backend for tscode.
//!
//! This is everything below VS Code's `ITerminalChildProcess`
//! (`vs/platform/terminal/common/terminal.ts`) — the one seam in the terminal
//! stack that touches an OS. Stock has five implementations of that interface
//! and only one of them, `TerminalProcess`, opens a pty; the other four cross a
//! process boundary to reach it. Everything above the seam is vendored
//! TypeScript, including `ptyService.ts` and its flow-control, buffering and
//! persistence bookkeeping, which now run in the renderer.
//!
//! No Tauri types appear in this crate's API — the channel layer wraps it, and
//! events reach it through [`ProcessEventSink`].
//!
//! # What each module ports
//!
//! | Module | Upstream |
//! | --- | --- |
//! | [`process`] | `vs/platform/terminal/node/terminalProcess.ts` |
//! | [`flow`] | its `_unacknowledgedCharCount` flow control |
//! | [`monitor`] | `vs/platform/terminal/node/childProcessMonitor.ts` |
//! | [`windows_shell`] | `vs/platform/terminal/node/windowsShellHelper.ts` |
//! | [`profiles`] | `vs/platform/terminal/node/terminalProfiles.ts` |
//! | [`registry`] | the `_ptys` map in `vs/platform/terminal/node/ptyService.ts` |
//! | [`wsl`] | `getWslPath` in `ptyService.ts`, plus `escapeNonWindowsPath` |
//! | [`ps`] | `vs/base/node/ps.ts` |
//! | [`processes`] | `vs/base/node/processes.ts` |
//! | [`powershell`] | `vs/base/node/powershell.ts` |
//! | [`shell`] | `vs/base/node/shell.ts` |
//! | [`shell_env`] | `vs/platform/shell/node/shellEnv.ts` |
//! | [`windows_version`] | `vs/base/node/windowsVersion.ts` |
//! | [`decorators`] | `debounce` / `throttle` in `vs/base/common/decorators.ts` |
//! | [`types`] | the terminal vocabulary in `vs/platform/terminal/common/terminal.ts` |
//! | [`decoder`] | the `StringDecoder` `node-pty` pipes its output through |
//!
//! Each module's docs name what it ports and list where it deliberately departs
//! from it; `docs/UPGRADING.md` explains why that citation is not optional.
//!
//! # Threads
//!
//! A terminal owns two OS threads — one blocked reading the pty master, one
//! blocked waiting for the child to exit — and one tokio task that owns the exit
//! sequencing and the timers. The threads are `std::thread`s rather than
//! `spawn_blocking` slots because they block for the terminal's whole life, and
//! tokio's blocking pool is for work that finishes. Everything the channel calls
//! is `async` and does its blocking work in `spawn_blocking`.
//!
//! # What is not here
//!
//! - **Persistence.** No `PersistentTerminalProcess`, no replay recording, no
//!   revive, no layout. Terminals do not survive a window reload; the
//!   architecture doc records that as a deliberate divergence.
//! - **Shell-integration injection.** `node/terminalEnvironment.ts` is vendored
//!   into the frontend, which resolves the injection and passes the resulting
//!   args and env into [`process::TerminalProcess::new`].
//! - **`freePortKillProcess`.** Dropped by the architecture doc's cut table,
//!   which takes `base/node/processes.ts`'s `killTree` with it.

pub mod decoder;
pub mod decorators;
pub mod error;
pub mod flow;
pub mod monitor;
pub mod powershell;
pub mod process;
pub mod processes;
pub mod profiles;
pub mod ps;
pub mod registry;
pub mod shell;
pub mod shell_env;
pub mod types;
pub mod windows_shell;
pub mod windows_version;
pub mod wsl;

pub use error::{PtyError, Result};
pub use process::{ProcessEventSink, TerminalProcess};
pub use profiles::{detect_available_profiles, DetectOptions, DiskFsProvider, FsProvider};
pub use processes::{file_exists_default, find_executable};
pub use ps::{list_processes, ProcessItem};
pub use registry::PtyRegistry;
pub use shell::get_system_shell;
pub use shell_env::get_resolved_shell_env;
pub use types::{
    current_environment, flow_control, FixedTerminalDimensions, OperatingSystem, ProcessEnvironment,
    ProcessProperty, ProcessPropertyType, ProcessReadyEvent, ShellLaunchConfig, SingleOrMany,
    TerminalProcessOptions, TerminalProfile, TerminalShellType, UnresolvedTerminalProfile,
};
pub use wsl::{get_wsl_path, WslDirection};
