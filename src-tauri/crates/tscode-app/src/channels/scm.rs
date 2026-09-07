//! The `scm` channel — multi-repository git over `tscode_git`.
//!
//! Unlike `file`, this channel has no stock server to port: VS Code's git is an
//! extension talking to its own process. The command names are therefore
//! `GitService`'s own, camelCased for the wire, and each takes a single object
//! argument rather than stock's positional array.
//!
//! Two things the crate deliberately leaves to this layer:
//!
//! - **Epoch staleness.** A [`RepositoryStatus`] carries the epoch read before
//!   its snapshot began. When it no longer matches [`GitService::epoch`] a
//!   mutation interleaved, so the snapshot is reported `stale` and the frontend
//!   re-polls. Stale is a miss, never a wrong answer — so it is surfaced, not
//!   patched over by a silent retry that could loop under a busy repository.
//! - **URIs.** `Change` paths are repository-relative with forward slashes;
//!   every one is paired here with the absolute `file:` URI the SCM view turns
//!   into a resource state, built with `absolute_path`.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tscode_git::{
    absolute_path, Change, CommitOptions, DiffSource, GitError, GitService, Head, LogOptions,
    RepositoryStatus, RepositoryStatusResult, StatusOptions,
};

use crate::channel::{ChannelError, ChannelErrorCode, EventSink, ServerChannel, Subscription};
use crate::channels::{
    json, params, unknown_command, unknown_event, DiscoverParams, PathParams, UriComponents,
};

const CHANNEL: &str = "scm";

fn from_git_error(error: GitError) -> ChannelError {
    let code = match &error {
        GitError::PathOutsideWorkspace(_) | GitError::PathOutsideRepository { .. } => {
            ChannelErrorCode::NoPermissions
        }
        GitError::NotARepository(_) | GitError::NoSuchEntry { .. } => ChannelErrorCode::FileNotFound,
        GitError::Spawn(_) => ChannelErrorCode::Unavailable,
        _ => ChannelErrorCode::Unknown,
    };
    ChannelError::new(code, error.to_string())
}

//#region Wire model

/// A [`Change`] plus the URIs the SCM view needs. `resource` is what a resource
/// state points at; `originalResource` is the rename or copy source.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WireChange {
    #[serde(flatten)]
    change: Change,
    /// The status letter the tree row renders, so the frontend does not restate
    /// the `Status` → letter table the crate already owns.
    letter: &'static str,
    conflict: bool,
    resource: UriComponents,
    #[serde(skip_serializing_if = "Option::is_none")]
    original_resource: Option<UriComponents>,
}

