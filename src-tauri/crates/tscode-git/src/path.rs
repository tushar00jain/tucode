//! Path validation and repository-relative path conversion.
//!
//! Every public entry point funnels its paths through [`validate`] first. `WorkspaceRoots`
//! comes from `tscode_fs` (T3) rather than being re-implemented here — one source of truth
//! for "is this path inside something the user opened".

use std::path::{Path, PathBuf};

use tscode_fs::{ValidatedPath, WorkspaceRoots};

use crate::error::{GitError, Result};

/// Reject a path that is not inside a registered workspace root, and return its
/// canonical form. Spec's Security item 3: our `#[tauri::command]`s are not gated by
/// Tauri's capability system, so this is the only place the check happens.
///
/// Async because the symlink-escape check reads the filesystem; callers validate before
/// entering `spawn_blocking`, never inside it.
pub(crate) async fn validate(roots: &WorkspaceRoots, path: &Path) -> Result<PathBuf> {
    roots
        .validate(path)
        .await
        .map(ValidatedPath::into_path_buf)
        .map_err(|_| GitError::PathOutsideWorkspace(path.to_path_buf()))
}

/// Express `path` relative to `root`, with forward slashes, as git wants it.
///
/// Port of `sanitizeRelativePath` in `extensions/git/src/git.ts`, which is the same
/// backslash-to-slash normalisation.
pub(crate) fn to_repo_relative(root: &Path, path: &Path) -> Result<String> {
    let relative = if path.is_absolute() {
        path.strip_prefix(root)
            .map_err(|_| GitError::PathOutsideRepository {
                root: root.to_path_buf(),
                path: path.to_path_buf(),
            })?
    } else {
        path
    };

    Ok(relative.to_string_lossy().replace('\\', "/"))
}

/// Turn a [`crate::Change`]'s repository-relative path back into an absolute one — what
/// the SCM channel needs to build a `file://` URI for a resource state.
pub fn absolute_path(root: &Path, relative: &str) -> PathBuf {
    root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `Path::is_absolute` is platform-specific — `/w/repo` is relative on Windows — and
    /// `to_repo_relative` branches on it, so the fixtures have to be native.
    fn fixture(path: &str) -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(format!("C:\\{}", path.replace('/', "\\")))
        } else {
            PathBuf::from(format!("/{path}"))
        }
    }

    #[test]
    fn repo_relative_paths_use_forward_slashes() {
        let root = fixture("w/repo");
        assert_eq!(
            to_repo_relative(&root, Path::new("src/a.rs")).unwrap(),
            "src/a.rs"
        );
        assert_eq!(
            to_repo_relative(&root, &root.join("src").join("a.rs")).unwrap(),
            "src/a.rs"
        );
    }

    #[test]
    fn an_absolute_path_outside_the_repository_is_rejected() {
        assert!(to_repo_relative(&fixture("w/repo"), &fixture("w/other/a.rs")).is_err());
    }

    #[test]
    fn absolute_path_round_trips() {
        let root = fixture("w/repo");
        let absolute = absolute_path(&root, "src/a.rs");
        assert_eq!(to_repo_relative(&root, &absolute).unwrap(), "src/a.rs");
    }
}
