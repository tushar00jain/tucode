//! The `pty` channel — terminals over `tscode_pty`.
//!
//! Like `scm` this has no stock server to port: upstream's pty host is reached
//! over a `MessagePort`, not an `IChannel`. The command names are therefore
//! `ITerminalChildProcess`'s own plus the handful of discovery calls
//! `IPtyService` exposes (`getDefaultSystemShell`, `getShellEnvironment`,
//! `getWslPath`), each taking a single named-argument object.
//!
//! Two things this layer owns that the crate deliberately does not:
//!
//! - **Pty ids.** Stock's `TerminalProcess` has no id — `ptyService.ts` wraps it
//!   in a `PersistentTerminalProcess` that does. Nothing persists here, so the
//!   id is only a handle for the frontend to name one process across calls.
//! - **Subscriptions.** A terminal's four events are four `listen` calls, each
//!   with its own subscription id, and all four are keyed by `ptyId` so one
//!   terminal's output never reaches another's. The crate sees one
//!   [`ProcessEventSink`] and never learns what a subscription is.
//!
//! `acknowledgeDataEvent` is the one command whose *rate* is part of the
//! contract: the frontend acks every `CharCountAckSize` characters, and a pty
//! that stops being acked pauses at the high watermark and never resumes. See
//! `tscode_pty::flow`.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use tscode_pty::process::TerminalProcess;
use tscode_pty::profiles::{DetectOptions, DiskFsProvider, FsProvider};
use tscode_pty::types::{
    FixedTerminalDimensions, OperatingSystem, ProcessEnvironment, ProcessProperty,
    ProcessPropertyType, ProcessReadyEvent, ShellLaunchConfig, TerminalProcessOptions,
    UnresolvedTerminalProfile,
};
use tscode_pty::windows_version::windows_build_number;
use tscode_pty::{
    current_environment, file_exists_default, find_executable, get_resolved_shell_env,
    get_system_shell, get_wsl_path, ProcessEventSink, PtyError, PtyRegistry, WslDirection,
};

use crate::channel::{ChannelError, ChannelErrorCode, EventSink, ServerChannel, Subscription};
use crate::channels::{json, params, unknown_command, unknown_event};

const CHANNEL: &str = "pty";

fn from_pty_error(error: PtyError) -> ChannelError {
    let code = match &error {
        // The frontend addressed a terminal that has exited and been swept.
        PtyError::NoSuchProcess(_) => ChannelErrorCode::Unavailable,
        _ => ChannelErrorCode::Unknown,
    };
    ChannelError::new(code, error.to_string())
}

//#region Wire model

/// Stock `ITerminalLaunchError`, in the `{ error }` arm of `start`'s result.
#[derive(Debug, Serialize)]
struct WireLaunchError {
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<i32>,
}

#[derive(Debug, Serialize)]
struct WireStartFailure {
    error: WireLaunchError,
}

/// `IProcessEnvironment` is `{ [key: string]: string }`, but the frontend builds
/// it from an `ITerminalEnvironment` where a `null` means "unset this". A null
/// that survives to here is that removal, so it is dropped rather than rejected.
///
/// The result is optional because an absent environment is not an empty one:
/// `findExecutable` falls back to this process's environment for it.
fn deserialize_environment<'de, D>(deserializer: D) -> Result<Option<ProcessEnvironment>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Option::<HashMap<String, Option<String>>>::deserialize(deserializer)?.map(|env| {
        env.into_iter()
            .filter_map(|(key, value)| value.map(|value| (key, value)))
            .collect()
    }))
}

//#endregion