impl WireChange {
    fn new(root: &std::path::Path, change: Change) -> Self {
        let resource = UriComponents::file(&absolute_path(root, &change.path));
        let original_resource = change
            .original_path
            .as_deref()
            .map(|path| UriComponents::file(&absolute_path(root, path)));

        Self {
            letter: change.status.letter(),
            conflict: change.status.is_conflict(),
            change,
            resource,
            original_resource,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WireStatus {
    root: PathBuf,
    root_uri: UriComponents,
    head: Head,
    epoch: u64,
    /// A mutation landed while this snapshot was being computed; poll again.
    stale: bool,
    merge: Vec<WireChange>,
    index: Vec<WireChange>,
    working_tree: Vec<WireChange>,
    untracked: Vec<WireChange>,
}

impl WireStatus {
    fn new(status: RepositoryStatus, current_epoch: u64) -> Self {
        let root = status.root;
        let group = |changes: Vec<Change>| {
            changes.into_iter().map(|change| WireChange::new(&root, change)).collect()
        };

        Self {
            root_uri: UriComponents::file(&root),
            head: status.head,
            epoch: status.epoch,
            stale: status.epoch != current_epoch,
            merge: group(status.merge),
            index: group(status.index),
            working_tree: group(status.working_tree),
            untracked: group(status.untracked),
            root,
        }
    }
}

/// Mirrors the crate's `RepositoryStatusResult`, tag included, so a repository
/// that could not be read reaches the view as itself rather than vanishing.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum WireStatusResult {
    Ok(WireStatus),
    #[serde(rename_all = "camelCase")]
    Failed { root: PathBuf, message: String },
}

impl WireStatusResult {
    fn new(result: RepositoryStatusResult, current_epoch: u64) -> Self {
        match result {
            RepositoryStatusResult::Ok(status) => Self::Ok(WireStatus::new(status, current_epoch)),
            RepositoryStatusResult::Failed { root, message } => Self::Failed { root, message },
        }
    }
}

//#endregion

//#region Command parameters

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusParams {
    root: PathBuf,
    #[serde(default)]
    options: StatusOptions,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusAllParams {
    #[serde(default)]
    options: StatusOptions,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiffParams {
    root: PathBuf,
    path: PathBuf,
    #[serde(default)]
    source: DiffSource,
    #[serde(default = "default_context")]
    context: u32,
}

fn default_context() -> u32 {
    3
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShowParams {
    root: PathBuf,
    rev: String,
    path: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathsParams {
    root: PathBuf,
    #[serde(default)]
    paths: Vec<PathBuf>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitParams {
    root: PathBuf,
    message: String,
    #[serde(default)]
    options: CommitOptions,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogParams {
    root: PathBuf,
    #[serde(default)]
    options: LogOptions,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefsParams {
    root: PathBuf,
    /// `for-each-ref` patterns; every ref when absent.
    #[serde(default)]
    pattern: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MergeBaseParams {
    root: PathBuf,
    revs: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiffBetweenParams {
    root: PathBuf,
    rev1: String,
    rev2: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RevParams {
    root: PathBuf,
    rev: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RootParams {
    root: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitStatsParams {
    root: PathBuf,
    hashes: Vec<String>,
}

//#endregion

pub struct ScmChannel {
    git: Arc<GitService>,
}

impl ScmChannel {
    pub fn new(git: Arc<GitService>) -> Self {
        Self { git }
    }

    async fn status(&self, arg: Value) -> Result<Value, ChannelError> {
        let params: StatusParams = params(CHANNEL, arg)?;
        let status = self
            .git
            .status(params.root, params.options)
            .await
            .map_err(from_git_error)?;
        json(&WireStatus::new(status, self.git.epoch()))
    }

    async fn status_all(&self, arg: Value) -> Result<Value, ChannelError> {
        let params: StatusAllParams = params(CHANNEL, arg)?;
        let results = self.git.status_all(params.options).await;
        let epoch = self.git.epoch();
        let results: Vec<WireStatusResult> = results
            .into_iter()
            .map(|result| WireStatusResult::new(result, epoch))
            .collect();
        json(&results)
    }

    /// `GitService::discard` classifies each path by index membership, so a
    /// directory would be taken for an untracked file and deleted wholesale.
    /// Only files reach it.
    async fn discard(&self, arg: Value) -> Result<Value, ChannelError> {
        let params: PathsParams = params(CHANNEL, arg)?;

        for path in &params.paths {
            if tokio::fs::metadata(path).await.is_ok_and(|meta| meta.is_dir()) {
                return Err(ChannelError::is_a_directory(format!(
                    "discard takes files, not directories: {}",
                    path.display()
                )));
            }
        }

        self.git
            .discard(params.root, params.paths)
            .await
            .map_err(from_git_error)?;
        Ok(Value::Null)
    }
}

#[async_trait::async_trait]
impl ServerChannel for ScmChannel {
    async fn call(&self, command: &str, arg: Value) -> Result<Value, ChannelError> {
        match command {
            "open" => {
                let params: PathParams = params(CHANNEL, arg)?;
                json(&self.git.open(params.path).await.map_err(from_git_error)?)
            }
            "discover" => {
                let params: DiscoverParams = params(CHANNEL, arg)?;
                let repositories = self
                    .git
                    .discover(params.path, params.max_depth)
                    .await
                    .map_err(from_git_error)?;
                json(&repositories)
            }
            "repositories" => json(&self.git.repositories()),
            "close" => {
                let params: PathParams = params(CHANNEL, arg)?;
                self.git.close(&params.path);
                Ok(Value::Null)
            }
            "epoch" => json(&self.git.epoch()),
            "status" => self.status(arg).await,
            "statusAll" => self.status_all(arg).await,
            "diff" => {
                let params: DiffParams = params(CHANNEL, arg)?;
                let diff = self
                    .git
                    .diff(params.root, params.path, params.source, params.context)
                    .await
                    .map_err(from_git_error)?;
                Ok(Value::String(diff))
            }
            "show" => {
                let params: ShowParams = params(CHANNEL, arg)?;
                let content = self
                    .git
                    .show(params.root, params.rev, params.path)
                    .await
                    .map_err(from_git_error)?;
                json(&crate::channels::VsBuffer::new(content))
            }
            "stage" => {
                let params: PathsParams = params(CHANNEL, arg)?;
                self.git
                    .stage(params.root, params.paths)
                    .await
                    .map_err(from_git_error)?;
                Ok(Value::Null)
            }
            "unstage" => {
                let params: PathsParams = params(CHANNEL, arg)?;
                self.git
                    .unstage(params.root, params.paths)
                    .await
                    .map_err(from_git_error)?;
                Ok(Value::Null)
            }
            "discard" => self.discard(arg).await,
            "log" => {
                let params: LogParams = params(CHANNEL, arg)?;
                let commits = self
                    .git
                    .log(params.root, params.options)
                    .await
                    .map_err(from_git_error)?;
                json(&commits)
            }
            "refs" => {
                let params: RefsParams = params(CHANNEL, arg)?;
                let refs = self
                    .git
                    .refs(params.root, params.pattern)
                    .await
                    .map_err(from_git_error)?;
                json(&refs)
            }
            "mergeBase" => {
                let params: MergeBaseParams = params(CHANNEL, arg)?;
                let base = self
                    .git
                    .merge_base(params.root, params.revs)
                    .await
                    .map_err(from_git_error)?;
                json(&base)
            }
            "diffBetween" => {
                let params: DiffBetweenParams = params(CHANNEL, arg)?;
                let changes = self
                    .git
                    .diff_between(params.root.clone(), params.rev1, params.rev2)
                    .await
                    .map_err(from_git_error)?;
                let changes: Vec<WireChange> = changes
                    .into_iter()
                    .map(|change| WireChange::new(&params.root, change))
                    .collect();
                json(&changes)
            }
            "getCommit" => {
                let params: RevParams = params(CHANNEL, arg)?;
                let commit = self
                    .git
                    .get_commit(params.root, params.rev)
                    .await
                    .map_err(from_git_error)?;
                json(&commit)
            }
            "emptyTree" => {
                let params: RootParams = params(CHANNEL, arg)?;
                json(&self.git.empty_tree(params.root).await.map_err(from_git_error)?)
            }
            "commitStats" => {
                let params: CommitStatsParams = params(CHANNEL, arg)?;
                let stats = self
                    .git
                    .commit_stats(params.root, params.hashes)
                    .await
                    .map_err(from_git_error)?;
                json(&stats)
            }
            "commit" => {
                let params: CommitParams = params(CHANNEL, arg)?;
                self.git
                    .commit(params.root, params.message, params.options)
                    .await
                    .map_err(from_git_error)?;
                Ok(Value::Null)
            }
            other => Err(unknown_command(CHANNEL, other)),
        }
    }

    /// The SCM view polls; there is no push side. `GitService::epoch` is what
    /// tells a poll it needs another one.
    fn listen(&self, event: &str, _arg: Value, _sink: EventSink) -> Result<Subscription, ChannelError> {
        Err(unknown_event(CHANNEL, event))
    }
}
