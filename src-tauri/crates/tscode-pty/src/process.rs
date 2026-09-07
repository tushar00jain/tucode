//! Port of `vs/platform/terminal/node/terminalProcess.ts` — the one
//! implementation of stock's `ITerminalChildProcess` that touches an OS.
//!
//! `node-pty` becomes `portable-pty`: the same two backends (ConPTY on Windows,
//! `forkpty` elsewhere) behind one API. What `node-pty` gives for free and this
//! has to arrange explicitly is the *shape* around them — a reader thread, a
//! waiter thread, and a supervisor task that owns the exit sequencing and the
//! timers, in place of `node-pty`'s event emitters on Node's event loop.
//!
//! Three pieces of this file are subtle enough to live in their own modules:
//! [`crate::flow`] (the unacknowledged-character window), [`crate::decoder`]
//! (the `StringDecoder` `node-pty` pipes its output through) and
//! [`crate::decorators`] (the debounce and throttle the monitors use).
//!
//! # Deliberate deviations from the reference implementation
//!
//! - **No shell-integration injection.** Stock's `start()` calls
//!   `getShellIntegrationInjection` before spawning. That file
//!   (`node/terminalEnvironment.ts`) is vendored into the frontend, which
//!   resolves the injection and passes the resulting args and env into `create`.
//!   Consequently `start` never returns `injectedArgs`.
//! - **`node-pty`'s `name` option survives only as the Unix `TERM`.**
//!   `portable-pty` has no `name`, so the Unix value is written into the child's
//!   environment directly and the Windows one — the executable's base name — is
//!   dropped, which is what conpty does with it anyway.
//! - **`clearBuffer` is a no-op.** `node-pty`'s `clear()` calls conpty's
//!   `ClearPseudoConsole` on Windows and does nothing on Unix; `portable-pty`
//!   exposes no equivalent, so the Windows half is missing.
//! - **No deferred-pid handling.** Stock waits for the first data event when
//!   `ptyProcess.pid` is 0, because `node-pty` defers conpty's `connect()`
//!   (microsoft/node-pty#885). `portable-pty` creates the process before
//!   returning, so the pid is always available.
//! - **`useConpty` and `conptyInheritCursor` are not passed to the backend.**
//!   `portable-pty` picks ConPTY itself and exposes neither knob. The computed
//!   `use_conpty` still drives the two behaviours stock derives from it: the
//!   kill/spawn throttle, and the delayed resizer.
//! - **The Windows process title is the launched executable's name.**
//!   `node-pty`'s `process` getter reads conhost's console title; there is no
//!   `portable-pty` equivalent. On Windows the real title and shell type come
//!   from [`crate::windows_shell`] anyway, which is what stock prefers there
//!   (`currentTitle` returns `_windowsShellHelper?.shellTitle` first).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use std::time::Duration;

use portable_pty::{
    native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize,
};
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::decoder::Utf8Decoder;
use crate::decorators::sleep_until;
use crate::error::{PtyError, Result};
use crate::flow::FlowControl;
use crate::monitor::ChildProcessMonitor;
use crate::processes::{file_exists_default, find_executable};
use crate::types::{
    node_basename, FixedTerminalDimensions, ProcessEnvironment, ProcessProperty,
    ProcessPropertyType, ProcessReadyEvent, ProcessReadyWindowsPty, ShellLaunchConfig,
    TerminalProcessOptions, TerminalShellType, PATH_DELIMITER,
};
use crate::windows_version::windows_build_number;
use crate::windows_shell::WindowsShellHelper;

//#region Constants

/// The amount of ms that must pass between data events after exit is queued
/// before the actual kill call is triggered. This data flush mechanism works
/// around an issue in node-pty where not all data is flushed, which causes
/// problems for task problem matchers; on Windows under conpty, killing a
/// process while data is being output hangs the conhost flush.
const DATA_FLUSH_TIMEOUT: Duration = Duration::from_millis(250);
/// The maximum ms to allow after dispose is called before forcefully killing the
/// process.
const MAXIMUM_SHUTDOWN_TIME: Duration = Duration::from_millis(5000);
/// The minimum duration between kill and spawn calls on Windows/conpty as a
/// mitigation for a hang issue (microsoft/vscode#71966, #117956, #121336).
const KILL_SPAWN_THROTTLE_INTERVAL: Duration = Duration::from_millis(250);
/// The amount of time to wait when a call is throttled beyond the exact amount,
/// used to prevent early timeouts causing a kill/spawn at double the interval.
const KILL_SPAWN_SPACING_DURATION: Duration = Duration::from_millis(50);
/// `DelayedResizer`'s timer.
const DELAYED_RESIZE_TIMEOUT: Duration = Duration::from_millis(1000);
/// The non-Windows title poll interval.
const TITLE_POLL_INTERVAL: Duration = Duration::from_millis(200);
/// conpty is only used from this Windows build on; below it stock has no pty
/// backend at all since winpty was removed.
const MINIMUM_CONPTY_BUILD: u32 = 18309;

