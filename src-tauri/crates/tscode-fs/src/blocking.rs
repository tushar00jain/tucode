//! The one place blocking filesystem work leaves the async runtime.
//!
//! Every syscall in this crate goes through here, so no `async fn` ever parks a
//! runtime worker thread on disk I/O.

use crate::error::{join_error, FsResult};

/// Runs `work` on the blocking pool and awaits its result.
pub(crate) async fn run<T, F>(work: F) -> FsResult<T>
where
    F: FnOnce() -> FsResult<T> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(work).await.map_err(join_error)?
}
