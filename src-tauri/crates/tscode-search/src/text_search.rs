//! Text search — find content in files.
//!
//! This crate stands exactly where stock's `RipgrepTextSearchEngine` stands:
//! it *is* the `TextSearchProvider2` behind the `search` channel, so it is asked
//! in `TextSearchQuery2` + `TextSearchProviderOptions` and answers in
//! `TextSearchResult2`. Everything above that boundary —
//! `common/textSearchManager.ts`'s glob re-testing, its sibling `when` clauses,
//! its `maxResults` trimming, its batching and its stats — is stock's own code
//! running in the renderer, and none of it is duplicated here.
//!
//! Port of `RipgrepParser` / `createTextSearchMatch` from
//! `vs/workbench/services/search/node/ripgrepTextSearchEngine.ts`, reading
//! submatches straight off `grep-searcher` instead of ripgrep's `--json` stream.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::time::Instant;

use grep_matcher::Matcher;
use grep_regex::RegexMatcher;
use grep_searcher::{
    BinaryDetection, Encoding, Searcher, SearcherBuilder, Sink, SinkContext, SinkMatch,
};
use ignore::WalkState;
use tscode_fs::WorkspaceRoots;

use crate::cancel::CancellationToken;
use crate::engine::{self, Counters};
use crate::error::SearchError;
use crate::matcher::{build_matcher, line_terminator};
use crate::preview::build_text_search_match;
use crate::query::{PreviewOptions, TextSearchProviderOptions, TextSearchRequest};
use crate::roots::validate_roots;
use crate::text::num_lines_and_last_line_len;
use crate::types::{
    SearchComplete, SearchProgress, SearchRange, SerializedFileMatch, TextSearchContext,
    TextSearchResult,
};
use crate::walker::{build_walker, WalkSpec};

/// Searches file contents, streaming batched per-file results to `on_progress`.
/// CPU-bound work runs on the blocking pool, never on the runtime.
pub async fn text_search<F>(
    request: TextSearchRequest,
    roots: Arc<WorkspaceRoots>,
    token: CancellationToken,
    on_progress: F,
) -> Result<SearchComplete, SearchError>
where
    F: FnMut(SearchProgress) + Send + 'static,
{
    let paths: Vec<&Path> =
        request.options.folder_options.iter().map(|f| f.folder.as_path()).collect();
    let folders = validate_roots(&roots, &paths).await?;

    tokio::task::spawn_blocking(move || {
        text_search_blocking(&request, &folders, &token, on_progress)
    })
    .await
    .map_err(|e| SearchError::Engine(e.to_string()))?
}

fn text_search_blocking<F>(
    request: &TextSearchRequest,
    folders: &[PathBuf],
    token: &CancellationToken,
    on_progress: F,
) -> Result<SearchComplete, SearchError>
where
    F: FnMut(SearchProgress) + Send,
{
    let matcher = build_matcher(&request.query)?;
    let counters = Counters::default();
    let options = &request.options;

    engine::stream(
        token,
        |tx| {
            let started = Instant::now();
            for (folder, root) in options.folder_options.iter().zip(folders) {
                if token.is_cancelled() || counters.limit_hit() {
                    break;
                }
                let searcher = SearcherSpec {
                    encoding: build_encoding(&folder.encoding)?,
                    is_multiline: request.query.is_multiline,
                    surrounding_context: options.surrounding_context,
                };
                let walker = build_walker(root, &WalkSpec::for_folder_options(options, folder))?;
                walk_folder(walker, &searcher, options, &matcher, &counters, token, &tx);
            }
            Ok(counters.complete(started))
        },
        on_progress,
    )
}

/// Port of `getRgArgs`'s `--encoding` branch: the flag is passed for anything
/// but the default, and an unrecognised name is stock's `unknownEncoding` error.
fn build_encoding(name: &str) -> Result<Option<Encoding>, SearchError> {
    if name.is_empty() || name == "utf8" {
        return Ok(None);
    }

    Encoding::new(name)
        .map(Some)
        .map_err(|_| SearchError::UnknownEncoding(name.to_owned()))
}

/// The per-folder searcher settings, built once and cloned onto every walker
/// thread.
struct SearcherSpec {
    encoding: Option<Encoding>,
    is_multiline: bool,
    surrounding_context: usize,
}

impl SearcherSpec {
    fn build(&self) -> Searcher {
        SearcherBuilder::new()
            .line_terminator(line_terminator())
            .line_number(true)
            .multi_line(self.is_multiline)
            .before_context(self.surrounding_context)
            .after_context(self.surrounding_context)
            .binary_detection(BinaryDetection::quit(b'\x00'))
            .encoding(self.encoding.clone())
            .build()
    }
}

