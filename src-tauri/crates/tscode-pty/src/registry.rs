//! The pty id → process map, standing in for `_ptys` in
//! `vs/platform/terminal/node/ptyService.ts`.
//!
//! Stock's ids are `PersistentTerminalProcess` ids, minted by `ptyService.ts`
//! and meaningful across a reload. Nothing persists here (see the architecture
//! doc), so an id lives exactly as long as its process and is only ever a handle
//! for the channel to name one.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use crate::error::{PtyError, Result};
use crate::process::TerminalProcess;

/// Every live terminal process.
pub struct PtyRegistry {
    /// Starts at 1, so 0 is never a valid pty id — stock reserves it for "does
    /// not support reconnection".
    next_id: AtomicU32,
    ptys: Mutex<HashMap<u32, Arc<TerminalProcess>>>,
}

impl PtyRegistry {
    pub fn new() -> Self {
        Self {
            next_id: AtomicU32::new(1),
            ptys: Mutex::new(HashMap::new()),
        }
    }

    /// Allocate an id and store the process built for it, as one step: a
    /// process needs its own id to address the events it will fire, and an id
    /// that named nothing would be a handle the frontend could never use.
    pub fn create<F>(&self, build: F) -> u32
    where
        F: FnOnce(u32) -> Arc<TerminalProcess>,
    {
        let id = self.next_id.fetch_add(1, Ordering::AcqRel);
        self.ptys().insert(id, build(id));
        id
    }

    pub fn get(&self, id: u32) -> Result<Arc<TerminalProcess>> {
        self.ptys()
            .get(&id)
            .cloned()
            .ok_or(PtyError::NoSuchProcess(id))
    }

    /// Idempotent: a process that exited and one the frontend disposed twice
    /// both land here.
    pub fn remove(&self, id: u32) {
        self.ptys().remove(&id);
    }

    /// Shut every terminal down and wait for its child to be reaped. The window
    /// that owned them is gone.
    ///
    /// Asking every one of them first and waiting afterwards is what keeps the
    /// cost at one terminal's teardown rather than the sum of them: stock's
    /// `shutdown` is a request whose timers run concurrently.
    pub async fn shutdown_all(&self) {
        let processes: Vec<Arc<TerminalProcess>> =
            std::mem::take(&mut *self.ptys()).into_values().collect();
        for process in &processes {
            process.shutdown(true);
        }
        for process in &processes {
            process.wait_until_reaped().await;
        }
    }

    /// A poisoned lock means a panic while holding it. Entries are inserted and
    /// removed whole, so the map is still coherent and recovering beats taking
    /// every later call down with it.
    fn ptys(&self) -> MutexGuard<'_, HashMap<u32, Arc<TerminalProcess>>> {
        self.ptys.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Hand-written rather than derived: a derived `Default` would start ids at 0,
/// which stock reserves.
impl Default for PtyRegistry {
    fn default() -> Self {
        Self::new()
    }
}
