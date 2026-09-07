//! The multi-repository registry: `.sl` discovery plus cached repository identities.
//!
//! ## What is cached, and why
//!
//! Opening a repository costs two `sl` processes — `sl root` and `sl root --dotdir`, the
//! pair `Repository.getRepoInfo` resolves. Across a dozen repositories refreshed on every
//! smartlog tick that dominates, and neither answer changes while the checkout exists, so
//! the pair is kept per root. Nothing else is cached: the commits come from `sl` on every
//! fetch.
//!
//! ## How a cached entry finds out it is stale
//!
//! The entry describes where the repository *is*, so the only thing that invalidates it
//! is the repository no longer being there. Every lookup re-stats the `.sl` directory it
//! recorded; a miss re-runs `sl root`. Stale never becomes a wrong answer.
//!
//! ## The epoch
//!
//! [`RepositoryRegistry::epoch`] is bumped whenever the open set changes — closing a
//! repository is the only such event in this slice, since nothing here mutates a
//! checkout. A smartlog snapshot carries the epoch read *before* it started, so a caller
//! comparing it against the current epoch learns that the set moved under it and
//! re-polls, exactly as `tscode-git`'s status does. The map and the counter themselves
//! are `tscode_fs::RootRegistry`, which `tscode-git`'s cache also builds on.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tscode_fs::{RootEntry, RootRegistry};

use crate::cmd;
use crate::error::{Result, SlError};
use crate::model::SlRepositoryInfo;

/// The marker directories a Sapling checkout carries, and what discovery walks for.
///
/// **There are two, because `sl` has two storage layouts.** A repository `sl init` made
/// keeps its metadata at `.sl`; one `sl` drives inside an existing git checkout keeps it
/// at `.git/sl`, which is the mode `sl root --dotdir` reports there. Walking for `.sl`
/// alone finds none of the second kind, and they are the same repository to the view.
const DOT_DIRS: [&str; 2] = [".sl", ".git/sl"];

/// Whether a candidate that failed to open ends the whole walk rather than being
/// skipped. **The two failures say opposite things.** Not being a checkout after all is
/// about that one directory, and skipping it is what discovery is for; `sl` failing to
/// start is about the binary, so every remaining candidate fails the same way and the
/// survivors would report an empty workspace when nothing could be asked at all.
///
/// Separated from the walk so the rule can be asserted without a subprocess, as
/// `cmd::exec_params` is.
fn ends_discovery(error: &SlError) -> bool {
    matches!(error, SlError::Spawn(_))
}

/// One open repository: where its checkout root and its `.sl` directory are.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlRepository {
    /// Absolute path of the checkout root.
    pub root: PathBuf,
    /// Absolute path of the `.sl` directory.
    pub dot_dir: PathBuf,
}

impl RootEntry for SlRepository {
    type Info = SlRepositoryInfo;

    fn info(&self) -> SlRepositoryInfo {
        SlRepositoryInfo {
            root: self.root.clone(),
            dot_dir: self.dot_dir.clone(),
        }
    }
}

impl SlRepository {
    /// Ask `sl` where the repository containing `path` is. Port of `findRoot` and
    /// `findDotDir`, which `getRepoInfo` runs together.
    async fn open(path: &Path) -> Result<Self> {
        let (root, dot_dir) = tokio::join!(
            cmd::run(path, &["root"]),
            cmd::run(path, &["root", "--dotdir"])
        );

        // `sl root` exits non-zero outside a repository, which is the whole of the
        // question being asked; a missing `sl` binary is a spawn failure and stays one.
        let not_a_repository = |error| match error {
            SlError::Command(_) => SlError::NotARepository(path.to_path_buf()),
            other => other,
        };

        Ok(Self {
            root: PathBuf::from(root.map_err(not_a_repository)?),
            dot_dir: PathBuf::from(dot_dir.map_err(not_a_repository)?),
        })
    }

