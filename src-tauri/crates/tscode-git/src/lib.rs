//! Multi-repository git for tscode's source control view.
//!
//! # Shape
//!
//! [`GitService`] is the whole public surface; it owns a [`RepositoryRegistry`] of cached
//! `gix` handles and a `WorkspaceRoots` from `tscode_fs` that every incoming path is
//! validated against. There are no Tauri types here — the `scm` channel wraps this crate.
//!
//! # Reads use `gix`, mutations use `git`
//!
//! Every read — status, diff, file content, HEAD, ahead/behind — goes through `gix`, in
//! process. A repository's `.git/config` can name executables via `core.pager`,
//! `core.fsmonitor`, `core.sshCommand` and hooks; `gix` honours none of them, so opening a
//! repository the user cloned but never audited cannot run anything. With many repositories
//! open at once that is the point of the design, not an incidental benefit.
//!
//! Mutations shell out to `git`, as VS Code's own git extension does, always with an argv
//! array and never a shell string, and always with `--` before any path list.
//!
//! # Threading
//!
//! `gix` is blocking and so is the filesystem walk behind discovery, so both run on
//! `tokio::task::spawn_blocking`. Subprocesses use `tokio::process`, which is properly
//! async. Nothing blocks the runtime.

mod cmd;
mod diff;
mod error;
mod history;
mod model;
mod mutate;
mod path;
mod registry;
mod status;

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tscode_fs::{RootEntry, WorkspaceRoots};

pub use crate::diff::DiffSource;
pub use crate::error::{GitError, Result};
pub use crate::history::{Commit, CommitStats, LogOptions, RefInfo, RefKind};
pub use crate::model::{
    Change, Head, RepositoryInfo, RepositoryStatus, ResourceGroupType, Status, StatusOptions,
    UntrackedChanges,
};
pub use crate::mutate::CommitOptions;
pub use crate::path::absolute_path;
pub use crate::registry::{CachedRepository, RepositoryRegistry};

/// One repository's contribution to a multi-repo status poll. A repository that cannot be
/// read — deleted mid-poll, corrupt index — reports its failure instead of blanking the
/// whole view.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RepositoryStatusResult {
    Ok(RepositoryStatus),
    #[serde(rename_all = "camelCase")]
    Failed { root: PathBuf, message: String },
}

/// Run one `gix` read against a cached repository on the blocking pool. Every read in this
/// file goes through it, so `spawn_blocking` and its join-error mapping are stated once.
async fn read<T, F>(repo: Arc<CachedRepository>, operation: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&gix::Repository) -> Result<T> + Send + 'static,
{
    tokio::task::spawn_blocking(move || operation(&repo.handle())).await?
}

/// The crate's entry point.
pub struct GitService {
    registry: Arc<RepositoryRegistry>,
    roots: Arc<WorkspaceRoots>,
}

impl GitService {
    pub fn new(roots: Arc<WorkspaceRoots>) -> Self {
        Self {
            registry: Arc::new(RepositoryRegistry::new()),
            roots,
        }
    }

    /// The registry's mutation counter. A [`RepositoryStatus`] whose `epoch` differs from
    /// this was computed before a mutation landed and should be re-polled.
    pub fn epoch(&self) -> u64 {
        self.registry.epoch()
    }

    /// Open the repository containing `path` and cache its handle.
    pub async fn open(&self, path: PathBuf) -> Result<RepositoryInfo> {
        Ok(self.repository(path).await?.info())
    }

    /// Find and open every repository at or below `dir`, up to `max_depth` levels.
    pub async fn discover(&self, dir: PathBuf, max_depth: usize) -> Result<Vec<RepositoryInfo>> {
        let dir = path::validate(&self.roots, &dir).await?;
        let registry = self.registry.clone();
        tokio::task::spawn_blocking(move || {
            Ok(registry
                .discover(&dir, max_depth)?
                .iter()
                .map(|repo| repo.info())
                .collect())
        })
        .await?
    }