#[allow(clippy::too_many_arguments)]
fn walk_folder(
    walker: ignore::WalkParallel,
    searcher_spec: &SearcherSpec,
    options: &TextSearchProviderOptions,
    matcher: &RegexMatcher,
    counters: &Counters,
    token: &CancellationToken,
    tx: &Sender<SerializedFileMatch>,
) {
    walker.run(|| {
        let tx = tx.clone();
        let mut searcher = searcher_spec.build();
        Box::new(move |entry| {
            if token.is_cancelled() || counters.limit_hit() {
                return WalkState::Quit;
            }

            let Ok(entry) = entry else { return WalkState::Continue };
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                if entry.depth() > 0 {
                    counters.directories_walked.fetch_add(1, Ordering::AcqRel);
                }
                return WalkState::Continue;
            }
            counters.files_walked.fetch_add(1, Ordering::AcqRel);

            let mut sink = FileSink {
                matcher,
                preview_options: &options.preview_options,
                max_results: options.max_results,
                counters,
                token,
                results: Vec::new(),
            };

            // An unreadable or undecodable file is skipped and reported, as
            // ripgrep skips it and warns on stderr.
            if let Err(error) = searcher.search_path(matcher, entry.path(), &mut sink) {
                log::warn!("search: skipping {}: {error}", entry.path().display());
                return WalkState::Continue;
            }

            if sink.results.is_empty() {
                return WalkState::Continue;
            }

            let path = entry.path().to_string_lossy().into_owned();
            if tx.send(SerializedFileMatch::new(path, sink.results)).is_err() {
                return WalkState::Quit;
            }
            WalkState::Continue
        })
    });
}

struct FileSink<'a> {
    matcher: &'a RegexMatcher,
    preview_options: &'a PreviewOptions,
    max_results: Option<usize>,
    counters: &'a Counters,
    token: &'a CancellationToken,
    results: Vec<TextSearchResult>,
}

impl FileSink<'_> {
    fn should_stop(&self) -> bool {
        self.token.is_cancelled() || self.counters.limit_hit()
    }

    /// Port of `RipgrepParser.createTextSearchMatch`'s range loop. `text` is the
    /// matched line(s) as ripgrep's `lines` field would carry them, and the
    /// submatch offsets are byte offsets into it.
    fn build_ranges(&self, text: &str, submatches: &[(usize, usize)], first_line: u32) -> Vec<SearchRange> {
        let mut ranges = Vec::with_capacity(submatches.len());
        let mut prev_match_end = 0usize;
        let mut prev_match_end_col = 0u32;
        let mut prev_match_end_line = first_line;

        for &(start, end) in submatches {
            if self.counters.limit_hit() {
                break;
            }
            let count = self.counters.results.fetch_add(1, Ordering::AcqRel) + 1;
            if self.max_results.is_some_and(|max| count >= max) {
                // Finish the line, then report the result.
                self.counters.limit_hit.store(true, Ordering::Release);
            }

            let (between_lines, between_last_len) =
                num_lines_and_last_line_len(&text[prev_match_end..start]);
            let start_column = if between_lines > 0 {
                between_last_len
            } else {
                between_last_len + prev_match_end_col
            };

            let (match_lines, match_last_len) = num_lines_and_last_line_len(&text[start..end]);
            let start_line_number = between_lines + prev_match_end_line;
            let end_line_number = match_lines + start_line_number;
            let end_column = if match_lines > 0 {
                match_last_len
            } else {
                match_last_len + start_column
            };

            prev_match_end = end;
            prev_match_end_col = end_column;
            prev_match_end_line = end_line_number;

            ranges.push(SearchRange::new(
                start_line_number,
                start_column,
                end_line_number,
                end_column,
            ));
        }

        ranges
    }
}

