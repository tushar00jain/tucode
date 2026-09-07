//! Server half of VS Code's `IChannel` seam.
//!
//! The frontend implements stock `IChannel` over Tauri in
//! `src/vs/base/parts/ipc/tauri/`: `call()` becomes [`channel_call`], `listen()`
//! becomes [`channel_listen`] plus a Tauri event stream. This module is the mirror
//! image — VS Code's `IServerChannel` as the [`ServerChannel`] trait, a name-keyed
//! registry of implementations, and the subscription bookkeeping that turns
//! `listen()` into events on `tscode:sub:{subscription_id}`.
//!
//! Argument names cross the boundary in camelCase: Tauri v2 renames command
//! arguments by default, so the frontend sends `subscriptionId`, not
//! `subscription_id`.

use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

/// The six channel names the frontend may address. Nothing else is registrable.
pub const CHANNEL_NAMES: [&str; 6] = ["file", "watch", "search", "scm", "sl", "pty"];

/// Prefix of the Tauri event name a subscription's payloads are emitted on.
pub const SUBSCRIPTION_EVENT_PREFIX: &str = "tscode:sub:";

/// The Tauri event name carrying payloads for `subscription_id`.
///
/// Both sides derive the name from the id rather than agreeing on a channel of
/// their own, so there is one formula and the frontend can reproduce it.
pub fn subscription_event_name(subscription_id: &str) -> String {
    format!("{SUBSCRIPTION_EVENT_PREFIX}{subscription_id}")
}

//#region Errors

/// Stock `FileSystemProviderErrorCode` — member names, verbatim from
/// `vs/platform/files/common/files.ts`.
///
/// The wire carries the *member* name (`FileNotFound`), not the enum's string
/// value (`EntryNotFound`), so the client rehydrates with
/// `FileSystemProviderErrorCode[code]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ChannelErrorCode {
    FileExists,
    FileNotFound,
    FileNotADirectory,
    FileIsADirectory,
    FileExceedsStorageQuota,
    FileTooLarge,
    FileWriteLocked,
    NoPermissions,
    Unavailable,
    Unknown,
}

/// An error crossing back to the frontend.
#[derive(Debug, Clone)]
pub struct ChannelError {
    pub code: ChannelErrorCode,
    pub message: String,
}

/// The exact JSON shape the frontend rehydrates from.
#[derive(Serialize)]
struct WireError<'a> {
    #[serde(rename = "$type")]
    type_name: &'static str,
    code: ChannelErrorCode,
    message: &'a str,
}

impl ChannelError {
    pub fn new(code: ChannelErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ChannelErrorCode::FileNotFound, message)
    }

    pub fn exists(message: impl Into<String>) -> Self {
        Self::new(ChannelErrorCode::FileExists, message)
    }

    pub fn is_a_directory(message: impl Into<String>) -> Self {
        Self::new(ChannelErrorCode::FileIsADirectory, message)
    }

    pub fn not_a_directory(message: impl Into<String>) -> Self {
        Self::new(ChannelErrorCode::FileNotADirectory, message)
    }

    pub fn too_large(message: impl Into<String>) -> Self {
        Self::new(ChannelErrorCode::FileTooLarge, message)
    }

    pub fn write_locked(message: impl Into<String>) -> Self {
        Self::new(ChannelErrorCode::FileWriteLocked, message)
    }

    /// Path validation failures land here — the workspace-root check in
    /// `tscode-fs` rejects a path the frontend was never entitled to name.
    pub fn no_permissions(message: impl Into<String>) -> Self {
        Self::new(ChannelErrorCode::NoPermissions, message)
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(ChannelErrorCode::Unavailable, message)
    }

    pub fn unknown(message: impl Into<String>) -> Self {
        Self::new(ChannelErrorCode::Unknown, message)
    }

    /// The JSON payload the frontend parses.
    pub fn to_wire(&self) -> String {
        let wire = WireError {
            type_name: "FileSystemProviderError",
            code: self.code,
            message: &self.message,
        };
        serde_json::to_string(&wire)
            .unwrap_or_else(|_| r#"{"$type":"FileSystemProviderError","code":"Unknown","message":"error serialization failed"}"#.to_owned())
    }
}

/// The wire form *is* the display form: it is the only string the frontend ever
/// sees, so `to_string()` cannot yield a payload the client fails to rehydrate.
impl fmt::Display for ChannelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_wire())
    }
}

