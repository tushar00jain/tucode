//! The streaming spine shared by file and text search: run the walk on worker
//! threads, drain its results on one collector thread, and hand them to the
//! caller in batches.
//!
//! Batching lives here and nowhere else — a callback per hit is what floods the
//! IPC channel, and the fix belongs at the one boundary both searches cross.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::Instant;

use crate::batch::{BatchedCollector, MAX_BATCH_SIZE};
use crate::cancel::CancellationToken;
use crate::error::SearchError;
use crate::types::{SearchComplete, SearchEngineStats, SearchProgress, SerializedFileMatch};

/// The walk statistics both searches keep, shared across the walker's worker
/// threads. `results` counts what stock reports as `cmdResultCount` — matched
/// files for file search, matched ranges for text search.
#[derive(Default)]
pub(crate) struct Counters {
    pub results: AtomicUsize,
    pub files_walked: AtomicUsize,
    pub directories_walked: AtomicUsize,
    pub limit_hit: AtomicBool,
}

impl Counters {
    /// The completion item for a walk that began at `started`.
    pub fn complete(&self, started: Instant) -> SearchComplete {
        let file_walk_time = started.elapsed().as_millis() as u64;
        SearchComplete {
            limit_hit: self.limit_hit.load(Ordering::Acquire),
            stats: SearchEngineStats {
                file_walk_time,
                cmd_time: file_walk_time,
                directories_walked: self.directories_walked.load(Ordering::Acquire),
                files_walked: self.files_walked.load(Ordering::Acquire),
                cmd_result_count: self.results.load(Ordering::Acquire),
            },
            messages: Vec::new(),
        }
    }

    pub fn limit_hit(&self) -> bool {
        self.limit_hit.load(Ordering::Acquire)
    }
}

/// Runs `walk` on a worker thread while this thread batches what it produces.
///
/// A cancelled search stops emitting: the collector re-checks the token before
/// every callback, and because each search is started with its own callback it
/// has no path into a later search's results even if a batch slips through.
pub(crate) fn stream<W, F>(
    token: &CancellationToken,
    walk: W,
    mut on_progress: F,
) -> Result<SearchComplete, SearchError>
where
    W: FnOnce(Sender<SerializedFileMatch>) -> Result<SearchComplete, SearchError> + Send,
    F: FnMut(SearchProgress) + Send,
{
    let (tx, rx) = mpsc::channel::<SerializedFileMatch>();

    let complete = std::thread::scope(|scope| {
        let worker = scope.spawn(move || walk(tx));
        drain(rx, token, &mut on_progress);
        worker
            .join()
            .map_err(|_| SearchError::Engine("search worker panicked".into()))?
    })?;

    if token.is_cancelled() {
        return Err(SearchError::Canceled);
    }
    Ok(complete)
}

fn drain<F: FnMut(SearchProgress)>(
    rx: Receiver<SerializedFileMatch>,
    token: &CancellationToken,
    on_progress: &mut F,
) {
    let mut collector = BatchedCollector::new(MAX_BATCH_SIZE, |items: Vec<SerializedFileMatch>| {
        if !token.is_cancelled() {
            on_progress(SearchProgress::FileMatches(items));
        }
    });

    loop {
        let received = match collector.timeout_deadline() {
            Some(deadline) => rx.recv_timeout(deadline.saturating_duration_since(Instant::now())),
            None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };

        match received {
            Ok(item) => {
                // File search entries carry no matches; weighting them 1 gives
                // stock's plain 512-files-per-batch behaviour for that path.
                let size = item.num_matches.max(1);
                collector.add_item(item, size);
            }
            Err(RecvTimeoutError::Timeout) => collector.flush(),
            Err(RecvTimeoutError::Disconnected) => {
                collector.flush();
                break;
            }
        }
    }
}