//#region Command parameters

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateParams {
    shell_launch_config: ShellLaunchConfig,
    cwd: String,
    cols: u16,
    rows: u16,
    #[serde(default, deserialize_with = "deserialize_environment")]
    env: Option<ProcessEnvironment>,
    #[serde(default, deserialize_with = "deserialize_environment")]
    executable_env: Option<ProcessEnvironment>,
    #[serde(default)]
    options: TerminalProcessOptions,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PtyIdParams {
    pty_id: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InputParams {
    pty_id: u32,
    data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResizeParams {
    pty_id: u32,
    cols: u16,
    rows: u16,
    #[serde(default)]
    pixel_width: Option<u16>,
    #[serde(default)]
    pixel_height: Option<u16>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcknowledgeParams {
    pty_id: u32,
    char_count: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShutdownParams {
    pty_id: u32,
    #[serde(default)]
    immediate: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignalParams {
    pty_id: u32,
    signal: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefreshPropertyParams {
    pty_id: u32,
    property: ProcessPropertyType,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdatePropertyParams {
    pty_id: u32,
    property: ProcessPropertyType,
    #[serde(default)]
    value: Value,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DefaultShellParams {
    #[serde(default)]
    os_override: Option<OperatingSystem>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DetectProfilesParams {
    #[serde(default)]
    profiles: BTreeMap<String, Option<UnresolvedTerminalProfile>>,
    #[serde(default)]
    default_profile: Option<String>,
    #[serde(default)]
    include_detected_profiles: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FindExecutableParams {
    command: String,
    #[serde(default)]
    cwd: Option<PathBuf>,
    #[serde(default)]
    paths: Option<Vec<String>>,
    #[serde(default, deserialize_with = "deserialize_environment")]
    env: Option<ProcessEnvironment>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WslPathParams {
    original: String,
    direction: WslDirection,
}

//#endregion

//#region Subscriptions

/// One terminal's four event sinks. A `None` is an event the frontend has not
/// subscribed to, or has disposed; emitting into it is a no-op, exactly as
/// firing a stock `Emitter` with no listeners is.
#[derive(Default)]
struct PtySubscriptions {
    data: Option<EventSink>,
    ready: Option<EventSink>,
    exit: Option<EventSink>,
    property: Option<EventSink>,
}

/// Which of the four a `listen` or its teardown addresses.
#[derive(Debug, Clone, Copy)]
enum PtyEvent {
    Data,
    Ready,
    Exit,
    Property,
}

impl PtyEvent {
    fn from_name(event: &str) -> Option<Self> {
        match event {
            "onProcessData" => Some(Self::Data),
            "onProcessReady" => Some(Self::Ready),
            "onProcessExit" => Some(Self::Exit),
            "onDidChangeProperty" => Some(Self::Property),
            _ => None,
        }
    }

    fn slot(self, subscriptions: &mut PtySubscriptions) -> &mut Option<EventSink> {
        match self {
            Self::Data => &mut subscriptions.data,
            Self::Ready => &mut subscriptions.ready,
            Self::Exit => &mut subscriptions.exit,
            Self::Property => &mut subscriptions.property,
        }
    }
}

/// The processes and their subscriptions.
///
/// Held behind an `Arc` because a subscription's teardown closure and a
/// process's event sink both outlive the `&self` that created them.
#[derive(Default)]
struct PtyState {
    registry: PtyRegistry,
    subscriptions: Mutex<HashMap<u32, PtySubscriptions>>,
}

impl PtyState {
    fn subscriptions(&self) -> MutexGuard<'_, HashMap<u32, PtySubscriptions>> {
        self.subscriptions.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn emit<T: Serialize + Clone>(
        &self,
        pty_id: u32,
        event: PtyEvent,
        payload: T,
    ) {
        let sink = self
            .subscriptions()
            .get_mut(&pty_id)
            .and_then(|subscriptions| event.slot(subscriptions).clone());
        if let Some(sink) = sink {
            if let Err(error) = sink.emit(payload) {
                log::warn!("pty: dropping a {event:?} event: {error}");
            }
        }
    }

    /// The terminal is gone: forget the process and the sinks together, so a
    /// later command on its id is `Unavailable` rather than a silent no-op.
    fn forget(&self, pty_id: u32) {
        self.registry.remove(pty_id);
        self.subscriptions().remove(&pty_id);
    }
}

/// The crate's [`ProcessEventSink`] for one pty.
///
/// Holds the state weakly: the state owns the registry, the registry owns the
/// process, and the process owns this.
struct ChannelEventSink {
    pty_id: u32,
    state: Weak<PtyState>,
}

impl ProcessEventSink for ChannelEventSink {
    fn on_process_data(&self, data: String) {
        if let Some(state) = self.state.upgrade() {
            state.emit(self.pty_id, PtyEvent::Data, data);
        }
    }

    fn on_process_ready(&self, event: ProcessReadyEvent) {
        if let Some(state) = self.state.upgrade() {
            state.emit(self.pty_id, PtyEvent::Ready, event);
        }
    }

    fn on_process_exit(&self, code: Option<u32>) {
        if let Some(state) = self.state.upgrade() {
            state.emit(self.pty_id, PtyEvent::Exit, code);
            state.forget(self.pty_id);
        }
    }

    fn on_did_change_property(&self, property: ProcessProperty) {
        if let Some(state) = self.state.upgrade() {
            state.emit(self.pty_id, PtyEvent::Property, property);
        }
    }
}

//#endregion

/// The `pty` channel.
pub struct PtyChannel {
    state: Arc<PtyState>,
    fs: Arc<dyn FsProvider>,
}

impl PtyChannel {
    pub fn new() -> Self {
        Self {
            state: Arc::new(PtyState::default()),
            fs: Arc::new(DiskFsProvider),
        }
    }

    /// Shut every terminal down and wait for its child to be reaped. Called when
    /// the window is destroyed — the frontend that owned them is gone.
    pub async fn shutdown_all(&self) {
        self.state.registry.shutdown_all().await;
    }

    fn process(&self, pty_id: u32) -> Result<Arc<TerminalProcess>, ChannelError> {
        self.state.registry.get(pty_id).map_err(from_pty_error)
    }

    /// Port of `TerminalProcess`'s constructor call in `ptyService.createProcess`.
    fn create(&self, arg: Value) -> Result<Value, ChannelError> {
        let params: CreateParams = params(CHANNEL, arg)?;
        let state = Arc::clone(&self.state);

        let pty_id = self.state.registry.create(|pty_id| {
            let sink = Arc::new(ChannelEventSink {
                pty_id,
                state: Arc::downgrade(&state),
            });
            Arc::new(TerminalProcess::new(
                params.shell_launch_config,
                params.cwd,
                params.cols,
                params.rows,
                params.env.unwrap_or_default(),
                params.executable_env.unwrap_or_default(),
                &params.options,
                sink,
            ))
        });

        Ok(Value::from(pty_id))
    }

    /// Port of `start()`. `null` is stock's `undefined`; a launch failure is
    /// data, not an error, because the frontend renders it inside the terminal.
    async fn start(&self, arg: Value) -> Result<Value, ChannelError> {
        let params: PtyIdParams = params(CHANNEL, arg)?;
        match self.process(params.pty_id)?.start().await {
            Ok(()) => Ok(Value::Null),
            // Stock keeps the process registered on a launch failure: the
            // frontend renders the message inside the terminal and disposes the
            // instance, which is what sweeps it.
            Err(PtyError::Launch { message, code }) => json(&WireStartFailure {
                error: WireLaunchError { message, code },
            }),
            Err(error) => Err(from_pty_error(error)),
        }
    }

    async fn refresh_property(&self, arg: Value) -> Result<Value, ChannelError> {
        let params: RefreshPropertyParams = params(CHANNEL, arg)?;
        let property = self.process(params.pty_id)?.refresh_property(params.property).await;
        // `refreshProperty` returns the value, and `onDidChangeProperty` carries
        // the `{ type, value }` pair; one shape produces both.
        let mut wire = json(&property)?;
        Ok(wire.get_mut("value").map_or(Value::Null, Value::take))
    }

    /// Port of `updateProperty(type, value)`, which stores `FixedDimensions` and
    /// ignores every other property.
    fn update_property(&self, arg: Value) -> Result<Value, ChannelError> {
        let params: UpdatePropertyParams = params(CHANNEL, arg)?;
        let process = self.process(params.pty_id)?;
        if params.property == ProcessPropertyType::FixedDimensions {
            let dimensions: FixedTerminalDimensions = serde_json::from_value(params.value)
                .map_err(|error| ChannelError::unknown(format!("bad fixedDimensions: {error}")))?;
            process.set_fixed_dimensions(dimensions);
        }
        Ok(Value::Null)
    }

    async fn detect_profiles(&self, arg: Value) -> Result<Value, ChannelError> {
        let params: DetectProfilesParams = params(CHANNEL, arg)?;
        let profiles = tscode_pty::detect_available_profiles(
            DetectOptions {
                profiles: params.profiles,
                default_profile: params.default_profile,
                include_detected_profiles: params.include_detected_profiles,
                // Stock reads `terminal.integrated.useWslProfiles !== false`
                // from configuration, which the wire contract does not carry;
                // its default is on.
                use_wsl_profiles: true,
                shell_env: current_environment(),
                test_pwsh_source_paths: None,
            },
            Arc::clone(&self.fs),
        )
        .await;
        json(&profiles)
    }

    async fn find_executable(&self, arg: Value) -> Result<Value, ChannelError> {
        let params: FindExecutableParams = params(CHANNEL, arg)?;
        let found = tokio::task::spawn_blocking(move || {
            find_executable(
                &params.command,
                params.cwd.as_deref(),
                params.paths.as_deref(),
                params.env.as_ref(),
                &file_exists_default,
            )
        })
        .await
        .map_err(|error| ChannelError::unknown(error.to_string()))?;

        Ok(found.map_or(Value::Null, |path| {
            Value::String(path.to_string_lossy().into_owned())
        }))
    }

    async fn default_system_shell(&self, arg: Value) -> Result<Value, ChannelError> {
        let params: DefaultShellParams = params(CHANNEL, arg)?;
        let os = params.os_override.unwrap_or_else(OperatingSystem::host);
        let shell = tokio::task::spawn_blocking(move || {
            get_system_shell(os, &current_environment())
        })
        .await
        .map_err(|error| ChannelError::unknown(error.to_string()))?;
        Ok(Value::String(shell))
    }
}

impl Default for PtyChannel {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl ServerChannel for PtyChannel {
    async fn call(&self, command: &str, arg: Value) -> Result<Value, ChannelError> {
        match command {
            "create" => self.create(arg),
            "start" => self.start(arg).await,
            "input" => {
                let params: InputParams = params(CHANNEL, arg)?;
                self.process(params.pty_id)?
                    .input(&params.data, false)
                    .await
                    .map_err(from_pty_error)?;
                Ok(Value::Null)
            }
            "processBinary" => {
                let params: InputParams = params(CHANNEL, arg)?;
                self.process(params.pty_id)?
                    .process_binary(&params.data)
                    .await
                    .map_err(from_pty_error)?;
                Ok(Value::Null)
            }
            "resize" => {
                let params: ResizeParams = params(CHANNEL, arg)?;
                self.process(params.pty_id)?.resize(
                    params.cols,
                    params.rows,
                    params.pixel_width,
                    params.pixel_height,
                );
                Ok(Value::Null)
            }
            "clearBuffer" => {
                let params: PtyIdParams = params(CHANNEL, arg)?;
                self.process(params.pty_id)?.clear_buffer();
                Ok(Value::Null)
            }
            "acknowledgeDataEvent" => {
                let params: AcknowledgeParams = params(CHANNEL, arg)?;
                self.process(params.pty_id)?
                    .acknowledge_data_event(params.char_count);
                Ok(Value::Null)
            }
            // Not on `ITerminalChildProcess`: stock's
            // `PersistentTerminalProcess.triggerReplay` calls it on the concrete
            // process. Every replay clears the count, so a pty paused at the
            // high watermark is resumed by the replay rather than only by acks.
            "clearUnacknowledgedChars" => {
                let params: PtyIdParams = params(CHANNEL, arg)?;
                self.process(params.pty_id)?.clear_unacknowledged_chars();
                Ok(Value::Null)
            }
            "shutdown" => {
                let params: ShutdownParams = params(CHANNEL, arg)?;
                self.process(params.pty_id)?.shutdown(params.immediate);
                Ok(Value::Null)
            }
            "sendSignal" => {
                let params: SignalParams = params(CHANNEL, arg)?;
                self.process(params.pty_id)?.send_signal(&params.signal);
                Ok(Value::Null)
            }
            "getInitialCwd" => {
                let params: PtyIdParams = params(CHANNEL, arg)?;
                Ok(Value::String(self.process(params.pty_id)?.initial_cwd()))
            }
            "getCwd" => {
                let params: PtyIdParams = params(CHANNEL, arg)?;
                Ok(Value::String(self.process(params.pty_id)?.get_cwd().await))
            }
            "refreshProperty" => self.refresh_property(arg).await,
            "updateProperty" => self.update_property(arg),
            "getDefaultSystemShell" => self.default_system_shell(arg).await,
            "getEnvironment" => json(&current_environment()),
            // Stock reads the build number in-process, inside the pty host that
            // runs `getShellIntegrationInjection`; ours runs in the renderer,
            // and its build-18309 check gates shell integration on Windows.
            "getWindowsBuildNumber" => Ok(Value::from(windows_build_number())),
            // Port of the sandbox preload's `resolveShellEnv`, which answers
            // `{ ...process.env, ...shellEnv }` — not `getResolvedShellEnv` alone.
            // That one contributes only what a *login shell* adds, which on
            // Windows is nothing at all, so the process environment underneath it
            // is what the terminal actually inherits. Stock's `userEnv` has no
            // counterpart here: it is the desktop CLI's `--user-env` argument.
            "getShellEnv" => {
                let mut env = current_environment();
                env.extend(get_resolved_shell_env().await);
                json(&env)
            }
            "detectProfiles" => self.detect_profiles(arg).await,
            "findExecutable" => self.find_executable(arg).await,
            "getWslPath" => {
                let params: WslPathParams = params(CHANNEL, arg)?;
                Ok(Value::String(
                    get_wsl_path(&params.original, params.direction).await,
                ))
            }
            other => Err(unknown_command(CHANNEL, other)),
        }
    }

    /// One subscription per event per pty. Stock's `TerminalProcess` fires into
    /// `Emitter`s with no listeners quite happily, so an event nobody has
    /// subscribed to is dropped rather than being an error.
    fn listen(&self, event: &str, arg: Value, sink: EventSink) -> Result<Subscription, ChannelError> {
        let Some(event) = PtyEvent::from_name(event) else {
            return Err(unknown_event(CHANNEL, event));
        };
        let params: PtyIdParams = params(CHANNEL, arg)?;
        let pty_id = params.pty_id;

        *event.slot(self.state.subscriptions().entry(pty_id).or_default()) = Some(sink);

        let state = Arc::downgrade(&self.state);
        Ok(Subscription::new(move || {
            if let Some(state) = state.upgrade() {
                if let Some(subscriptions) = state.subscriptions().get_mut(&pty_id) {
                    *event.slot(subscriptions) = None;
                }
            }
        }))
    }
}
