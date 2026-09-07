//! The crate's only point of contact with `tscode_fs`'s path validation, so a
//! change to that API lands in one place.
//!
//! Search must not walk outside the open workspace roots — spec's Security
//! item 3. Every folder a walk starts from is validated before its walker is
//! built.

use std::path::{Path, PathBuf};

use tscode_fs::{ValidatedPath, WorkspaceRoots};

use crate::error::SearchError;

/// Validates every folder a query names, in query order.
///
/// Validation reads the filesystem to resolve symlinks, so it is async and runs before
/// the search enters `spawn_blocking` — the walk itself never validates.
pub async fn validate_roots(
    roots: &WorkspaceRoots,
    folders: &[&Path],
) -> Result<Vec<PathBuf>, SearchError> {
    let mut validated = Vec::with_capacity(folders.len());

    for folder in folders {
        let root = roots
            .validate(folder)
            .await
            .map(ValidatedPath::into_path_buf)
            .map_err(|e| SearchError::Other(format!("{e}")))?;
        validated.push(root);
    }

    Ok(validated)
}
