//! The `sl` channel — multi-repository Sapling over `tscode_sl`.
//!
//! The sibling of [`scm`](crate::channels::scm), and the same shape: no stock
//! server to port, so the command names are `SlService`'s own, camelCased for the
//! wire, each taking a single object argument.
//!
//! Two things the crate leaves to this layer, as `scm` does:
//!
//! - **Epoch staleness.** A [`Smartlog`] carries the epoch read before its fetch
//!   began. When it no longer matches [`SlService::epoch`] the open set changed
//!   while the fetch ran, so the snapshot is reported `stale` and the frontend
//!   re-polls. Stale is a miss, never a wrong answer.
//! - **URIs.** The root crosses as a path *and* as the `file:` URI the view
//!   addresses it by.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tscode_sl::{SlCommit, SlError, SlService, Smartlog, SmartlogResult};

use crate::channel::{ChannelError, ChannelErrorCode, EventSink, ServerChannel, Subscription};
use crate::channels::{
    json, params, unknown_command, unknown_event, DiscoverParams, PathParams, UriComponents,
};

const CHANNEL: &str = "sl";

/// By value like `scm`'s `from_git_error`, so it can be handed straight to `map_err`.
#[allow(clippy::needless_pass_by_value)]
fn from_sl_error(error: SlError) -> ChannelError {
    let code = match &error {
        SlError::PathOutsideWorkspace(_) | SlError::InvalidRevision(_) => {
            ChannelErrorCode::NoPermissions
        }
        SlError::NotARepository(_) => ChannelErrorCode::FileNotFound,
        SlError::Spawn(_) => ChannelErrorCode::Unavailable,
        _ => ChannelErrorCode::Unknown,
    };
    ChannelError::new(code, error.to_string())
}

//#region Wire model

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WireSmartlog {
    root: PathBuf,
    root_uri: UriComponents,
    epoch: u64,
    /// The open set changed while this snapshot was being fetched; poll again.
    stale: bool,
    commits: Vec<SlCommit>,
}

impl WireSmartlog {
    fn new(smartlog: Smartlog, current_epoch: u64) -> Self {
        Self {
            root_uri: UriComponents::file(&smartlog.root),
            epoch: smartlog.epoch,
            stale: smartlog.epoch != current_epoch,
            commits: smartlog.commits,
            root: smartlog.root,
        }
    }
}

/// Mirrors the crate's `SmartlogResult`, tag included, so a repository that could
/// not be read reaches the view as itself rather than vanishing.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum WireSmartlogResult {
    Ok(WireSmartlog),
    #[serde(rename_all = "camelCase")]
    Failed { root: PathBuf, message: String },
}

impl WireSmartlogResult {
    fn new(result: SmartlogResult, current_epoch: u64) -> Self {
        match result {
            SmartlogResult::Ok(smartlog) => Self::Ok(WireSmartlog::new(smartlog, current_epoch)),
            SmartlogResult::Failed { root, message } => Self::Failed { root, message },
        }
    }
}

//#endregion

//#region Command parameters

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SmartlogParams {
    root: PathBuf,
    /// `sl log --limit`; the whole smartlog when absent.
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangedFilesParams {
    root: PathBuf,
    /// The commit to list. Checked against the hash grammar by the crate, not here.
    hash: String,
}

//#endregion

pub struct SlChannel {
    sl: Arc<SlService>,
}

impl SlChannel {
    pub fn new(sl: Arc<SlService>) -> Self {
        Self { sl }
    }

    /// `commits` crosses in `sl`'s own print order — descendants before ancestors — and
    /// the view draws that order rather than sorting it. Nothing here reorders it.
    async fn smartlog(&self, arg: Value) -> Result<Value, ChannelError> {
        let params: SmartlogParams = params(CHANNEL, arg)?;
        let result = self
            .sl
            .smartlog(params.root, params.limit)
            .await
            .map_err(from_sl_error)?;
        json(&WireSmartlogResult::new(result, self.sl.epoch()))
    }
}

#[async_trait::async_trait]
impl ServerChannel for SlChannel {
    async fn call(&self, command: &str, arg: Value) -> Result<Value, ChannelError> {
        match command {
            "open" => {
                let params: PathParams = params(CHANNEL, arg)?;
                json(&self.sl.open(params.path).await.map_err(from_sl_error)?)
            }
            "discover" => {
                let params: DiscoverParams = params(CHANNEL, arg)?;
                let repositories = self
                    .sl
                    .discover(params.path, params.max_depth)
                    .await
                    .map_err(from_sl_error)?;
                json(&repositories)
            }
            "repositories" => json(&self.sl.repositories()),
            "close" => {
                let params: PathParams = params(CHANNEL, arg)?;
                self.sl.close(&params.path);
                Ok(Value::Null)
            }
            "epoch" => json(&self.sl.epoch()),
            "smartlog" => self.smartlog(arg).await,
            "changedFiles" => {
                let params: ChangedFilesParams = params(CHANNEL, arg)?;
                let files = self
                    .sl
                    .changed_files(params.root, &params.hash)
                    .await
                    .map_err(from_sl_error)?;
                json(&files)
            }
            other => Err(unknown_command(CHANNEL, other)),
        }
    }

    /// The view polls; there is no push side. `SlService::epoch` is what tells a
    /// poll it needs another one.
    fn listen(
        &self,
        event: &str,
        _arg: Value,
        _sink: EventSink,
    ) -> Result<Subscription, ChannelError> {
        Err(unknown_event(CHANNEL, event))
    }
}
