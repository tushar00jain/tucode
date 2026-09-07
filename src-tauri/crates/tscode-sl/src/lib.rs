//! Multi-repository Sapling for tscode's source control view.
//!
//! # Shape
//!
//! [`SlService`] is the whole public surface; it owns a [`RepositoryRegistry`] of cached
//! repository identities and a `WorkspaceRoots` from `tscode_fs` that every incoming path
//! is validated against. There are no Tauri types here — the `sl` channel wraps this
//! crate, as the `scm` channel wraps `tscode_git`.
//!
//! # Everything comes from `sl`
//!
//! There is no in-process Sapling library to read a repository with, so unlike
//! `tscode-git` — which reads through `gix` and shells out only to mutate — every answer
//! here is a subprocess. It is invoked with an argv array and never a shell string, under
//! the environment `addons/isl-server/src/commands.ts` prescribes; see [`cmd`].
//!
//! # This is a port
//!
//! Sapling already has a UI over these commands, and its server half answers every
//! behavioural question this crate could ask: the invocation recipe, the log template,
//! the parse, the commit model. Each module names the upstream file it comes from. The
//! one deliberate divergence — a date formatter — is stated in [`smartlog`].
//!
//! # Threading
//!
//! Subprocesses use `tokio::process`; the discovery walk is blocking and runs on
//! `tokio::task::spawn_blocking`. Nothing blocks the runtime, and nothing runs at all
//! until a command asks for it.

mod changed_files;
mod cmd;
mod error;
mod model;
mod registry;
mod smartlog;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tscode_fs::{RootEntry, ValidatedPath, WorkspaceRoots};

pub use crate::changed_files::{ChangedFile, ChangedFileStatus, MAX_FETCHED_FILES_PER_COMMIT};
pub use crate::error::{Result, SlError};
pub use crate::model::{CommitPhase, SlCommit, SlRepositoryInfo, Smartlog, SuccessorInfo};
pub use crate::registry::{RepositoryRegistry, SlRepository};

/// One repository's contribution to a smartlog refresh. A repository that cannot be read
/// — deleted mid-refresh, an `sl` that failed — reports its failure instead of blanking
/// the view, as `tscode_git`'s `RepositoryStatusResult` does.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SmartlogResult {
    Ok(Smartlog),
    #[serde(rename_all = "camelCase")]
    Failed { root: PathBuf, message: String },
}

/// The crate's entry point.
pub struct SlService {
    registry: Arc<RepositoryRegistry>,
    roots: Arc<WorkspaceRoots>,
}

impl SlService {
    pub fn new(roots: Arc<WorkspaceRoots>) -> Self {
        Self {
            registry: Arc::new(RepositoryRegistry::new()),
            roots,
        }
    }

    /// The registry's epoch. A [`Smartlog`] whose `epoch` differs from this was fetched
    /// before the open set changed and should be re-fetched.
    pub fn epoch(&self) -> u64 {
        self.registry.epoch()
    }

    /// Open the repository containing `path` and cache its identity.
    pub async fn open(&self, path: PathBuf) -> Result<SlRepositoryInfo> {
        Ok(self.repository(path).await?.info())
    }

    /// Find and open every repository at or below `dir`, up to `max_depth` levels.
    pub async fn discover(&self, dir: PathBuf, max_depth: usize) -> Result<Vec<SlRepositoryInfo>> {
        let dir = self.validate(&dir).await?;
        Ok(self
            .registry
            .discover(&dir, max_depth)
            .await?
            .iter()
            .map(|repo| repo.info())
            .collect())
    }

    /// Every open repository.
    pub fn repositories(&self) -> Vec<SlRepositoryInfo> {
        self.registry.infos()
    }

    /// Forget a repository — the user closed the folder.
    pub fn close(&self, root: &Path) {
        self.registry.close(root);
    }

    /// The smartlog of one repository: one `sl log` for the whole view.
    ///
    /// The commits arrive in `sl`'s print order — descendants before ancestors, which the
    /// revset asks for — and stay in it all the way to the frontend, which draws the graph
    /// from that order rather than re-deriving one. See [`smartlog`] for why.
    pub async fn smartlog(&self, root: PathBuf, limit: Option<u32>) -> Result<SmartlogResult> {
        let repo = self.repository(root).await?;
        // Read before the fetch begins, so a set change that interleaves is visible to
        // the caller comparing it against `epoch()`.
        let epoch = self.registry.epoch();

        Ok(match smartlog::fetch(&repo.root, limit).await {
            Ok(commits) => SmartlogResult::Ok(Smartlog {
                root: repo.root.clone(),
                epoch,
                commits,
            }),
            Err(error) => SmartlogResult::Failed {
                root: repo.root.clone(),
                message: error.user_message(),
            },
        })
    }

    /// Every file one commit changed, with its status.
    ///
    /// A second `sl log` rather than a column of the smartlog's: the statuses are not in
    /// the main template, and upstream reads them per selected commit for the same reason
    /// — see [`changed_files`].
    pub async fn changed_files(&self, root: PathBuf, hash: &str) -> Result<Vec<ChangedFile>> {
        let repo = self.repository(root).await?;
        changed_files::fetch(&repo.root, hash).await
    }

    /// Validate `path` against the workspace roots and return its cached repository.
    async fn repository(&self, path: PathBuf) -> Result<Arc<SlRepository>> {
        let path = self.validate(&path).await?;
        self.registry.get_or_open(&path).await
    }

    /// Reject a path that is not inside a registered workspace root. Our Tauri commands
    /// are not gated by Tauri's capability system, so this is the only place the check
    /// happens — the same gate `tscode_git` puts in front of every entry point.
    async fn validate(&self, path: &Path) -> Result<PathBuf> {
        self.roots
            .validate(path)
            .await
            .map(ValidatedPath::into_path_buf)
            .map_err(|_| SlError::PathOutsideWorkspace(path.to_path_buf()))
    }
}