    /// Every open repository.
    pub fn repositories(&self) -> Vec<RepositoryInfo> {
        self.registry.infos()
    }

    /// Forget a repository — the user closed the folder.
    pub fn close(&self, root: &Path) {
        self.registry.close(root);
    }

    /// Status of one repository.
    pub async fn status(&self, root: PathBuf, options: StatusOptions) -> Result<RepositoryStatus> {
        let repo = self.repository(root).await?;
        let epoch = self.registry.epoch();
        read(repo, move |handle| status::compute(handle, &options, epoch)).await
    }

    /// Status of every open repository, computed concurrently.
    ///
    /// This is the hot path: the SCM view polls all repositories together, so each one
    /// gets its own blocking task and each does a single walk producing every change —
    /// never a walk per file.
    pub async fn status_all(&self, options: StatusOptions) -> Vec<RepositoryStatusResult> {
        let epoch = self.registry.epoch();
        let mut tasks = tokio::task::JoinSet::new();

        for repo in self.registry.list() {
            let options = options.clone();
            tasks.spawn_blocking(move || {
                let root = repo.root.clone();
                match status::compute(&repo.handle(), &options, epoch) {
                    Ok(status) => RepositoryStatusResult::Ok(status),
                    Err(error) => RepositoryStatusResult::Failed {
                        root,
                        message: error.to_string(),
                    },
                }
            });
        }

        let mut out = Vec::with_capacity(tasks.len());
        while let Some(joined) = tasks.join_next().await {
            match joined {
                Ok(result) => out.push(result),
                Err(_) => continue,
            }
        }
        out.sort_by_key(|result| match result {
            RepositoryStatusResult::Ok(status) => status.root.clone(),
            RepositoryStatusResult::Failed { root, .. } => root.clone(),
        });
        out
    }

    /// A unified diff of one path.
    pub async fn diff(
        &self,
        root: PathBuf,
        path: PathBuf,
        source: DiffSource,
        context: u32,
    ) -> Result<String> {
        let repo = self.repository(root).await?;
        let rela_path = self.relative(&repo, vec![path]).await?;
        read(repo, move |handle| {
            diff::unified(handle, &rela_path[0], source, context)
        })
        .await
    }

    /// The bytes of a path at a revision — the diff editor's left-hand side.
    pub async fn show(&self, root: PathBuf, rev: String, path: PathBuf) -> Result<Vec<u8>> {
        let repo = self.repository(root).await?;
        let rela_path = self.relative(&repo, vec![path]).await?;
        read(repo, move |handle| diff::show(handle, &rev, &rela_path[0])).await
    }

    //#region History
    //
    // The Source Control Graph view's reads. Each is one call for a whole page — never one
    // per commit; `stats` in particular is the expensive one, and batching it is what keeps
    // it off the path that paints.

    /// The commits a `git log` with these options would print.
    pub async fn log(&self, root: PathBuf, options: LogOptions) -> Result<Vec<Commit>> {
        let repo = self.repository(root).await?;
        read(repo, move |handle| history::log(handle, &options)).await
    }

    /// Local branches, remote branches and tags, optionally filtered by ref pattern.
    pub async fn refs(&self, root: PathBuf, pattern: Option<Vec<String>>) -> Result<Vec<RefInfo>> {
        let repo = self.repository(root).await?;
        read(repo, move |handle| history::refs(handle, pattern.as_deref())).await
    }

    /// The common ancestor of two or more revisions, or `None` when there is none.
    pub async fn merge_base(&self, root: PathBuf, revs: Vec<String>) -> Result<Option<String>> {
        let repo = self.repository(root).await?;
        read(repo, move |handle| Ok(history::merge_base(handle, &revs))).await
    }

    /// The name-status changes between two tree-ish revisions.
    pub async fn diff_between(
        &self,
        root: PathBuf,
        rev1: String,
        rev2: String,
    ) -> Result<Vec<Change>> {
        let repo = self.repository(root).await?;
        read(repo, move |handle| history::diff_between(handle, &rev1, &rev2)).await
    }

