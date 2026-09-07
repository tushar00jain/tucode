//! File search — find files by name. Port of the filtering model in
//! `vs/workbench/services/search/node/fileSearch.ts` (`isFileMatch`,
//! `matchFile`, `getSearchPath`) over ripgrep's `ignore` walker.

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::time::Instant;

use globset::{Glob, GlobMatcher, GlobSet, GlobSetBuilder};
use ignore::WalkState;
use tscode_fs::WorkspaceRoots;

use crate::cancel::CancellationToken;
use crate::engine::{self, Counters};
use crate::error::SearchError;
use crate::query::{CommonQuery, FileQuery, FolderQuery};
use crate::roots::validate_roots;
use crate::text::{fuzzy_contains, normalize_query};
use crate::types::{RawFileMatch, SearchComplete, SearchProgress, SerializedFileMatch};
use crate::walker::{build_walker, WalkSpec};

/// Finds files whose path matches `query.file_pattern`, streaming batches to
/// `on_progress`. CPU-bound work runs on the blocking pool, never on the runtime.
pub async fn file_search<F>(
    query: FileQuery,
    roots: Arc<WorkspaceRoots>,
    token: CancellationToken,
    on_progress: F,
) -> Result<SearchComplete, SearchError>
where
    F: FnMut(SearchProgress) + Send + 'static,
{
    let paths: Vec<&Path> = query.common.folder_queries.iter().map(|f| f.folder.as_path()).collect();
    let folders = validate_roots(&roots, &paths).await?;

    tokio::task::spawn_blocking(move || file_search_blocking(&query, &folders, &token, on_progress))
        .await
        .map_err(|e| SearchError::Engine(e.to_string()))?
}

fn file_search_blocking<F>(
    query: &FileQuery,
    folders: &[PathBuf],
    token: &CancellationToken,
    on_progress: F,
) -> Result<SearchComplete, SearchError>
where
    F: FnMut(SearchProgress) + Send,
{
    let filter = FilePatternFilter::new(query)?;
    let counters = Counters::default();

    engine::stream(
        token,
        |tx| {
            let started = Instant::now();
            match_extra_files(query, &filter, &counters, &tx)?;
            for (folder, root) in query.common.folder_queries.iter().zip(folders) {
                if token.is_cancelled() || counters.limit_hit() {
                    break;
                }
                walk_folder(root, folder, &query.common, query, &filter, &counters, token, &tx)?;
            }
            Ok(counters.complete(started))
        },
        on_progress,
    )
}

#[allow(clippy::too_many_arguments)]
fn walk_folder(
    root: &Path,
    folder: &FolderQuery,
    common: &CommonQuery,
    query: &FileQuery,
    filter: &FilePatternFilter,
    counters: &Counters,
    token: &CancellationToken,
    tx: &Sender<SerializedFileMatch>,
) -> Result<(), SearchError> {
    let walker = build_walker(root, &WalkSpec::for_file_query(common, folder))?;
    let base = root.to_string_lossy().into_owned();

    walker.run(|| {
        let tx = tx.clone();
        let base = base.clone();
        Box::new(move |entry| {
            if token.is_cancelled() || counters.limit_hit() {
                return WalkState::Quit;
            }

            // Unreadable entries are skipped, exactly as ripgrep skips them.
            let Ok(entry) = entry else { return WalkState::Continue };
            if entry.depth() == 0 {
                return WalkState::Continue;
            }
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                counters.directories_walked.fetch_add(1, Ordering::AcqRel);
                return WalkState::Continue;
            }
            counters.files_walked.fetch_add(1, Ordering::AcqRel);

            let Ok(relative) = entry.path().strip_prefix(root) else {
                return WalkState::Continue;
            };
            let candidate = RawFileMatch {
                base: Some(base.clone()),
                relative_path: relative.to_string_lossy().into_owned(),
                search_path: search_path(folder, &relative.to_string_lossy()),
            };

            if match_file(candidate, query, filter, counters, &tx) {
                WalkState::Continue
            } else {
                WalkState::Quit
            }
        })
    });

    Ok(())
}

/// Port of `FileSearchEngine.matchFile`. `exists` reports only whether anything
/// matched, and passing the cap stops the walk — so the answer is "keep going".
fn match_file(
    candidate: RawFileMatch,
    query: &FileQuery,
    filter: &FilePatternFilter,
    counters: &Counters,
    tx: &Sender<SerializedFileMatch>,
) -> bool {
    if !filter.matches(&candidate) {
        return true;
    }

    let count = counters.results.fetch_add(1, Ordering::AcqRel) + 1;
    let over_limit = query.common.max_results.is_some_and(|max| count > max);
    if query.exists || over_limit {
        counters.limit_hit.store(true, Ordering::Release);
        return false;
    }

    tx.send(candidate.into_serialized()).is_ok()
}

/// Port of `FileWalker.walk`'s extra-files loop — the open editors that lie
/// outside every workspace folder, which no walk would ever reach.
///
/// They are tested against the query-wide excludes and the file pattern and
/// never stat'ed, exactly as stock does, so nothing here reads a path the
/// workspace roots would deny.
fn match_extra_files(
    query: &FileQuery,
    filter: &FilePatternFilter,
    counters: &Counters,
    tx: &Sender<SerializedFileMatch>,
) -> Result<(), SearchError> {
    if query.common.extra_file_resources.is_empty() {
        return Ok(());
    }

    let excludes = build_glob_set(&query.common.exclude_pattern)?;
    for path in &query.common.extra_file_resources {
        if excludes.is_match(path) {
            continue;
        }

        // A file outside every folder has no workspace-relative path, so stock
        // matches on the absolute one.
        let candidate = RawFileMatch {
            base: None,
            relative_path: path.to_string_lossy().into_owned(),
            search_path: None,
        };
        if !match_file(candidate, query, filter, counters, tx) {
            break;
        }
    }

    Ok(())
}

