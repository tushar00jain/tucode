//! File and text search for tscode.
//!
//! Built on ripgrep's own crates — `ignore` for the walk (and with it correct
//! gitignore semantics), `grep-regex` and `grep-searcher` for matching. That is
//! the same engine stock VS Code shells out to, so the porting notes throughout
//! point at the stock file each piece comes from.
//!
//! The public surface is deliberately free of Tauri types; the `search` channel
//! wraps it.
//!
//! ```ignore
//! let token = CancellationToken::new();        // one per query
//! let complete = text_search(request, roots, token, |batch| sink.emit(batch)).await?;
//! ```
//!
//! **The two searches are asked at different stock boundaries.** File search
//! stands where stock's `ISearchEngine` does, below `rawSearchService`, so it
//! takes `IFileQueryProps`. Text search stands where
//! `RipgrepTextSearchEngine` does — it *is* the `TextSearchProvider2` — so it
//! takes `TextSearchQuery2` + `TextSearchProviderOptions`, and stock's
//! `common/textSearchManager.ts` keeps everything above that: glob re-testing,
//! sibling `when` clauses, `maxResults` trimming, result batching and stats.
//!
//! **Batching.** Results reach `on_progress` as `SearchProgress::FileMatches`
//! batches of up to [`batch::MAX_BATCH_SIZE`] matches — never one call per hit.
//! The first 50 matches flush immediately so the view fills at once; after that
//! batches fill up or time out after 4 s. This is stock's `BatchedCollector`.
//!
//! **Cancellation.** Each query carries its own [`CancellationToken`], cancelled
//! by whoever started it — several callers search this crate at once, so there is
//! no "newest query wins" anywhere. Cancelling twice, or cancelling a finished
//! search, is a no-op. A cancelled search stops emitting and resolves to
//! [`SearchError::Canceled`]; because each search is started with its own
//! callback, a straggler batch can never reach another query's sink.

mod batch;
mod cancel;
mod engine;
mod error;
mod file_search;
mod matcher;
mod preview;
mod query;
mod roots;
mod text;
mod text_search;
mod types;
mod walker;

pub use batch::MAX_BATCH_SIZE;
pub use cancel::CancellationToken;
pub use error::{SearchError, SearchErrorCode};
pub use file_search::file_search;
pub use query::{
    CommonQuery, FileQuery, FolderQuery, GlobPattern, PreviewOptions, TextSearchFolderOptions,
    TextSearchProviderOptions, TextSearchQuery, TextSearchRequest, UseIgnoreFiles,
};
pub use text_search::text_search;
pub use types::{
    ProgressMessage, RawFileMatch, SearchComplete, SearchEngineStats, SearchProgress, SearchRange,
    SearchRangeSetPairing, SerializedFileMatch, TextSearchCompleteMessage, TextSearchContext,
    TextSearchMatch, TextSearchResult,
};

/// Stock `DEFAULT_MAX_SEARCH_RESULTS`.
pub const DEFAULT_MAX_SEARCH_RESULTS: usize = 20_000;