impl std::error::Error for ChannelError {}

impl From<ChannelError> for String {
    fn from(error: ChannelError) -> Self {
        error.to_wire()
    }
}

/// Port of `DiskFileSystemProvider.toFileSystemProviderError` in
/// `vs/platform/files/node/diskFileSystemProvider.ts`, errno by errno.
impl From<std::io::Error> for ChannelError {
    fn from(error: std::io::Error) -> Self {
        use std::io::ErrorKind;
        let code = match error.kind() {
            ErrorKind::NotFound => ChannelErrorCode::FileNotFound,
            ErrorKind::IsADirectory => ChannelErrorCode::FileIsADirectory,
            ErrorKind::NotADirectory => ChannelErrorCode::FileNotADirectory,
            ErrorKind::AlreadyExists => ChannelErrorCode::FileExists,
            ErrorKind::PermissionDenied => ChannelErrorCode::NoPermissions,
            _ => ChannelErrorCode::Unknown,
        };
        Self::new(code, error.to_string())
    }
}

impl From<serde_json::Error> for ChannelError {
    fn from(error: serde_json::Error) -> Self {
        Self::unknown(error.to_string())
    }
}

//#endregion

//#region Events

/// Where a channel pushes the payloads of one `listen()` subscription.
///
/// Cheap to clone into a spawned task. Emitting after the subscription is
/// cancelled is a no-op, so a task that has not yet noticed cancellation cannot
/// deliver to a disposed frontend emitter.
#[derive(Clone)]
pub struct EventSink {
    app: AppHandle,
    event_name: Arc<str>,
    subscription_id: Arc<str>,
    active: Arc<AtomicBool>,
}

impl EventSink {
    fn new(app: AppHandle, subscription_id: &str, active: Arc<AtomicBool>) -> Self {
        Self {
            app,
            event_name: subscription_event_name(subscription_id).into(),
            subscription_id: subscription_id.into(),
            active,
        }
    }

    /// Push one payload. Returns `Ok(())` for a cancelled subscription — a
    /// producer racing an unlisten is expected, not an error.
    pub fn emit<T: Serialize + Clone>(&self, payload: T) -> Result<(), ChannelError> {
        if !self.is_active() {
            return Ok(());
        }
        self.app
            .emit(&self.event_name, payload)
            .map_err(|e| ChannelError::unknown(e.to_string()))
    }

    /// False once the subscription has been cancelled. Long-running producers
    /// poll this to stop early.
    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }

    pub fn subscription_id(&self) -> &str {
        &self.subscription_id
    }

    pub fn app_handle(&self) -> &AppHandle {
        &self.app
    }
}

/// The teardown half of a `listen()`, run when the frontend disposes the event
/// or the window goes away.
pub struct Subscription {
    cancel: Box<dyn FnOnce() + Send + 'static>,
}

impl Subscription {
    pub fn new(cancel: impl FnOnce() + Send + 'static) -> Self {
        Self { cancel: Box::new(cancel) }
    }

    /// For producers that already stop on `EventSink::is_active`.
    pub fn noop() -> Self {
        Self::new(|| {})
    }

    pub fn from_token(token: tokio_util::sync::CancellationToken) -> Self {
        Self::new(move || token.cancel())
    }

    pub fn from_task<T: Send + 'static>(handle: tokio::task::JoinHandle<T>) -> Self {
        Self::new(move || handle.abort())
    }

    fn cancel(self) {
        (self.cancel)();
    }
}

impl fmt::Debug for Subscription {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Subscription")
    }
}

//#endregion

//#region Registry

/// VS Code's `IServerChannel`: named request/response commands plus named event
/// streams, for one channel.
///
/// `listen` is synchronous and must not block — it starts a producer (a watcher,
/// a search task) and returns its teardown. The registry holds its lock across
/// the call so that a subscription id is reserved and registered as one step.
#[async_trait::async_trait]
pub trait ServerChannel: Send + Sync {
    async fn call(&self, command: &str, arg: Value) -> Result<Value, ChannelError>;

    fn listen(&self, event: &str, arg: Value, sink: EventSink)
        -> Result<Subscription, ChannelError>;
}

struct SubscriptionEntry {
    active: Arc<AtomicBool>,
    subscription: Subscription,
}

impl SubscriptionEntry {
    fn cancel(self) {
        self.active.store(false, Ordering::Release);
        self.subscription.cancel();
    }
}

