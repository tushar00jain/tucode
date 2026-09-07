//! Path comparison, with the platform's case sensitivity applied once.
//!
//! Stock spreads this across `extUriBiasedIgnorePathCase` (resource maps),
//! `isEqual` / `isParent` in `vs/base/common/extpath.ts` (move/copy validation)
//! and `EventCoalescer.toKey` (watcher). All three fold case exactly when the
//! provider does not declare `PathCaseSensitive`, so they share one key here.

use std::path::{Path, MAIN_SEPARATOR};

use crate::types::is_path_case_sensitive;

/// The string two paths are compared by: separators normalised, and case folded
/// unless the platform's filesystem is case sensitive.
#[must_use]
pub fn comparison_key(path: &Path) -> String {
    let text = path
        .to_string_lossy()
        .replace('/', &MAIN_SEPARATOR.to_string());

    if is_path_case_sensitive() {
        text
    } else {
        text.to_lowercase()
    }
}

/// Port of `isEqual`.
#[must_use]
pub fn paths_equal(a: &Path, b: &Path) -> bool {
    comparison_key(a) == comparison_key(b)
}

/// Port of `isParent`: true when `path` lies strictly beneath `candidate`.
#[must_use]
pub fn is_parent(path: &Path, candidate: &Path) -> bool {
    let (path, candidate) = (comparison_key(path), comparison_key(candidate));
    let candidate = candidate.trim_end_matches(MAIN_SEPARATOR);

    if candidate.is_empty() || candidate.len() >= path.len() {
        return false;
    }

    path.starts_with(&format!("{candidate}{MAIN_SEPARATOR}"))
}

/// True when `path` is `root` itself or lies beneath it.
#[must_use]
pub fn is_within(path: &Path, root: &Path) -> bool {
    paths_equal(path, root) || is_parent(path, root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn p(segments: &[&str]) -> PathBuf {
        segments.iter().collect()
    }

    #[test]
    fn is_parent_requires_a_separator_boundary() {
        let root = p(&["tmp", "project"]);
        assert!(is_parent(&p(&["tmp", "project", "src"]), &root));
        assert!(!is_parent(&p(&["tmp", "project-secrets"]), &root));
        assert!(!is_parent(&root, &root), "equality is not parenthood");
    }

    #[test]
    fn is_within_admits_the_root_itself() {
        let root = p(&["tmp", "project"]);
        assert!(is_within(&root, &root));
        assert!(is_within(&p(&["tmp", "project", "a", "b"]), &root));
        assert!(!is_within(&p(&["tmp", "other"]), &root));
    }

    #[test]
    fn case_folding_follows_the_platform() {
        let a = p(&["tmp", "Project"]);
        let b = p(&["tmp", "project"]);
        assert_eq!(paths_equal(&a, &b), !is_path_case_sensitive());
    }
}
