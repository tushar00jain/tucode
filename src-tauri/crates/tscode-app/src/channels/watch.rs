//! File watching, the session-partitioned half of stock's
//! `AbstractDiskFileSystemProviderChannel`.
//!
//! Stock splits watching across three names on one channel: the client listens
//! to `fileChange` with its session id, then calls `watch` / `unwatch` with that
//! same id per request. This module owns all three; [`FileChannel`] delegates
//! them so the stock `DiskFileSystemProviderClient` sees one channel, and the
//! pinned `watch` channel name addresses the same object.
//!
//! [`FileChannel`]: crate::channels::file::FileChannel

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Deserializer};
use serde_json::Value;
use tscode_fs::{FileChange, FileWatcher, WatchOptions, WorkspaceRoots};

use crate::channel::{ChannelError, EventSink, ServerChannel, Subscription};
use crate::channels::{from_fs_error, unknown_command, unknown_event, Args, UriComponents};

const CHANNEL: &str = "watch";

/// A watch request, keyed exactly as stock keys `watchRequests`: session id plus
/// request id. The client generates both as uuids, so both are strings here even
/// though stock's server types `req` as a number.
type RequestKey = (String, String);

/// Stock `IFileChange` on the wire. The crate carries `resource` as a path
/// because it has no URI type; `reviveFileChanges` on the client expects
/// `UriComponents`, so the conversion lands here.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WireFileChange {
    #[serde(rename = "type")]
    change_type: u8,
    resource: UriComponents,
    #[serde(rename = "cId", skip_serializing_if = "Option::is_none")]
    correlation_id: Option<u32>,
}

impl From<FileChange> for WireFileChange {
    fn from(change: FileChange) -> Self {
        Self {
            change_type: change.change_type.into(),
            resource: UriComponents::file(&change.resource),
            correlation_id: change.correlation_id,
        }
    }
}

/// Stock `IWatchOptions`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireWatchOptions {
    #[serde(default)]
    recursive: bool,
    #[serde(default)]
    excludes: Vec<String>,
    #[serde(default, deserialize_with = "deserialize_patterns")]
    includes: Vec<String>,
    #[serde(default)]
    filter: Option<u32>,
    #[serde(default)]
    correlation_id: Option<u32>,
}

/// Stock types `includes` as `Array<string | IRelativePattern>`; the glob string
/// is the only part the watcher matches on.
fn deserialize_patterns<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Pattern {
        Glob(String),
        Relative { pattern: String },
    }

    Ok(Option::<Vec<Pattern>>::deserialize(deserializer)?
        .unwrap_or_default()
        .into_iter()
        .map(|pattern| match pattern {
            Pattern::Glob(glob) | Pattern::Relative { pattern: glob } => glob,
        })
        .collect())
}

impl From<WireWatchOptions> for WatchOptions {
    fn from(options: WireWatchOptions) -> Self {
        Self {
            recursive: options.recursive,
            excludes: options.excludes,
            includes: options.includes,
            filter: options.filter,
            correlation_id: options.correlation_id,
            ..Self::default()
        }
    }
}

/// The sinks and watchers of every live session.
///
/// Held behind an `Arc` because a subscription's teardown closure outlives the
/// `&self` that created it.
#[derive(Default)]
struct WatchState {
    sessions: Mutex<HashMap<String, EventSink>>,
    watchers: Mutex<HashMap<RequestKey, FileWatcher>>,
}

impl WatchState {
    fn sessions(&self) -> MutexGuard<'_, HashMap<String, EventSink>> {
        self.sessions.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn watchers(&self) -> MutexGuard<'_, HashMap<RequestKey, FileWatcher>> {
        self.watchers.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn sink(&self, session_id: &str) -> Option<EventSink> {
        self.sessions().get(session_id).cloned()
    }

    /// Ends a session: its sink stops being addressable and every watch it
    /// started is dropped, which is what unregisters the OS watches.
    fn end_session(&self, session_id: &str) {
        self.sessions().remove(session_id);
        self.watchers().retain(|(session, _), _| session != session_id);
    }