    /// False once the checkout it describes has gone away.
    async fn is_current(&self) -> bool {
        tokio::fs::metadata(&self.dot_dir).await.is_ok()
    }
}

/// Every open repository, keyed by checkout root.
#[derive(Default)]
pub struct RepositoryRegistry {
    repos: RootRegistry<SlRepository>,
}

impl RepositoryRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// The current epoch. See the module docs.
    pub fn epoch(&self) -> u64 {
        self.repos.epoch()
    }

    /// The cached entry for the repository containing `path`, opening it if needed.
    pub async fn get_or_open(&self, path: &Path) -> Result<Arc<SlRepository>> {
        // Fast path: an entry keyed by exactly this root whose `.sl` is still there.
        if let Some(entry) = self.repos.get(path) {
            if entry.is_current().await {
                return Ok(entry);
            }
        }

        let opened = Arc::new(SlRepository::open(path).await?);
        // Nothing is kept: an entry is two paths with no state behind it, so the answer
        // that just came back from `sl` is the safe one — and the entry it replaces may
        // be the stale one the fast path missed on.
        Ok(self
            .repos
            .insert_or_keep(opened.root.clone(), opened, |_| false))
    }

    /// What every open repository is, in root order.
    pub fn infos(&self) -> Vec<SlRepositoryInfo> {
        self.repos.infos()
    }

    /// Forget a repository — the user closed the folder. Bumps the epoch so in-flight
    /// snapshots for it are recognisably stale.
    pub fn close(&self, root: &Path) {
        self.repos.close(root);
    }

    /// Find every Sapling repository at or below `dir`, up to `max_depth` directory
    /// levels, and open them into the cache. Fails only when `sl` itself could not be
    /// run — see [`ends_discovery`].
    pub async fn discover(&self, dir: &Path, max_depth: usize) -> Result<Vec<Arc<SlRepository>>> {
        let walked = dir.to_path_buf();
        // The walk is blocking; the opens that follow are subprocesses and are not.
        let candidates = tokio::task::spawn_blocking(move || {
            tscode_fs::find_marked_dirs(&walked, &DOT_DIRS, max_depth).map_err(|source| SlError::Io {
                path: walked.clone(),
                source,
            })
        })
        .await??;

        let mut found = Vec::with_capacity(candidates.len());
        for candidate in &candidates {
            match self.get_or_open(candidate).await {
                Ok(repo) => found.push(repo),
                Err(error) if ends_discovery(&error) => return Err(error),
                Err(_) => {}
            }
        }
        found.sort_by(|a, b| a.root.cmp(&b.root));
        Ok(found)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_cached_entry_whose_dot_dir_is_gone_is_not_current() {
        let temp = tempfile::tempdir().expect("temp dir");
        let repo = SlRepository {
            root: temp.path().to_path_buf(),
            dot_dir: temp.path().join(".sl"),
        };

        assert!(!repo.is_current().await);
        std::fs::create_dir(&repo.dot_dir).expect("fixture");
        assert!(repo.is_current().await);
    }

    /// The distinction discovery turns on: a directory that is not a checkout is skipped,
    /// an `sl` that never started is reported. Blocked by policy and missing from `PATH`
    /// are the same failure here — both are `Spawn`, and neither is "no repositories".
    #[test]
    fn only_an_sl_that_could_not_start_ends_the_walk() {
        assert!(ends_discovery(&SlError::Spawn(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "blocked by policy"
        ))));
        assert!(ends_discovery(&SlError::Spawn(std::io::Error::from(
            std::io::ErrorKind::NotFound
        ))));

        assert!(!ends_discovery(&SlError::NotARepository(PathBuf::from(
            "/somewhere"
        ))));
        assert!(!ends_discovery(&SlError::Command(
            tscode_proc::CommandFailure {
                program: "sl".to_owned(),
                argv: vec!["root".to_owned()],
                code: 255,
                stderr: "not inside a repository".to_owned(),
                stdout: String::new(),
            }
        )));
    }
}