/// One pty read. `node-pty` reads the master in 64 KiB chunks on both backends.
const READ_BUFFER_SIZE: usize = 65536;

/// Stock's `posixShellTypeMap`.
fn posix_shell_type(title: &str) -> Option<TerminalShellType> {
    match title {
        "bash" => Some(TerminalShellType::Bash),
        "csh" => Some(TerminalShellType::Csh),
        "fish" => Some(TerminalShellType::Fish),
        "ksh" => Some(TerminalShellType::Ksh),
        "sh" => Some(TerminalShellType::Sh),
        "zsh" => Some(TerminalShellType::Zsh),
        _ => None,
    }
}

/// Stock's `generalShellTypeMap`.
fn general_shell_type(title: &str) -> Option<TerminalShellType> {
    match title {
        "claude" => Some(TerminalShellType::Claude),
        "codex" => Some(TerminalShellType::Codex),
        "commandcode" => Some(TerminalShellType::CommandCode),
        "copilot" => Some(TerminalShellType::Copilot),
        "gemini" => Some(TerminalShellType::Gemini),
        "pwsh" | "powershell" => Some(TerminalShellType::PowerShell),
        "python" => Some(TerminalShellType::Python),
        "julia" => Some(TerminalShellType::Julia),
        "nu" => Some(TerminalShellType::NuShell),
        "node" => Some(TerminalShellType::Node),
        "xonsh" => Some(TerminalShellType::Xonsh),
        _ => None,
    }
}

//#endregion

//#region Events

/// Stock's four `Emitter`s on `ITerminalChildProcess`, as one sink.
///
/// The channel implements this; the crate never learns what a subscription is.
/// A sink is attached at construction, so nothing can fire before it exists —
/// `start` is a separate call, and no data flows until it runs.
pub trait ProcessEventSink: Send + Sync {
    fn on_process_data(&self, data: String);
    fn on_process_ready(&self, event: ProcessReadyEvent);
    /// Stock types this `number | undefined` but `TerminalProcess` always emits
    /// a number (`this._exitCode || 0`).
    fn on_process_exit(&self, code: Option<u32>);
    fn on_did_change_property(&self, property: ProcessProperty);
}

//#endregion

//#region Spawned state

/// Everything that comes into existence when the pty is spawned. Shared by the
/// supervisor task and the channel-facing methods; cleared on dispose, which is
/// what makes `input` and `resize` no-ops on a dead terminal exactly as stock's
/// `if (this._ptyProcess)` guards do.
struct Running {
    pid: u32,
    /// `Box<dyn MasterPty + Send>` is not `Sync`, so sharing it needs a lock;
    /// `resize` is the only thing that takes it and never awaits while holding it.
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    monitor: ChildProcessMonitor,
    windows_shell: Option<WindowsShellHelper>,
    /// Stock's `_currentTitle`.
    current_title: Mutex<String>,
    control: mpsc::UnboundedSender<Control>,
}

type RunningCell = Arc<RwLock<Option<Arc<Running>>>>;

/// What the supervisor task is told.
enum Control {
    Data(String),
    Exit(u32),
    Shutdown { immediate: bool },
}

//#endregion

//#region TerminalProcess

/// Stock's `_ptyOptions`, computed once in the constructor.
struct PtyOptions {
    cwd: String,
    env: ProcessEnvironment,
    cols: u16,
    rows: u16,
    use_conpty: bool,
    use_conpty_dll: bool,
    /// What `_validateExecutable` resolved. Stock writes it back onto
    /// `shellLaunchConfig.executable`; the config is shared immutably here, and
    /// this is the only thing that spawns.
    resolved_executable: Option<PathBuf>,
}

/// Stock's `_properties`, less the entries only `ptyService.ts` writes.
#[derive(Default)]
struct Properties {
    cwd: String,
    initial_cwd: String,
    fixed_dimensions: FixedTerminalDimensions,
}

/// Stock's `DelayedResizer`: the latest resize, to be applied at a later point.
///
/// Only ever constructed for the one case stock constructs it for — conpty with
/// a zero-sized terminal launching Git Bash, which ignores a resize issued too
/// early.
struct DelayedResize {
    trigger_at: Instant,
    cols: u16,
    rows: u16,
}