impl Sink for FileSink<'_> {
    type Error = io::Error;

    fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, io::Error> {
        if self.should_stop() {
            return Ok(false);
        }

        // Offsets below index this text; a line we cannot decode would shift
        // every column, so skip it rather than report wrong ranges.
        let Ok(text) = std::str::from_utf8(mat.bytes()) else {
            return Ok(true);
        };

        let mut submatches: Vec<(usize, usize)> = Vec::new();
        self.matcher
            .find_iter(mat.bytes(), |m| {
                submatches.push((m.start(), m.end()));
                true
            })
            .map_err(|e| io::Error::other(e.to_string()))?;

        // Some regexes match a line without producing a submatch — stock
        // synthesises one so the line still shows up (microsoft/vscode#100569).
        if submatches.is_empty() {
            let end = text.chars().next().map_or(0, char::len_utf8);
            submatches.push((0, end));
        }

        let first_line = mat.line_number().unwrap_or(1).saturating_sub(1) as u32;
        let ranges = self.build_ranges(text, &submatches, first_line);
        if ranges.is_empty() {
            return Ok(false);
        }

        self.results.push(TextSearchResult::Match(build_text_search_match(
            text,
            ranges,
            Some(self.preview_options),
        )));
        Ok(!self.should_stop())
    }

    fn context(&mut self, _searcher: &Searcher, ctx: &SinkContext<'_>) -> Result<bool, io::Error> {
        if self.should_stop() {
            return Ok(false);
        }
        let Ok(text) = std::str::from_utf8(ctx.bytes()) else {
            return Ok(true);
        };
        // Stock emits context line numbers 1-based, unlike match ranges.
        self.results.push(TextSearchResult::Context(TextSearchContext {
            text: text.trim_end_matches('\n').trim_end_matches('\r').to_string(),
            line_number: ctx.line_number().unwrap_or(1) as u32,
        }));
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::query::TextSearchQuery;

    const PREVIEW: PreviewOptions = PreviewOptions { match_lines: 100, chars_per_line: 10_000 };

    /// The three things a [`FileSink`] borrows, owned together so they outlive it: a range test
    /// names its pattern and asks for a sink, rather than building the same three values first.
    struct SinkFixture {
        matcher: RegexMatcher,
        counters: Counters,
        token: CancellationToken,
    }

    impl SinkFixture {
        fn new(pattern: &str) -> Self {
            Self {
                matcher: build_matcher(&TextSearchQuery {
                    pattern: pattern.into(),
                    ..Default::default()
                })
                .unwrap(),
                counters: Counters::default(),
                token: CancellationToken::new(),
            }
        }

        fn sink(&self) -> FileSink<'_> {
            FileSink {
                matcher: &self.matcher,
                preview_options: &PREVIEW,
                max_results: None,
                counters: &self.counters,
                token: &self.token,
                results: Vec::new(),
            }
        }
    }

    #[test]
    fn single_match_range_is_zero_based_line_and_utf16_columns() {
        let fixture = SinkFixture::new("bar");
        let sink = fixture.sink();

        // "é" is one UTF-16 unit but two bytes — the column must be 4, not 5.
        let text = "foé bar\n";
        let ranges = sink.build_ranges(text, &[(5, 8)], 9);
        assert_eq!(ranges, vec![SearchRange::new(9, 4, 9, 7)]);
    }

    #[test]
    fn multiple_matches_on_a_line_advance_columns_cumulatively() {
        let fixture = SinkFixture::new("a");
        let sink = fixture.sink();

        let ranges = sink.build_ranges("a-a\n", &[(0, 1), (2, 3)], 0);
        assert_eq!(
            ranges,
            vec![SearchRange::new(0, 0, 0, 1), SearchRange::new(0, 2, 0, 3)]
        );
    }

    #[test]
    fn a_match_spanning_lines_reports_the_end_line_and_column() {
        let fixture = SinkFixture::new("a");
        let sink = fixture.sink();

        // Match covers "aa\nbb" starting at line 3.
        let ranges = sink.build_ranges("aa\nbb\n", &[(0, 5)], 3);
        assert_eq!(ranges, vec![SearchRange::new(3, 0, 4, 2)]);
    }

    #[test]
    fn hitting_max_results_stops_further_ranges() {
        let fixture = SinkFixture::new("a");
        let mut sink = fixture.sink();
        sink.max_results = Some(1);

        let ranges = sink.build_ranges("aaa\n", &[(0, 1), (1, 2), (2, 3)], 0);
        assert_eq!(ranges.len(), 1);
        assert!(fixture.counters.limit_hit());
    }

    #[test]
    fn only_a_non_default_encoding_is_passed_through() {
        assert!(build_encoding("").unwrap().is_none());
        assert!(build_encoding("utf8").unwrap().is_none());
        assert!(build_encoding("windows-1252").unwrap().is_some());
        assert!(matches!(
            build_encoding("not-an-encoding"),
            Err(SearchError::UnknownEncoding(_))
        ));
    }

    /// A folder configured with a non-UTF-8 `files.encoding` is decoded before
    /// matching — as raw bytes the `é` below is not valid UTF-8 at all.
    #[tokio::test]
    async fn a_windows_1252_file_is_decoded_before_matching() {
        let tmp = tempfile::TempDir::new().unwrap();
        // "caf<0xE9>" — é in windows-1252, invalid on its own in UTF-8.
        std::fs::write(tmp.path().join("cafe.txt"), b"caf\xE9\n").unwrap();

        let roots = Arc::new(WorkspaceRoots::new());
        roots.add_root(tmp.path()).await.unwrap();

        let request = TextSearchRequest {
            query: TextSearchQuery { pattern: "café".into(), ..Default::default() },
            options: TextSearchProviderOptions {
                folder_options: vec![crate::query::TextSearchFolderOptions {
                    folder: tmp.path().to_path_buf(),
                    includes: Vec::new(),
                    excludes: Vec::new(),
                    ignore_glob_case: false,
                    follow_symlinks: false,
                    use_ignore_files: Default::default(),
                    encoding: "windows-1252".into(),
                }],
                ..Default::default()
            },
        };

        let (tx, rx) = std::sync::mpsc::channel();
        text_search(request, roots, CancellationToken::new(), move |progress| {
            if let SearchProgress::FileMatches(matches) = progress {
                for one in matches {
                    let _ = tx.send(one);
                }
            }
        })
        .await
        .unwrap();

        let matches: Vec<_> = rx.into_iter().collect();
        assert_eq!(matches.len(), 1, "{matches:?}");
        assert_eq!(matches[0].num_matches, 1);
    }
}