/// Tauri managed state: the channels, and every live subscription.
///
/// Channels are fixed at startup, so lookups need no lock at all. Only the
/// subscription map has two actors — the commands and the producer tasks — and
/// producers touch it never: they hold their own `active` flag via [`EventSink`].
pub struct ChannelRegistry {
    channels: HashMap<&'static str, Arc<dyn ServerChannel>>,
    subscriptions: Mutex<HashMap<String, SubscriptionEntry>>,
}

impl ChannelRegistry {
    pub fn new() -> Self {
        Self { channels: HashMap::new(), subscriptions: Mutex::new(HashMap::new()) }
    }

    /// Takes `&mut self`, so registration can only happen before the registry is
    /// handed to `manage()` and the map is immutable thereafter.
    ///
    /// # Panics
    /// If `name` is not one of [`CHANNEL_NAMES`], or is registered twice.
    pub fn register(&mut self, name: &'static str, channel: Arc<dyn ServerChannel>) {
        assert!(CHANNEL_NAMES.contains(&name), "unknown channel name: {name}");
        assert!(
            self.channels.insert(name, channel).is_none(),
            "channel registered twice: {name}"
        );
    }

    fn channel(&self, name: &str) -> Result<Arc<dyn ServerChannel>, ChannelError> {
        self.channels
            .get(name)
            .cloned()
            .ok_or_else(|| ChannelError::unavailable(format!("no such channel: {name}")))
    }

    /// A poisoned lock means a panic while holding it. Entries are inserted and
    /// removed whole, so the map is still coherent and recovering beats taking
    /// every later call down with it.
    fn subscriptions(&self) -> MutexGuard<'_, HashMap<String, SubscriptionEntry>> {
        self.subscriptions.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn add_subscription(
        &self,
        app: &AppHandle,
        channel_name: &str,
        event: &str,
        arg: Value,
        subscription_id: &str,
    ) -> Result<(), ChannelError> {
        let channel = self.channel(channel_name)?;

        // Held across `listen()` so that reserving the id and storing the
        // teardown are one step; an unlisten arriving mid-registration waits and
        // then finds a complete entry to cancel.
        let mut subscriptions = self.subscriptions();
        if subscriptions.contains_key(subscription_id) {
            return Err(ChannelError::unknown(format!(
                "subscription already registered: {subscription_id}"
            )));
        }

        let active = Arc::new(AtomicBool::new(true));
        let sink = EventSink::new(app.clone(), subscription_id, Arc::clone(&active));
        let subscription = channel.listen(event, arg, sink)?;
        subscriptions
            .insert(subscription_id.to_owned(), SubscriptionEntry { active, subscription });
        Ok(())
    }

    /// Idempotent: cancelling an unknown or already-cancelled subscription is a
    /// no-op, so a double dispose on the frontend is harmless.
    fn remove_subscription(&self, subscription_id: &str) {
        let entry = self.subscriptions().remove(subscription_id);
        if let Some(entry) = entry {
            entry.cancel();
        }
    }

    /// Drop every subscription. Called when the window is destroyed — the
    /// frontend that owned them is gone, and their producers must stop.
    pub fn cancel_all(&self) {
        let entries = std::mem::take(&mut *self.subscriptions());
        for (_, entry) in entries {
            entry.cancel();
        }
    }
}

impl Default for ChannelRegistry {
    fn default() -> Self {
        Self::new()
    }
}

//#endregion

//#region Commands

#[tauri::command]
pub async fn channel_call(
    registry: State<'_, ChannelRegistry>,
    channel: String,
    command: String,
    arg: Value,
) -> Result<Value, String> {
    let channel = registry.channel(&channel)?;
    channel.call(&command, arg).await.map_err(String::from)
}

#[tauri::command]
pub fn channel_listen(
    app: AppHandle,
    registry: State<'_, ChannelRegistry>,
    channel: String,
    event: String,
    arg: Value,
    subscription_id: String,
) -> Result<(), String> {
    registry
        .add_subscription(&app, &channel, &event, arg, &subscription_id)
        .map_err(String::from)
}

#[tauri::command]
pub fn channel_unlisten(
    registry: State<'_, ChannelRegistry>,
    subscription_id: String,
) -> Result<(), String> {
    registry.remove_subscription(&subscription_id);
    Ok(())
}

//#endregion