    /// One commit by revision.
    pub async fn get_commit(&self, root: PathBuf, rev: String) -> Result<Commit> {
        let repo = self.repository(root).await?;
        read(repo, move |handle| history::get_commit(handle, &rev)).await
    }

    /// The empty-tree hash, which is a root commit's parent.
    pub async fn empty_tree(&self, root: PathBuf) -> Result<String> {
        let repo = self.repository(root).await?;
        read(repo, move |handle| Ok(history::empty_tree(handle))).await
    }

    /// Files changed, insertions and deletions for a set of commits.
    pub async fn commit_stats(
        &self,
        root: PathBuf,
        hashes: Vec<String>,
    ) -> Result<HashMap<String, CommitStats>> {
        let repo = self.repository(root).await?;
        read(repo, move |handle| history::stats(handle, &hashes)).await
    }

    //#endregion

    /// Stage paths, or everything when `paths` is empty.
    pub async fn stage(&self, root: PathBuf, paths: Vec<PathBuf>) -> Result<()> {
        let repo = self.repository(root).await?;
        let paths = self.relative(&repo, paths).await?;
        self.mutating(mutate::stage(&repo.root, &paths)).await
    }

    /// Unstage paths, or everything when `paths` is empty.
    pub async fn unstage(&self, root: PathBuf, paths: Vec<PathBuf>) -> Result<()> {
        let repo = self.repository(root).await?;
        let paths = self.relative(&repo, paths).await?;

        // Upstream probes `git branch` for "does HEAD point at anything yet"; reading HEAD
        // answers the same question, and reads go through `gix`.
        let probe = repo.clone();
        let unborn = tokio::task::spawn_blocking(move || {
            let handle = probe.handle();
            !handle.head().is_ok_and(|head| head.id().is_some())
        })
        .await?;

        self.mutating(mutate::unstage(&repo.root, &paths, unborn))
            .await
    }

    /// Discard worktree changes: tracked paths are restored from the index, untracked ones
    /// are deleted.
    pub async fn discard(&self, root: PathBuf, paths: Vec<PathBuf>) -> Result<()> {
        let repo = self.repository(root).await?;
        let paths = self.relative(&repo, paths).await?;

        let (tracked, untracked) = read(repo.clone(), move |handle| {
            mutate::partition_tracked(handle, &paths)
        })
        .await?;

        self.mutating(mutate::discard(&repo.root, &tracked, &untracked))
            .await
    }

    /// Commit what is staged.
    pub async fn commit(
        &self,
        root: PathBuf,
        message: String,
        options: CommitOptions,
    ) -> Result<()> {
        let repo = self.repository(root).await?;
        self.mutating(async move { mutate::commit(&repo.root, &message, &options).await })
            .await
    }

    /// Run a mutation and bump the epoch, always as one step — a mutation whose epoch bump
    /// was forgotten would let a stale status snapshot look current.
    ///
    /// The bump happens even on failure, because a failed `git` invocation may still have
    /// applied part of its work.
    async fn mutating(&self, operation: impl Future<Output = Result<()>>) -> Result<()> {
        let result = operation.await;
        self.registry.bump_epoch();
        result
    }

    /// Validate `path` against the workspace roots and return its cached repository.
    async fn repository(&self, path: PathBuf) -> Result<Arc<CachedRepository>> {
        let path = path::validate(&self.roots, &path).await?;
        let registry = self.registry.clone();
        tokio::task::spawn_blocking(move || registry.get_or_open(&path)).await?
    }

    /// Validate paths against the workspace roots and express them relative to the
    /// repository root, the form every git argv and every `gix` lookup wants.
    async fn relative(
        &self,
        repo: &Arc<CachedRepository>,
        paths: Vec<PathBuf>,
    ) -> Result<Vec<String>> {
        let mut relative = Vec::with_capacity(paths.len());
        for path in &paths {
            let validated = path::validate(&self.roots, path).await?;
            relative.push(path::to_repo_relative(&repo.root, &validated)?);
        }
        Ok(relative)
    }
}
