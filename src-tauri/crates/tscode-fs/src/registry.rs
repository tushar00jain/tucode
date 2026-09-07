//! A registry of open, path-keyed things, plus the epoch that dates snapshots of them.
//!
//! `tscode-git`'s repository cache and `tscode-sl`'s are the same map — keyed by root,
//! listed in root order, closed when the user closes the folder — and the same counter.
//! What differs is how an entry is opened and how it decides it has gone stale, so each
//! crate keeps its own `get_or_open` on top of this.
//!
//! # The epoch
//!
//! A poll and a write are two actors over one worktree. A snapshot carries the epoch read
//! *before* it started, so a caller comparing it against [`RootRegistry::epoch`] learns
//! that something interleaved and polls again: stale becomes a miss, never a wrong
//! answer.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

/// An entry that can describe itself to the frontend.
pub trait RootEntry {
    type Info;

    fn info(&self) -> Self::Info;
}

pub struct RootRegistry<T> {
    entries: RwLock<HashMap<PathBuf, Arc<T>>>,
    epoch: AtomicU64,
}

impl<T> RootRegistry<T> {
    pub fn new() -> Self {
        Self::default()
    }

    /// The current counter. See the module docs.
    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::Acquire)
    }

    /// Record that something changed under a caller's feet.
    pub fn bump_epoch(&self) {
        self.epoch.fetch_add(1, Ordering::AcqRel);
    }

    /// The entry keyed by exactly `root`, if there is one.
    pub fn get(&self, root: &Path) -> Option<Arc<T>> {
        self.read().get(root).cloned()
    }

    /// Store `entry` under `root` unless `keep` accepts one that is already there — the
    /// second half of a double-checked open, where another task may have opened the same
    /// root while this one was working and two live handles to it would be one too many.
    pub fn insert_or_keep(
        &self,
        root: PathBuf,
        entry: Arc<T>,
        keep: impl Fn(&T) -> bool,
    ) -> Arc<T> {
        let mut entries = self.write();
        if let Some(existing) = entries.get(&root) {
            if keep(existing) {
                return existing.clone();
            }
        }
        entries.insert(root, entry.clone());
        entry
    }

    /// Everything open, in root order.
    pub fn list(&self) -> Vec<Arc<T>> {
        let entries = self.read();
        let mut roots: Vec<&PathBuf> = entries.keys().collect();
        roots.sort();
        roots.iter().map(|root| entries[*root].clone()).collect()
    }

    /// Forget one entry — the user closed the folder. Bumps the epoch so in-flight
    /// snapshots for it are recognisably stale.
    pub fn close(&self, root: &Path) {
        self.write().remove(root);
        self.bump_epoch();
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, HashMap<PathBuf, Arc<T>>> {
        self.entries.read().expect("registry lock poisoned")
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, HashMap<PathBuf, Arc<T>>> {
        self.entries.write().expect("registry lock poisoned")
    }
}

impl<T: RootEntry> RootRegistry<T> {
    /// What every open entry says it is, in root order.
    pub fn infos(&self) -> Vec<T::Info> {
        self.list().iter().map(|entry| entry.info()).collect()
    }
}

impl<T> Default for RootRegistry<T> {
    fn default() -> Self {
        Self {
            entries: RwLock::new(HashMap::new()),
            epoch: AtomicU64::new(0),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Entry(&'static str);

    impl RootEntry for Entry {
        type Info = &'static str;

        fn info(&self) -> Self::Info {
            self.0
        }
    }

    fn registry() -> RootRegistry<Entry> {
        let registry = RootRegistry::new();
        for (root, name) in [("b", "second"), ("a", "first")] {
            registry.insert_or_keep(PathBuf::from(root), Arc::new(Entry(name)), |_| false);
        }
        registry
    }

    #[test]
    fn entries_are_listed_in_root_order() {
        assert_eq!(registry().infos(), ["first", "second"]);
    }

    #[test]
    fn an_accepted_existing_entry_is_kept_and_returned() {
        let registry = registry();
        let kept = registry.insert_or_keep(PathBuf::from("a"), Arc::new(Entry("new")), |_| true);

        assert_eq!(kept.info(), "first");
        assert_eq!(registry.get(Path::new("a")).unwrap().info(), "first");
    }

    #[test]
    fn a_rejected_existing_entry_is_replaced() {
        let registry = registry();
        registry.insert_or_keep(PathBuf::from("a"), Arc::new(Entry("new")), |_| false);

        assert_eq!(registry.get(Path::new("a")).unwrap().info(), "new");
    }

    #[test]
    fn closing_forgets_the_entry_and_bumps_the_epoch() {
        let registry = registry();
        assert_eq!(registry.epoch(), 0);

        registry.close(Path::new("a"));
        assert_eq!(registry.infos(), ["second"]);
        assert_eq!(registry.epoch(), 1);
        assert!(registry.get(Path::new("a")).is_none());
    }
}
