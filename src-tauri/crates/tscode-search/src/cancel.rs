//! Cancellation. The search view runs a query per keystroke, so a query the
//! frontend has abandoned must stop walking the tree.
//!
//! One token per query, and only the caller that started a query can cancel it —
//! stock's model, where cancellation rides the `CancellationToken` the search
//! was issued with. The channel is shared by every caller, and several of them
//! search at once: the search view's text query runs alongside the notebook
//! service's file queries, and quick access populates its cache while the user
//! types. A channel-wide "newest query wins" would have those cancel each other.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Equivalent of stock `CancellationToken`. Cloning shares the flag; cancelling
/// is idempotent, so cancelling twice — or cancelling a search that already
/// finished — is harmless.
#[derive(Debug, Clone, Default)]
pub struct CancellationToken(Arc<AtomicBool>);

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancelling_one_token_leaves_a_concurrent_search_running() {
        let first = CancellationToken::new();
        let second = CancellationToken::new();
        first.cancel();
        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());
    }

    #[test]
    fn a_clone_shares_the_flag_and_cancelling_twice_is_harmless() {
        let token = CancellationToken::new();
        let clone = token.clone();
        token.cancel();
        token.cancel();
        assert!(clone.is_cancelled());
    }
}
