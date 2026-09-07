//! End-to-end cover for both searches over a real tree, driven by the JSON the
//! `search` channel hands the crate. The unit tests exercise the filters and the
//! range arithmetic in isolation; these run the walk.

use std::sync::mpsc;
use std::sync::Arc;

use serde_json::{json, Value};
use tempfile::TempDir;
use tscode_fs::WorkspaceRoots;
use tscode_search::{file_search, text_search, CancellationToken, SearchProgress};

/// A fixture with a file at the root and one a level down, both matching.
async fn workspace() -> (TempDir, Arc<WorkspaceRoots>) {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("root.txt"), "alpha needle omega\n").unwrap();
    std::fs::create_dir(tmp.path().join("sub")).unwrap();
    std::fs::write(tmp.path().join("sub/nested.ts"), "one\ntwo needle\n").unwrap();

    let roots = WorkspaceRoots::new();
    roots.add_root(tmp.path()).await.unwrap();
    (tmp, Arc::new(roots))
}

/// Runs one query to completion and returns the paths it matched, sorted.
async fn matched_paths(roots: Arc<WorkspaceRoots>, query: Value, by_name: bool) -> Vec<String> {
    let (tx, rx) = mpsc::channel();
    let collect = move |progress: SearchProgress| {
        if let SearchProgress::FileMatches(matches) = progress {
            for one in matches {
                let _ = tx.send(one);
            }
        }
    };

    let token = CancellationToken::new();
    if by_name {
        file_search(serde_json::from_value(query).unwrap(), roots, token, collect).await.unwrap();
    } else {
        text_search(serde_json::from_value(query).unwrap(), roots, token, collect).await.unwrap();
    }

    let mut paths: Vec<String> = rx.into_iter().map(|m| m.path).collect();
    paths.sort();
    paths
}

#[tokio::test]
async fn text_search_finds_a_match_at_the_root_and_below() {
    let (tmp, roots) = workspace().await;
    let paths = matched_paths(
        roots,
        json!({
            "query": { "pattern": "needle" },
            "options": {
                "folderOptions": [{ "folder": tmp.path() }],
                "maxResults": 20000,
            },
        }),
        false,
    )
    .await;

    assert_eq!(paths.len(), 2, "{paths:?}");
    assert!(paths[0].ends_with("root.txt"), "{paths:?}");
    assert!(paths[1].ends_with("nested.ts"), "{paths:?}");
}

#[tokio::test]
async fn file_search_finds_a_file_at_the_workspace_root() {
    let (tmp, roots) = workspace().await;
    let paths = matched_paths(
        roots,
        json!({
            "type": 1,
            "filePattern": "root",
            "folderQueries": [{ "folder": tmp.path() }],
            "maxResults": 20000,
        }),
        true,
    )
    .await;

    assert_eq!(paths.len(), 1, "{paths:?}");
    assert!(paths[0].ends_with("root.txt"), "{paths:?}");
}

/// Quick access populates its cache with `maxResults: 0`, which stock reads as
/// "no limit" — a cap of zero would leave Ctrl+P with nothing to filter.
#[tokio::test]
async fn max_results_zero_returns_every_file() {
    let (tmp, roots) = workspace().await;
    let paths = matched_paths(
        roots,
        json!({
            "type": 1,
            "filePattern": "",
            "folderQueries": [{ "folder": tmp.path() }],
            "maxResults": 0,
        }),
        true,
    )
    .await;

    assert_eq!(paths.len(), 2, "{paths:?}");
}
