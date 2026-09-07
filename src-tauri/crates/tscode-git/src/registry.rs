//! The multi-repository registry: discovery plus cached, revalidated repository handles.
//!
//! ## What is cached, and why
//!
//! Opening a repository is the expensive part — `gix::open` walks up for `.git`, resolves
//! the common dir, and parses the whole config include-chain. Across a dozen repositories
//! polled on every status tick that dominates. So a [`gix::ThreadSafeRepository`] is kept
//! per root and turned into a cheap thread-local handle per operation.
//!
//! The *index* is deliberately not cached. It is the thing a `git add` rewrites, so a
//! cached index would answer a status poll with the state from before the stage. `gix`
//! re-reads it per status query, which is the correct trade.
//!
//! ## How a cached handle finds out it is stale
//!
//! The only state a `gix::Repository` holds across calls is the parsed config (refs and
//! objects are read from disk on demand, and `gix` refreshes packs on lookup miss). So the
//! cache entry records the size and mtime of the common dir's `config` at open time and
//! re-stats it on every lookup: a differing stamp is a **miss**, and the repository is
//! re-opened. Stale never becomes a wrong answer.
//!
//! ## The epoch
//!
//! A status poll and a user mutation are two actors over the same worktree. Git writes the
//! index atomically (`index.lock` then rename), so a poll reads either the pre- or the
//! post-mutation index, never a torn one — but it can still return a snapshot that was
//! already obsolete when it was produced. [`RepositoryRegistry::epoch`] is bumped by every
//! mutation; a status snapshot carries the epoch read *before* it started, so a caller
//! comparing it against the current epoch learns that a mutation interleaved and re-polls.
//! The map and the counter themselves are `tscode_fs::RootRegistry`, which `tscode-sl`
//! also builds its cache on.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use tscode_fs::{RootEntry, RootRegistry};

use crate::error::{GitError, Result};
use crate::model::RepositoryInfo;

/// Size and mtime of `.git/config`, the only cached-across-calls state a
/// `gix::Repository` holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ConfigStamp {
    len: u64,
    modified: Option<SystemTime>,
}

impl ConfigStamp {
    fn read(config_path: &Path) -> Option<Self> {
        let meta = std::fs::metadata(config_path).ok()?;
        Some(Self {
            len: meta.len(),
            modified: meta.modified().ok(),
        })
    }
}

/// A cached, revalidated repository handle.
pub struct CachedRepository {
    /// Absolute path of the working tree root.
    pub root: PathBuf,
    /// Absolute path of this repository's git directory.
    pub git_dir: PathBuf,
    config_path: PathBuf,
    config_stamp: Option<ConfigStamp>,
    repo: gix::ThreadSafeRepository,
}

impl CachedRepository {
    /// A thread-local handle for one operation. Cheap: it shares the parsed config and
    /// object database with every other handle made from the same cache entry.
    pub fn handle(&self) -> gix::Repository {
        self.repo.to_thread_local()
    }

    fn is_current(&self) -> bool {
        ConfigStamp::read(&self.config_path) == self.config_stamp
    }

    /// Open `path`'s enclosing repository. Reads only — `gix` never runs anything the
    /// repository's own config names.
    fn open(path: &Path) -> Result<Self> {
        let repo = gix::ThreadSafeRepository::discover(path)
            .map_err(|_| GitError::NotARepository(path.to_path_buf()))?;
        let local = repo.to_thread_local();

        let root = local
            .workdir()
            .ok_or_else(|| GitError::BareRepository(path.to_path_buf()))?
            .to_path_buf();
        let git_dir = local.git_dir().to_path_buf();
        let config_path = local.common_dir().join("config");

        Ok(Self {
            root,
            git_dir,
            config_stamp: ConfigStamp::read(&config_path),
            config_path,
            repo,
        })
    }
}

impl RootEntry for CachedRepository {
    type Info = RepositoryInfo;

    fn info(&self) -> RepositoryInfo {
        RepositoryInfo {
            root: self.root.clone(),
            git_dir: self.git_dir.clone(),
        }
    }
}

/// Every open repository, keyed by working tree root.
#[derive(Default)]
pub struct RepositoryRegistry {
    repos: RootRegistry<CachedRepository>,
}

impl RepositoryRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// The current mutation counter. See the module docs.
    pub fn epoch(&self) -> u64 {
        self.repos.epoch()
    }

    /// Record that something wrote to a repository. Every mutation calls this.
    pub fn bump_epoch(&self) {
        self.repos.bump_epoch();
    }

    /// The cached handle for the repository containing `path`, opening it if needed.
    ///
    /// Blocking: may hit the filesystem. Callers run it inside `spawn_blocking`.
    pub fn get_or_open(&self, path: &Path) -> Result<Arc<CachedRepository>> {
        // Fast path: an entry keyed by exactly this root whose config is unchanged.
        if let Some(entry) = self.repos.get(path) {
            if entry.is_current() {
                return Ok(entry);
            }
        }

        let opened = Arc::new(CachedRepository::open(path)?);
        // The re-check under the write lock keeps whatever another task opened while we
        // were discovering, since two handles to one repository must not both be live.
        Ok(self
            .repos
            .insert_or_keep(opened.root.clone(), opened, CachedRepository::is_current))
    }

    /// All open repositories, in root order.
    pub fn list(&self) -> Vec<Arc<CachedRepository>> {
        self.repos.list()
    }

    /// What every open repository is, in root order.
    pub fn infos(&self) -> Vec<RepositoryInfo> {
        self.repos.infos()
    }

    /// Forget a repository — the user closed the folder. Bumps the epoch so in-flight
    /// snapshots for it are recognisably stale.
    pub fn close(&self, root: &Path) {
        self.repos.close(root);
    }

    /// Find every repository at or below `dir`, up to `max_depth` directory levels, and
    /// open them into the cache. The walk itself is `tscode_fs::find_marked_dirs`, which
    /// `tscode-sl` runs with its own markers.
    ///
    /// Blocking: walks the filesystem. Callers run it inside `spawn_blocking`.
    pub fn discover(&self, dir: &Path, max_depth: usize) -> Result<Vec<Arc<CachedRepository>>> {
        let roots =
            tscode_fs::find_marked_dirs(dir, &[".git"], max_depth).map_err(|source| GitError::Io {
                path: dir.to_path_buf(),
                source,
            })?;

        let mut found: Vec<_> = roots
            .iter()
            .filter_map(|root| self.get_or_open(root).ok())
            .collect();
        found.sort_by(|a, b| a.root.cmp(&b.root));
        Ok(found)
    }
}