fn build_glob_set(patterns: &[String]) -> Result<GlobSet, SearchError> {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        builder.add(Glob::new(pattern).map_err(|e| SearchError::GlobParse(e.to_string()))?);
    }
    builder.build().map_err(|e| SearchError::GlobParse(e.to_string()))
}

/// Port of `FileSearchEngine.getSearchPath`.
fn search_path(folder: &FolderQuery, relative_path: &str) -> Option<String> {
    folder
        .folder_name
        .as_ref()
        .map(|name| Path::new(name).join(relative_path).to_string_lossy().into_owned())
}

/// Port of `FileSearchEngine.isFileMatch` + `isFilePatternMatch`.
enum FilePatternFilter {
    Any,
    Fuzzy(String),
    Glob(GlobMatcher),
}

impl FilePatternFilter {
    fn new(query: &FileQuery) -> Result<Self, SearchError> {
        let Some(pattern) = query.file_pattern.as_deref().filter(|p| !p.is_empty()) else {
            return Ok(Self::Any);
        };
        if pattern == "*" {
            return Ok(Self::Any);
        }

        if query.should_glob_match_file_pattern {
            let matcher = Glob::new(pattern)
                .map_err(|e| SearchError::GlobParse(e.to_string()))?
                .compile_matcher();
            return Ok(Self::Glob(matcher));
        }

        Ok(Self::Fuzzy(normalize_query(pattern)))
    }

    fn matches(&self, candidate: &RawFileMatch) -> bool {
        match self {
            Self::Any => true,
            Self::Fuzzy(pattern) => fuzzy_contains(candidate.path_to_match(), pattern),
            Self::Glob(matcher) => matcher.is_match(candidate.path_to_match()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(relative_path: &str) -> RawFileMatch {
        RawFileMatch {
            base: Some("/root".into()),
            relative_path: relative_path.into(),
            search_path: None,
        }
    }

    fn filter(pattern: &str, glob: bool) -> FilePatternFilter {
        FilePatternFilter::new(&FileQuery {
            file_pattern: Some(pattern.into()),
            should_glob_match_file_pattern: glob,
            ..Default::default()
        })
        .unwrap()
    }

    #[test]
    fn empty_and_star_patterns_match_everything() {
        assert!(FilePatternFilter::new(&FileQuery::default())
            .unwrap()
            .matches(&candidate("any/file.ts")));
        assert!(filter("*", false).matches(&candidate("any/file.ts")));
    }

    #[test]
    fn fuzzy_pattern_matches_out_of_order_characters_but_not_absent_ones() {
        let f = filter("srcuri", false);
        assert!(f.matches(&candidate("src/vs/base/common/uri.ts")));
        assert!(!f.matches(&candidate("src/vs/base/common/event.ts")));
    }

    /// The relative path a candidate carries is spelled with the *native*
    /// separator, so a query typed with either one has to reach it.
    #[test]
    fn fuzzy_pattern_spans_path_segments_whichever_separator_is_typed() {
        let native = std::path::MAIN_SEPARATOR_STR;
        let target = candidate(&format!("mahajong{native}LICENSE"));

        for typed in ["maha/lic", "maha\\lic", "mahajong/LICENSE"] {
            assert!(filter(typed, false).matches(&target), "{typed}");
        }
        assert!(!filter("maha/xyz", false).matches(&target));
    }

    #[test]
    fn glob_pattern_does_not_fuzzy_match() {
        let f = filter("*.ts", true);
        assert!(f.matches(&candidate("uri.ts")));
        assert!(!f.matches(&candidate("uri.tsx")));
    }

    /// Stock reaches an out-of-workspace open editor only through this loop, and
    /// still applies the query's global excludes to it.
    #[test]
    fn extra_files_are_matched_against_the_pattern_and_the_global_excludes() {
        let query = FileQuery {
            common: CommonQuery {
                extra_file_resources: vec!["/out/notes.md".into(), "/out/skipme.md".into()],
                exclude_pattern: vec!["**/skipme.md".into()],
                ..Default::default()
            },
            file_pattern: Some("notes".into()),
            ..Default::default()
        };

        let (tx, rx) = std::sync::mpsc::channel();
        let filter = FilePatternFilter::new(&query).unwrap();
        match_extra_files(&query, &filter, &Counters::default(), &tx).unwrap();
        drop(tx);

        let paths: Vec<String> = rx.into_iter().map(|m| m.path).collect();
        assert_eq!(paths, ["/out/notes.md"]);
    }

    #[test]
    fn search_path_prefixes_the_folder_name() {
        let folder = FolderQuery {
            folder: "/root".into(),
            folder_name: Some("proj".into()),
            exclude_pattern: Vec::new(),
            include_pattern: Vec::new(),
            ignore_glob_case: false,
            disregard_ignore_files: false,
            disregard_global_ignore_files: false,
            disregard_parent_ignore_files: false,
            ignore_symlinks: false,
        };
        let path = search_path(&folder, "a/b.ts").unwrap();
        assert!(path.starts_with("proj"), "{path}");
        assert!(path.ends_with("a/b.ts"), "{path}");
        assert!(search_path(&FolderQuery { folder_name: None, ..folder }, "a/b.ts").is_none());
    }
}
