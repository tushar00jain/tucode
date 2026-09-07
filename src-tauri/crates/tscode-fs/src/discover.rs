//! Finding repository roots below a directory.
//!
//! `tscode-git` and `tscode-sl` run the same walk and differ only in the marker
//! directories they look for — `.git` for one, `.sl` or `.git/sl` for the other — so the
//! walk lives here and each names its markers.

use std::path::{Path, PathBuf};

/// Every directory at or below `dir`, up to `max_depth` levels down, that contains any of
/// `markers`, in path order.
///
/// **A marker is a relative path, not a name, and one caller needs more than one of
/// them.** Sapling stores its metadata at `.sl` in a repository it created itself and at
/// `.git/sl` in a git repository it is driving — the mode `sl` uses inside an existing
/// git checkout — and both are the same kind of repository to the view.
///
/// A directory carrying a marker is not descended into: a nested repository is a
/// submodule, which the SCM view opens explicitly rather than by discovery.
///
/// Only a failure to read `dir` itself is an error. A directory deeper in the tree that
/// cannot be read is skipped, because one unreadable subdirectory must not cost the
/// caller every repository below it.
///
/// Blocking: walks the filesystem. Callers validate `dir` against the workspace roots
/// first and run this inside `spawn_blocking`.
pub fn find_marked_dirs(
    dir: &Path,
    markers: &[&str],
    max_depth: usize,
) -> std::io::Result<Vec<PathBuf>> {
    let mut found = Vec::new();
    let mut frontier = vec![(dir.to_path_buf(), 0usize)];

    while let Some((current, depth)) = frontier.pop() {
        if markers.iter().any(|marker| current.join(marker).exists()) {
            found.push(current);
            continue;
        }
        if depth >= max_depth {
            continue;
        }
        let entries = match std::fs::read_dir(&current) {
            Ok(entries) => entries,
            Err(error) => {
                if current == dir {
                    return Err(error);
                }
                continue;
            }
        };
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                frontier.push((entry.path(), depth + 1));
            }
        }
    }

    found.sort();
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marked_directories_are_found_and_not_descended_into() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path();
        for path in ["a/.sl", "a/nested/.sl", "b/c/.sl", "d"] {
            std::fs::create_dir_all(root.join(path)).expect("fixture");
        }

        assert_eq!(
            find_marked_dirs(root, &[".sl"], 3).unwrap(),
            vec![root.join("a"), root.join("b").join("c")]
        );
    }

    /// Sapling's two layouts, side by side: a repository it created carries `.sl`, one it
    /// drives inside a git checkout carries `.git/sl`, and a git repository `sl` has never
    /// touched carries neither and is walked past.
    #[test]
    fn any_of_several_markers_matches() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path();
        for path in ["own/.sl", "driven/.git/sl", "plain-git/.git", "plain-git/inner"] {
            std::fs::create_dir_all(root.join(path)).expect("fixture");
        }

        assert_eq!(
            find_marked_dirs(root, &[".sl", ".git/sl"], 3).unwrap(),
            vec![root.join("driven"), root.join("own")]
        );
    }

    #[test]
    fn max_depth_bounds_the_walk() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path();
        std::fs::create_dir_all(root.join("a/b/.sl")).expect("fixture");

        assert!(find_marked_dirs(root, &[".sl"], 1).unwrap().is_empty());
        assert_eq!(
            find_marked_dirs(root, &[".sl"], 2).unwrap(),
            vec![root.join("a").join("b")]
        );
    }

    #[test]
    fn an_unreadable_start_directory_is_an_error() {
        let temp = tempfile::tempdir().expect("temp dir");
        assert!(find_marked_dirs(&temp.path().join("missing"), &[".sl"], 2).is_err());
    }
}