    /// Stores a watcher, then re-checks that its session is still open — an
    /// `unlisten` racing a `watch` would otherwise leave a watcher nothing can
    /// reach and nothing will drop.
    fn insert_watcher(&self, key: RequestKey, watcher: FileWatcher) {
        let mut watchers = self.watchers();
        watchers.insert(key.clone(), watcher);
        drop(watchers);

        if self.sink(&key.0).is_none() {
            self.watchers().remove(&key);
        }
    }
}

/// The `watch` channel, and the watching half of the `file` channel.
pub struct WatchChannel {
    roots: Arc<WorkspaceRoots>,
    state: Arc<WatchState>,
}

impl WatchChannel {
    pub fn new(roots: Arc<WorkspaceRoots>) -> Self {
        Self { roots, state: Arc::new(WatchState::default()) }
    }

    /// Port of stock's `watch(sessionId, req, resource, opts)`. A request for a
    /// session with no listener is dropped, exactly as stock's `if (watcher)`
    /// does.
    pub async fn watch(&self, args: &Args) -> Result<Value, ChannelError> {
        let session_id: String = args.at(0)?;
        let request_id = request_id(args, 1)?;
        let resource: UriComponents = args.at(2)?;
        let options: WireWatchOptions = args.opt(3)?;

        let Some(sink) = self.state.sink(&session_id) else {
            return Ok(Value::Null);
        };

        let path = self
            .roots
            .validate(resource.to_fs_path())
            .await
            .map_err(from_fs_error)?;

        let handler = Arc::new(move |changes: Vec<FileChange>| {
            let payload: Vec<WireFileChange> = changes.into_iter().map(Into::into).collect();
            if let Err(error) = sink.emit(payload) {
                log::warn!("watch: dropping a change batch: {error}");
            }
        });

        let watcher = FileWatcher::watch(&path, options.into(), handler)
            .await
            .map_err(from_fs_error)?;

        self.state.insert_watcher((session_id, request_id), watcher);
        Ok(Value::Null)
    }

    /// Port of stock's `unwatch(sessionId, req)`.
    pub fn unwatch(&self, args: &Args) -> Result<Value, ChannelError> {
        let session_id: String = args.at(0)?;
        let request_id = request_id(args, 1)?;
        self.state.watchers().remove(&(session_id, request_id));
        Ok(Value::Null)
    }

    /// Port of stock's `onFileChange(sessionId)`: one sink per session, so one
    /// client's events never reach another's.
    pub fn on_file_change(
        &self,
        arg: Value,
        sink: EventSink,
    ) -> Result<Subscription, ChannelError> {
        let session_id: String = Args::new(arg).at(0)?;

        self.state.sessions().insert(session_id.clone(), sink);

        let state = Arc::clone(&self.state);
        Ok(Subscription::new(move || state.end_session(&session_id)))
    }
}

/// The client generates request ids with `generateUuid`, so they arrive as
/// strings; stock's server signature says `number`. Accept either.
fn request_id(args: &Args, index: usize) -> Result<String, ChannelError> {
    Ok(match args.at::<Value>(index)? {
        Value::String(id) => id,
        other => other.to_string(),
    })
}

#[async_trait::async_trait]
impl ServerChannel for WatchChannel {
    async fn call(&self, command: &str, arg: Value) -> Result<Value, ChannelError> {
        let args = Args::new(arg);
        match command {
            "watch" => self.watch(&args).await,
            "unwatch" => self.unwatch(&args),
            other => Err(unknown_command(CHANNEL, other)),
        }
    }

    fn listen(&self, event: &str, arg: Value, sink: EventSink) -> Result<Subscription, ChannelError> {
        match event {
            "fileChange" => self.on_file_change(arg, sink),
            other => Err(unknown_event(CHANNEL, other)),
        }
    }
}
