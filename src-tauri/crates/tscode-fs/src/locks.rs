//! Per-resource write locks.
//!
//! Port of the `resourceLocks` / `createResourceLock()` machinery in
//! `vs/platform/files/node/diskFileSystemProvider.ts`. Stock queues `Barrier`s
//! in a `ResourceMap` and loops until none remain; a `tokio::sync::Mutex` per
//! resource gives the same FIFO serialisation without the loop.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, Weak};

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

use crate::paths::comparison_key;

/// Sweep dead entries once the table grows past this, then again after it
/// doubles — bounded memory without an O(n) sweep on every acquisition.
const MIN_SWEEP_THRESHOLD: usize = 64;

/// Held for as long as the caller owns the resource. Dropping it releases the
/// resource to the next waiter and lets the table entry expire.
pub struct ResourceLock(#[allow(dead_code)] OwnedMutexGuard<()>);

impl std::fmt::Debug for ResourceLock {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ResourceLock")
    }
}

#[derive(Default)]
struct Table {
    entries: HashMap<String, Weak<AsyncMutex<()>>>,
    sweep_threshold: usize,
}

/// The provider's lock table. Keyed the same way stock keys its `ResourceMap`:
/// case-insensitively except on case-sensitive filesystems.
#[derive(Default)]
pub struct ResourceLocks {
    table: Mutex<Table>,
}

impl ResourceLocks {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Waits for any pending lock on `path`, then takes it.
    pub async fn acquire(&self, path: &Path) -> ResourceLock {
        let key = lock_key(path);
        let mutex = {
            let mut table = self
                .table
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);

            if table.entries.len() > table.sweep_threshold.max(MIN_SWEEP_THRESHOLD) {
                table.entries.retain(|_, weak| weak.strong_count() > 0);
                table.sweep_threshold = table.entries.len().saturating_mul(2);
            }

            match table.entries.get(&key).and_then(Weak::upgrade) {
                Some(existing) => existing,
                None => {
                    let fresh = Arc::new(AsyncMutex::new(()));
                    table.entries.insert(key, Arc::downgrade(&fresh));
                    fresh
                }
            }
        };

        ResourceLock(mutex.lock_owned().await)
    }

    /// Takes both locks an atomic write or clone needs. Always acquires in a
    /// stable order, so two callers with the same pair cannot deadlock.
    pub async fn acquire_pair(&self, a: &Path, b: &Path) -> (ResourceLock, ResourceLock) {
        if lock_key(a) <= lock_key(b) {
            let first = self.acquire(a).await;
            let second = self.acquire(b).await;
            (first, second)
        } else {
            let second = self.acquire(b).await;
            let first = self.acquire(a).await;
            (first, second)
        }
    }
}

fn lock_key(path: &Path) -> String {
    comparison_key(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    #[tokio::test]
    async fn second_acquirer_waits_for_the_first() {
        let locks = Arc::new(ResourceLocks::new());
        let order = Arc::new(AtomicUsize::new(0));
        let path = Path::new("/tmp/tscode/a.txt");

        let held = locks.acquire(path).await;

        let waiter = {
            let locks = Arc::clone(&locks);
            let order = Arc::clone(&order);
            tokio::spawn(async move {
                let _lock = locks.acquire(Path::new("/tmp/tscode/a.txt")).await;
                order.fetch_add(1, Ordering::SeqCst)
            })
        };

        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(order.load(Ordering::SeqCst), 0, "waiter must still be blocked");

        drop(held);
        assert_eq!(waiter.await.unwrap(), 0, "waiter runs only after release");
    }

    #[tokio::test]
    async fn different_resources_do_not_block_each_other() {
        let locks = ResourceLocks::new();
        let _a = locks.acquire(Path::new("/tmp/tscode/a.txt")).await;
        let _b = locks.acquire(Path::new("/tmp/tscode/b.txt")).await;
    }

    #[tokio::test]
    async fn released_entries_are_reusable() {
        let locks = ResourceLocks::new();
        drop(locks.acquire(Path::new("/tmp/tscode/a.txt")).await);
        let _again = locks.acquire(Path::new("/tmp/tscode/a.txt")).await;
    }
}