/// One terminal process. Stock's `TerminalProcess`.
pub struct TerminalProcess {
    shell_launch_config: ShellLaunchConfig,
    initial_cwd: String,
    /// The environment used for `find_executable`.
    executable_env: ProcessEnvironment,
    pty_options: Mutex<PtyOptions>,
    sink: Arc<dyn ProcessEventSink>,
    flow: Arc<FlowControl>,
    running: RunningCell,
    properties: Mutex<Properties>,
    /// Shared with the supervisor, which owns the trigger: `resize` writes the
    /// latest dimensions into it and the supervisor takes it when the timer
    /// elapses, which is stock's `dispose()` on trigger.
    delayed_resizer: Arc<Mutex<Option<DelayedResize>>>,
    disposed: Arc<AtomicBool>,
}

impl TerminalProcess {
    /// Port of the constructor. Nothing is spawned here — that is `start`.
    pub fn new(
        shell_launch_config: ShellLaunchConfig,
        cwd: String,
        cols: u16,
        rows: u16,
        mut env: ProcessEnvironment,
        executable_env: ProcessEnvironment,
        options: &TerminalProcessOptions,
        sink: Arc<dyn ProcessEventSink>,
    ) -> Self {
        if !cfg!(windows) {
            // `node-pty` turns its `name` option into the child's `TERM`. Using
            // 'xterm-256color' here helps ensure that the majority of Linux
            // distributions will use a color prompt as defined in the default
            // ~/.bashrc file.
            env.insert("TERM".to_owned(), "xterm-256color".to_owned());
        }

        let use_conpty = cfg!(windows) && windows_build_number() >= MINIMUM_CONPTY_BUILD;

        // Delay resizes to avoid conpty not respecting very early resize calls.
        let delayed_resizer = (cfg!(windows)
            && use_conpty
            && cols == 0
            && rows == 0
            && shell_launch_config
                .executable
                .as_deref()
                .is_some_and(|executable| executable.ends_with(r"Git\bin\bash.exe")))
        .then(|| DelayedResize {
            trigger_at: Instant::now() + DELAYED_RESIZE_TIMEOUT,
            cols,
            rows,
        });

        Self {
            initial_cwd: cwd.clone(),
            properties: Mutex::new(Properties {
                cwd: cwd.clone(),
                initial_cwd: cwd.clone(),
                fixed_dimensions: FixedTerminalDimensions::default(),
            }),
            pty_options: Mutex::new(PtyOptions {
                cwd,
                env,
                cols,
                rows,
                use_conpty,
                use_conpty_dll: use_conpty && options.windows_use_conpty_dll,
                resolved_executable: None,
            }),
            shell_launch_config,
            executable_env,
            sink,
            flow: Arc::new(FlowControl::new()),
            running: Arc::new(RwLock::new(None)),
            delayed_resizer: Arc::new(Mutex::new(delayed_resizer)),
            disposed: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Port of `start()`. `Ok(())` is stock's `undefined`; a
    /// [`PtyError::Launch`] is stock's `ITerminalLaunchError`.
    pub async fn start(&self) -> Result<()> {
        // Stock runs both validations concurrently and takes the first error,
        // which is the cwd one.
        self.validate_cwd().await?;
        self.validate_executable().await?;
        self.setup_pty_process().await
    }

    /// Port of `_validateCwd`.
    async fn validate_cwd(&self) -> Result<()> {
        match tokio::fs::metadata(&self.initial_cwd).await {
            Ok(metadata) if !metadata.is_dir() => {
                return Err(PtyError::launch(format!(
                    "Starting directory (cwd) \"{}\" is not a directory",
                    self.initial_cwd
                )))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(PtyError::launch(format!(
                    "Starting directory (cwd) \"{}\" does not exist",
                    self.initial_cwd
                )))
            }
            // Any other error is swallowed, as stock swallows anything but ENOENT.
            _ => {}
        }
        self.fire(ProcessProperty::InitialCwd(self.initial_cwd.clone()));
        Ok(())
    }

    /// Port of `_validateExecutable`, including writing the resolved path back
    /// into the options so the pty does not search `$PATH` a second time.
    async fn validate_executable(&self) -> Result<()> {
        let executable = self
            .shell_launch_config
            .executable
            .clone()
            .ok_or_else(|| PtyError::launch("IShellLaunchConfig.executable not set"))?;

        let cwd = self
            .shell_launch_config
            .cwd
            .as_ref()
            .map(|cwd| PathBuf::from(cwd.as_str()));
        let env_paths: Option<Vec<String>> = self
            .shell_launch_config
            .env
            .as_ref()
            .and_then(|env| env.get("PATH").cloned().flatten())
            .map(|path| path.split(PATH_DELIMITER).map(str::to_owned).collect());
        let executable_env = self.executable_env.clone();

        let lookup = executable.clone();
        let resolved = tokio::task::spawn_blocking(move || {
            find_executable(
                &lookup,
                cwd.as_deref(),
                env_paths.as_deref(),
                Some(&executable_env),
                &file_exists_default,
            )
        })
        .await?;

        let Some(resolved) = resolved else {
            return Err(PtyError::launch(format!(
                "Path to shell executable \"{executable}\" does not exist"
            )));
        };

        match tokio::fs::symlink_metadata(&resolved).await {
            Ok(metadata) if !metadata.is_file() && !metadata.is_symlink() => {
                return Err(PtyError::launch(format!(
                    "Path to shell executable \"{executable}\" is not a file or a symlink"
                )))
            }
            // Stock swallows EACCES here and rethrows anything else; a stat
            // failure on a path `find_executable` just accepted is not a launch
            // failure either way.
            _ => {}
        }

        // Set the executable explicitly here so that the pty doesn't need to
        // search the $PATH too.
        self.options().resolved_executable = Some(resolved);
        Ok(())
    }

    /// Port of `setupPtyProcess`.
    async fn setup_pty_process(&self) -> Result<()> {
        let (executable, args, size, cwd, env, use_conpty, use_conpty_dll) = {
            let options = self.options();
            (
                options
                    .resolved_executable
                    .clone()
                    .or_else(|| self.shell_launch_config.executable.clone().map(PathBuf::from))
                    .ok_or_else(|| PtyError::launch("IShellLaunchConfig.executable not set"))?,
                self.shell_launch_config.args(),
                // Unclamped, as stock passes them: a zero-sized conpty is the
                // very case `DelayedResize` exists for.
                PtySize {
                    rows: options.rows,
                    cols: options.cols,
                    pixel_width: 0,
                    pixel_height: 0,
                },
                options.cwd.clone(),
                options.env.clone(),
                options.use_conpty,
                options.use_conpty_dll,
            )
        };

        throttle_kill_spawn(use_conpty, use_conpty_dll).await;

        log::trace!("pty spawn {} {args:?}", executable.display());
        let spawned = tokio::task::spawn_blocking(move || spawn_pty(&executable, &args, size, &cwd, &env))
            .await??;

        let (control, controls) = mpsc::unbounded_channel();
        let pid = spawned.pid;

        // Stock registers the monitor before the ready event so that the first
        // `hasChildProcesses` answer cannot be missed.
        let monitor = {
            let sink = Arc::clone(&self.sink);
            ChildProcessMonitor::new(pid, move |value| {
                sink.on_did_change_property(ProcessProperty::HasChildProcesses(value));
            })
        };
        // WindowsShellHelper is used to fetch the process title and shell type.
        let windows_shell = cfg!(windows).then(|| {
            let sink = Arc::clone(&self.sink);
            WindowsShellHelper::new(
                pid,
                Box::new(move |shell_type, title| {
                    sink.on_did_change_property(ProcessProperty::ShellType(shell_type));
                    sink.on_did_change_property(ProcessProperty::Title(title));
                }),
            )
        });

        let running = Arc::new(Running {
            pid,
            master: Mutex::new(spawned.master),
            writer: Mutex::new(spawned.writer),
            killer: Mutex::new(spawned.killer),
            monitor,
            windows_shell,
            current_title: Mutex::new(String::new()),
            control: control.clone(),
        });
        *self.running.write().unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some(Arc::clone(&running));

        spawn_reader(spawned.reader, Arc::clone(&self.flow), control.clone());
        spawn_waiter(spawned.child, control);

        // Stock's `_sendProcessId`. It fires before the supervisor starts, which
        // is what makes `_processStartupComplete` — the promise `_kill` awaits so
        // an exit can never precede a start — already resolved by the time
        // anything can kill.
        self.sink.on_process_ready(ProcessReadyEvent {
            pid,
            cwd: self.initial_cwd.clone(),
            windows_pty: get_windows_pty(),
        });

        tokio::spawn(supervise(
            Supervisor {
                sink: Arc::clone(&self.sink),
                flow: Arc::clone(&self.flow),
                running: Arc::clone(&self.running),
                disposed: Arc::clone(&self.disposed),
                use_conpty,
                use_conpty_dll,
                exit_code: None,
                close_deadline: None,
                max_shutdown_deadline: None,
                // Stock sends the initial title on a zero timeout, to give event
                // listeners a chance to init.
                title_deadline: Some(Instant::now()),
                delayed_resize: Arc::clone(&self.delayed_resizer),
            },
            running,
            controls,
        ));

        Ok(())
    }

    //#region ITerminalChildProcess

    /// Port of `input(data, isBinary)`.
    pub async fn input(&self, data: &str, is_binary: bool) -> Result<()> {
        let Some(running) = self.running() else {
            return Ok(());
        };
        let bytes = if is_binary {
            // Stock writes `Buffer.from(data, 'binary')`: one byte per UTF-16
            // code unit, truncated.
            data.encode_utf16().map(|unit| (unit & 0xFF) as u8).collect()
        } else {
            data.as_bytes().to_vec()
        };

        // A pty write blocks when the child is not draining its input, so it
        // does not belong on the runtime.
        let handle = Arc::clone(&running);
        tokio::task::spawn_blocking(move || {
            let mut writer = handle
                .writer
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Err(error) = writer.write_all(&bytes) {
                log::trace!("pty write failed: {error}");
            } else if let Err(error) = writer.flush() {
                log::trace!("pty flush failed: {error}");
            }
        })
        .await?;

        running.monitor.handle_input();
        Ok(())
    }

    /// Port of `processBinary(data)`.
    pub async fn process_binary(&self, data: &str) -> Result<()> {
        self.input(data, true).await
    }

    /// Port of `sendSignal(signal)`.
    pub fn send_signal(&self, signal: &str) {
        if let Some(running) = self.running() {
            crate::ps::send_signal(running.pid, signal);
        }
    }

    /// Port of `resize(cols, rows, pixelWidth?, pixelHeight?)`.
    pub fn resize(&self, cols: u16, rows: u16, pixel_width: Option<u16>, pixel_height: Option<u16>) {
        let Some(running) = self.running() else {
            return;
        };

        // Ensure that cols and rows are always >= 1, this prevents a native
        // exception in the backend.
        let cols = cols.max(1);
        let rows = rows.max(1);

        // Delay resize if needed
        {
            let mut delayed = self
                .delayed_resizer
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(delayed) = delayed.as_mut() {
                delayed.cols = cols;
                delayed.rows = rows;
                return;
            }
        }

        resize_master(&running, cols, rows, pixel_width, pixel_height);
    }

    /// Port of `clearBuffer()`. See the deviation note in the module docs.
    pub fn clear_buffer(&self) {}

    /// Port of `acknowledgeDataEvent(charCount)`.
    pub fn acknowledge_data_event(&self, char_count: usize) {
        self.flow.acknowledge(char_count);
    }

    /// Port of `clearUnacknowledgedChars()`.
    pub fn clear_unacknowledged_chars(&self) {
        self.flow.clear_unacknowledged();
    }

    /// Port of `shutdown(immediate)`.
    pub fn shutdown(&self, immediate: bool) {
        let Some(running) = self.running() else {
            return;
        };
        let _ = running.control.send(Control::Shutdown { immediate });
    }

    /// Port of `getInitialCwd()`.
    pub fn initial_cwd(&self) -> String {
        self.initial_cwd.clone()
    }

    /// Port of `getCwd()`.
    pub async fn get_cwd(&self) -> String {
        let Some(running) = self.running() else {
            return self.initial_cwd.clone();
        };
        current_working_directory(running.pid)
            .await
            .unwrap_or_else(|| self.initial_cwd.clone())
    }

    /// Port of `refreshProperty(type)`. The value the frontend reads is the
    /// `value` half of the returned property, so there is one shape for a
    /// refresh and for the event it may fire.
    pub async fn refresh_property(&self, property: ProcessPropertyType) -> ProcessProperty {
        match property {
            ProcessPropertyType::Cwd => {
                let new_cwd = self.get_cwd().await;
                let changed = {
                    let mut properties = self.properties();
                    let changed = properties.cwd != new_cwd;
                    if changed {
                        properties.cwd.clone_from(&new_cwd);
                    }
                    changed
                };
                let property = ProcessProperty::Cwd(new_cwd);
                if changed {
                    self.fire(property.clone());
                }
                property
            }
            ProcessPropertyType::InitialCwd => {
                let initial_cwd = self.initial_cwd.clone();
                let changed = {
                    let mut properties = self.properties();
                    let changed = properties.initial_cwd != initial_cwd;
                    if changed {
                        properties.initial_cwd.clone_from(&initial_cwd);
                    }
                    changed
                };
                let property = ProcessProperty::InitialCwd(initial_cwd);
                if changed {
                    self.fire(property.clone());
                }
                property
            }
            ProcessPropertyType::Title => ProcessProperty::Title(self.current_title()),
            // Stock's `default:` arm returns the shell type for everything else.
            _ => ProcessProperty::ShellType(self.shell_type()),
        }
    }

    /// Port of `updateProperty(type, value)`, which stores `FixedDimensions` and
    /// ignores every other property.
    pub fn set_fixed_dimensions(&self, dimensions: FixedTerminalDimensions) {
        self.properties().fixed_dimensions = dimensions;
    }

    /// Port of `get currentTitle()`.
    pub fn current_title(&self) -> String {
        let Some(running) = self.running() else {
            return String::new();
        };
        let windows_title = running
            .windows_shell
            .as_ref()
            .map(WindowsShellHelper::shell_title)
            .filter(|title| !title.is_empty());
        windows_title.unwrap_or_else(|| {
            running
                .current_title
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
        })
    }

    /// Port of `get shellType()`.
    pub fn shell_type(&self) -> Option<TerminalShellType> {
        let running = self.running()?;
        if cfg!(windows) {
            return running.windows_shell.as_ref().and_then(WindowsShellHelper::shell_type);
        }
        let title = running
            .current_title
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        posix_shell_type(&title).or_else(|| general_shell_type(&title))
    }

    /// Port of `get hasChildProcesses()`.
    pub fn has_child_processes(&self) -> bool {
        self.running()
            .is_some_and(|running| running.monitor.has_child_processes())
    }

    //#endregion

    fn running(&self) -> Option<Arc<Running>> {
        self.running
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn options(&self) -> MutexGuard<'_, PtyOptions> {
        self.pty_options.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn properties(&self) -> MutexGuard<'_, Properties> {
        self.properties.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn fire(&self, property: ProcessProperty) {
        self.sink.on_did_change_property(property);
    }
}

//#endregion

//#region Spawning

/// What `spawn_command` hands back, split into the halves the threads own.
struct Spawned {
    pid: u32,
    master: Box<dyn MasterPty + Send>,
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

/// Blocking: opens the pty and forks. Called inside `spawn_blocking`.
fn spawn_pty(
    executable: &Path,
    args: &[String],
    size: PtySize,
    cwd: &str,
    env: &ProcessEnvironment,
) -> Result<Spawned> {
    let pair = native_pty_system()
        .openpty(size)
        .map_err(PtyError::pty("failed to open a pty"))?;

    let mut command = CommandBuilder::new(executable);
    for arg in args {
        command.arg(arg);
    }
    command.cwd(cwd);
    // The frontend computes the whole environment; `node-pty` replaces rather
    // than extends the parent's, so this does too.
    command.env_clear();
    for (key, value) in env {
        command.env(key, value);
    }

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(PtyError::pty("failed to spawn the shell"))?;
    // The slave must be closed in this process or the master never sees EOF.
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(PtyError::pty("failed to read from the pty"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(PtyError::pty("failed to write to the pty"))?;

    Ok(Spawned {
        pid: child.process_id().unwrap_or(0),
        killer: child.clone_killer(),
        master: pair.master,
        reader,
        writer,
        child,
    })
}

/// The reader thread. A dedicated OS thread rather than a `spawn_blocking` slot:
/// it blocks for the terminal's whole life, and tokio's blocking pool is for
/// work that finishes.
fn spawn_reader(
    mut reader: Box<dyn Read + Send>,
    flow: Arc<FlowControl>,
    control: mpsc::UnboundedSender<Control>,
) {
    std::thread::spawn(move || {
        let mut decoder = Utf8Decoder::new();
        let mut buffer = vec![0u8; READ_BUFFER_SIZE];
        loop {
            // Flow control: parking here instead of reading is what applies
            // backpressure to the child, which is what `node-pty`'s `pause()`
            // does.
            if !flow.wait_until_resumed() {
                return;
            }
            let read = match reader.read(&mut buffer) {
                Ok(0) | Err(_) => return,
                Ok(read) => read,
            };
            let data = decoder.push(&buffer[..read]);
            if data.is_empty() {
                continue;
            }
            flow.on_data(FlowControl::char_count(&data));
            if control.send(Control::Data(data)).is_err() {
                return;
            }
        }
    });
}

/// The waiter thread, standing in for `node-pty`'s `onExit`.
fn spawn_waiter(
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    control: mpsc::UnboundedSender<Control>,
) {
    std::thread::spawn(move || {
        let code = child.wait().map_or(0, |status| status.exit_code());
        let _ = control.send(Control::Exit(code));
    });
}

/// Port of `getWindowsPty()`.
fn get_windows_pty() -> Option<ProcessReadyWindowsPty> {
    cfg!(windows).then(|| ProcessReadyWindowsPty {
        backend: "conpty",
        build_number: windows_build_number(),
    })
}

fn resize_master(
    running: &Running,
    cols: u16,
    rows: u16,
    pixel_width: Option<u16>,
    pixel_height: Option<u16>,
) {
    let size = PtySize {
        rows,
        cols,
        pixel_width: pixel_width.unwrap_or(0),
        pixel_height: pixel_height.unwrap_or(0),
    };
    let master = running
        .master
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Err(error) = master.resize(size) {
        // Swallow error if the pty has already exited.
        log::trace!("pty resize exception: {error}");
    }
}

/// Port of `_throttleKillSpawn`. The last kill or spawn is process-wide, as
/// stock's `private static _lastKillOrStart` is.
async fn throttle_kill_spawn(use_conpty: bool, use_conpty_dll: bool) {
    static LAST_KILL_OR_START: Mutex<Option<std::time::Instant>> = Mutex::new(None);

    // Only throttle on Windows/conpty, and not when using conpty.dll as the hang
    // seems to have been fixed in later versions.
    if !cfg!(windows) || !use_conpty || use_conpty_dll {
        return;
    }

    // Use a loop to ensure multiple calls in a single interval space out.
    loop {
        let elapsed = LAST_KILL_OR_START
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .map_or(KILL_SPAWN_THROTTLE_INTERVAL, |last| last.elapsed());
        if elapsed >= KILL_SPAWN_THROTTLE_INTERVAL {
            break;
        }
        log::trace!("Throttling kill/spawn call");
        tokio::time::sleep(KILL_SPAWN_THROTTLE_INTERVAL - elapsed + KILL_SPAWN_SPACING_DURATION)
            .await;
    }
    *LAST_KILL_OR_START
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(std::time::Instant::now());
}

//#endregion

//#region Supervisor

/// The exit sequencing and the timers, which stock runs on Node's event loop.
struct Supervisor {
    sink: Arc<dyn ProcessEventSink>,
    flow: Arc<FlowControl>,
    running: RunningCell,
    disposed: Arc<AtomicBool>,
    use_conpty: bool,
    use_conpty_dll: bool,
    /// Stock's `_exitCode`.
    exit_code: Option<u32>,
    /// Stock's `_closeTimeout`.
    close_deadline: Option<Instant>,
    /// The `MaximumShutdownTime` timer `shutdown` arms.
    max_shutdown_deadline: Option<Instant>,
    /// Stock's `_titleInterval`, plus the initial zero-delay send.
    title_deadline: Option<Instant>,
    delayed_resize: Arc<Mutex<Option<DelayedResize>>>,
}

async fn supervise(
    mut state: Supervisor,
    running: Arc<Running>,
    mut controls: mpsc::UnboundedReceiver<Control>,
) {
    loop {
        let close_deadline = state.close_deadline;
        let max_shutdown_deadline = state.max_shutdown_deadline;
        let title_deadline = state.title_deadline;
        let resize_deadline = state
            .delayed_resize
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .map(|resize| resize.trigger_at);

        tokio::select! {
            control = controls.recv() => {
                let Some(control) = control else { break };
                match control {
                    Control::Data(data) => {
                        state.sink.on_process_data(data);
                        // Allow any trailing data events to be sent before the
                        // exit event is sent.
                        if state.close_deadline.is_some() {
                            state.close_deadline = Some(Instant::now() + DATA_FLUSH_TIMEOUT);
                        }
                        if let Some(helper) = running.windows_shell.as_ref() {
                            helper.check_shell();
                        }
                        running.monitor.handle_output();
                    }
                    Control::Exit(code) => {
                        state.exit_code = Some(code);
                        state.close_deadline = Some(Instant::now() + DATA_FLUSH_TIMEOUT);
                    }
                    Control::Shutdown { immediate } => {
                        // Don't force immediate disposal on Windows as an
                        // additional mitigation for microsoft/vscode#71966,
                        // which makes the pty host unresponsive.
                        if immediate && !cfg!(windows) {
                            break;
                        }
                        if state.close_deadline.is_none() {
                            let now = Instant::now();
                            state.close_deadline = Some(now + DATA_FLUSH_TIMEOUT);
                            // Allow a maximum amount of time for the process to
                            // exit, otherwise force kill it.
                            state.max_shutdown_deadline = Some(now + MAXIMUM_SHUTDOWN_TIME);
                        }
                    }
                }
            }
            () = sleep_until(close_deadline) => {
                state.close_deadline = None;
                break;
            }
            () = sleep_until(max_shutdown_deadline) => {
                state.max_shutdown_deadline = None;
                if state.close_deadline.is_some() {
                    state.close_deadline = None;
                    break;
                }
            }
            () = sleep_until(title_deadline) => {
                send_process_title(&state, &running);
                // Setup polling for non-Windows; for Windows `process` doesn't
                // change.
                state.title_deadline = (!cfg!(windows))
                    .then(|| Instant::now() + TITLE_POLL_INTERVAL);
            }
            () = sleep_until(resize_deadline) => {
                let resize = state
                    .delayed_resize
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .take();
                if let Some(resize) = resize {
                    if resize.cols > 0 && resize.rows > 0 {
                        resize_master(&running, resize.cols, resize.rows, None, None);
                    }
                }
            }
        }
    }

    kill(&state, &running).await;
}

/// Port of `_kill()`.
async fn kill(state: &Supervisor, running: &Running) {
    if state.disposed.swap(true, Ordering::AcqRel) {
        return;
    }

    // Attempt to kill the pty, it may have already been killed at this point but
    // we want to make sure.
    throttle_kill_spawn(state.use_conpty, state.use_conpty_dll).await;
    log::trace!("pty kill");
    let _ = running
        .killer
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .kill();

    state.sink.on_process_exit(Some(state.exit_code.unwrap_or(0)));

    // Dispose: release the reader and stop `input` / `resize` reaching a dead
    // pty, which is what clearing `_ptyProcess` does upstream.
    state.flow.dispose();
    *state
        .running
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
}

/// Port of `_sendProcessTitle(ptyProcess)`.
fn send_process_title(state: &Supervisor, running: &Running) {
    let title = process_name(running);
    {
        let mut current = running
            .current_title
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if *current == title && !current.is_empty() {
            return;
        }
        current.clone_from(&title);
    }
    state
        .sink
        .on_did_change_property(ProcessProperty::Title(title.clone()));

    // If fig is installed it may change the title of the process.
    let mut sanitized = title.strip_suffix(" (figterm)").unwrap_or(&title).to_owned();
    // Ensure any prefixed path is removed, since the executable name is what
    // detects the shell type.
    if !cfg!(windows) {
        sanitized = node_basename(&sanitized);
    }

    let lowered = sanitized.to_lowercase();
    let shell_type = if lowered.starts_with("python") {
        Some(TerminalShellType::Python)
    } else if lowered.starts_with("julia") {
        Some(TerminalShellType::Julia)
    } else {
        posix_shell_type(&sanitized).or_else(|| general_shell_type(&sanitized))
    };
    state
        .sink
        .on_did_change_property(ProcessProperty::ShellType(shell_type));
}

/// `node-pty`'s `IPty.process`: the name of the pty's foreground process.
#[cfg(unix)]
fn process_name(running: &Running) -> String {
    let leader = {
        let master = running
            .master
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        master.process_group_leader()
    };
    leader
        .and_then(|pid| crate::ps::process_name(pid.unsigned_abs()))
        .unwrap_or_default()
}

/// On Windows the title comes from [`WindowsShellHelper`]; see the module docs.
#[cfg(windows)]
fn process_name(running: &Running) -> String {
    crate::ps::process_name(running.pid).unwrap_or_default()
}

/// Port of `getCwd()`'s per-platform bodies.
#[cfg(target_os = "macos")]
async fn current_working_directory(pid: u32) -> Option<String> {
    // From Big Sur there is a spawn blocking thread issue on Electron
    // (microsoft/vscode#105446), which is why stock shells out rather than
    // reading it directly.
    let output = tokio::process::Command::new("lsof")
        .args(["-OPln", "-p", &pid.to_string()])
        .env("LANG", "en_US.UTF-8")
        .output()
        .await
        .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout.lines().find(|line| line.contains("cwd"))?;
    let start = line.find('/')?;
    Some(line[start..].trim_end().to_owned())
}

#[cfg(target_os = "linux")]
async fn current_working_directory(pid: u32) -> Option<String> {
    tokio::fs::read_link(format!("/proc/{pid}/cwd"))
        .await
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
}

/// Stock returns the initial cwd on every other platform, Windows included.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
async fn current_working_directory(_pid: u32) -> Option<String> {
    None
}

//#endregion

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_types_come_from_the_process_title() {
        assert_eq!(posix_shell_type("zsh"), Some(TerminalShellType::Zsh));
        assert_eq!(posix_shell_type("pwsh"), None);
        assert_eq!(general_shell_type("pwsh"), Some(TerminalShellType::PowerShell));
        assert_eq!(
            general_shell_type("powershell"),
            Some(TerminalShellType::PowerShell)
        );
        assert_eq!(general_shell_type("nu"), Some(TerminalShellType::NuShell));
        assert_eq!(general_shell_type("emacs"), None);
    }

    #[test]
    fn binary_input_is_one_byte_per_code_unit() {
        let bytes: Vec<u8> = "a\u{00e9}\u{0141}"
            .encode_utf16()
            .map(|unit| (unit & 0xFF) as u8)
            .collect();
        // 0x0141 truncates to 0x41, which is what `Buffer.from(s, 'binary')` does.
        assert_eq!(bytes, vec![0x61, 0xe9, 0x41]);
    }
}
