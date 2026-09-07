//! Workspace root registry and path validation — spec Security item 3.
//!
//! Our `#[tauri::command]` entry points are not gated by Tauri's capability
//! system, so this is the only thing standing between a compromised webview and
//! the whole filesystem. Every public entry point in this crate therefore takes
//! a [`ValidatedPath`], which can only be produced by [`WorkspaceRoots::validate`].

use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, RwLock};

use crate::blocking::run as blocking;
use crate::error::{FsError, FsResult};
use crate::paths::{is_within, paths_equal};

/// A path that has been checked to live inside a registered workspace root.
///
/// Construction is private to this module, so a `&ValidatedPath` parameter is a
/// compile-time proof that the check ran.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ValidatedPath(PathBuf);

impl ValidatedPath {
    #[must_use]
    pub fn as_path(&self) -> &Path {
        &self.0
    }

    #[must_use]
    pub fn into_path_buf(self) -> PathBuf {
        self.0
    }

    /// The path of a same-folder sibling with `postfix` appended to the file
    /// name — the temporary resource an atomic write or delete uses. The result
    /// is unvalidated on purpose: the caller must run it back through
    /// [`WorkspaceRoots::validate`], because a single-file root has siblings
    /// outside it.
    #[must_use]
    pub fn sibling_path(&self, postfix: &str) -> PathBuf {
        match self.0.file_name() {
            Some(name) => {
                let mut sibling = name.to_os_string();
                sibling.push(postfix);
                self.0.with_file_name(sibling)
            }
            None => self.0.clone(),
        }
    }
}

impl AsRef<Path> for ValidatedPath {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl std::ops::Deref for ValidatedPath {
    type Target = Path;

    fn deref(&self) -> &Path {
        &self.0
    }
}

impl std::fmt::Display for ValidatedPath {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0.display())
    }
}

/// The set of folders the webview is allowed to reach. Cheap to clone; every
/// clone shares one registry.
#[derive(Debug, Clone, Default)]
pub struct WorkspaceRoots {
    roots: Arc<RwLock<Vec<PathBuf>>>,
}

impl WorkspaceRoots {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers `path` as a workspace root. The stored root is canonical, so
    /// later validation compares like with like.
    pub async fn add_root(&self, path: impl AsRef<Path>) -> FsResult<PathBuf> {
        let path = path.as_ref().to_path_buf();
        let canonical = canonicalize(path).await?;

        let mut roots = self.write();
        if !roots.iter().any(|root| root == &canonical) {
            roots.push(canonical.clone());
        }

        Ok(canonical)
    }

    /// Removes a previously registered root. Paths under it stop validating
    /// immediately; watchers already running are the caller's to dispose.
    pub fn remove_root(&self, path: impl AsRef<Path>) {
        let path = path.as_ref();
        self.write()
            .retain(|root| !paths_equal(root, path) && !paths_equal(root, &lexical_normalize(path)));
    }

    #[must_use]
    pub fn roots(&self) -> Vec<PathBuf> {
        self.read().clone()
    }

    /// Validates `path` against the registered roots.
    ///
    /// Three stages, each closing a different escape:
    /// 1. reject empty paths, NUL bytes and relative paths outright;
    /// 2. resolve `.` / `..` lexically, so a traversal cannot be smuggled past
    ///    the prefix check;
    /// 3. canonicalize the deepest *existing* ancestor and re-check, so a
    ///    symlink planted inside a root cannot point out of it.
    ///
    /// Stage 3 is a check against the filesystem as it is at validation time; a
    /// symlink swapped in between here and the syscall would defeat it. Closing
    /// that needs `openat2(RESOLVE_BENEATH)`, which has no portable equivalent.
    pub async fn validate(&self, path: impl AsRef<Path>) -> FsResult<ValidatedPath> {
        let path = path.as_ref();

        if path.as_os_str().is_empty() {
            return Err(FsError::no_permissions("path must not be empty"));
        }
        if path.to_string_lossy().contains('\0') {
            return Err(FsError::no_permissions("path must not contain NUL bytes"));
        }
        if !path.is_absolute() {
            return Err(FsError::no_permissions(format!(
                "path must be absolute: {}",
                path.display()
            )));
        }

        let normalized = lexical_normalize(path);
        let roots = self.roots();
        if roots.is_empty() {
            return Err(FsError::no_permissions(
                "no workspace root is open; all paths are denied",
            ));
        }

        self.assert_within(&normalized, &roots)?;

        let resolved = resolve_existing_prefix(normalized.clone()).await?;
        self.assert_within(&resolved, &roots)?;

        Ok(ValidatedPath(normalized))
    }

    /// Validates both ends of a move / copy / clone in one call, so a call site
    /// cannot validate one and forget the other.
    pub async fn validate_pair(
        &self,
        from: impl AsRef<Path>,
        to: impl AsRef<Path>,
    ) -> FsResult<(ValidatedPath, ValidatedPath)> {
        Ok((self.validate(from).await?, self.validate(to).await?))
    }

    fn assert_within(&self, path: &Path, roots: &[PathBuf]) -> FsResult<()> {
        if roots.iter().any(|root| is_within(path, root)) {
            return Ok(());
        }

        Err(FsError::no_permissions(format!(
            "{} is outside the open workspace",
            path.display()
        )))
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, Vec<PathBuf>> {
        self.roots
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, Vec<PathBuf>> {
        self.roots
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Canonicalizes without the `\\?\` verbatim prefix Windows would otherwise
/// add, so stored roots and validated paths are textually comparable.
async fn canonicalize(path: PathBuf) -> FsResult<PathBuf> {
    blocking(move || dunce::canonicalize(&path).map_err(|error| FsError::from_io(&path, &error)))
        .await
}

/// Canonicalizes the longest existing prefix of `path` and re-appends the tail
/// that does not exist yet — the equivalent of `realpath -m`.
async fn resolve_existing_prefix(path: PathBuf) -> FsResult<PathBuf> {
    blocking(move || {
        let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
        let mut cursor: &Path = &path;

        loop {
            if let Ok(resolved) = dunce::canonicalize(cursor) {
                let mut result = resolved;
                for segment in tail.iter().rev() {
                    result.push(segment);
                }
                return Ok(result);
            }

            match (cursor.file_name(), cursor.parent()) {
                (Some(name), Some(parent)) => {
                    tail.push(name);
                    cursor = parent;
                }
                // Nothing on this path exists — nothing can be hiding a
                // symlink, so the lexical form is already the answer.
                _ => return Ok(path.clone()),
            }
        }
    })
    .await
}

/// Resolves `.` and `..` textually, without touching the filesystem — the
/// target of a create or a write need not exist yet.
fn lexical_normalize(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();

    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            other => result.push(other.as_os_str()),
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    async fn roots_on(dir: &Path) -> WorkspaceRoots {
        let roots = WorkspaceRoots::new();
        roots.add_root(dir).await.unwrap();
        roots
    }

    #[test]
    fn lexical_normalize_resolves_traversal() {
        let normalized = lexical_normalize(Path::new("/a/b/../c/./d"));
        assert_eq!(normalized, PathBuf::from("/a/c/d"));
    }

    #[tokio::test]
    async fn empty_registry_denies_everything() {
        let roots = WorkspaceRoots::new();
        let tmp = TempDir::new().unwrap();
        assert!(roots.validate(tmp.path()).await.is_err());
    }

    #[tokio::test]
    async fn accepts_the_root_itself_and_children() {
        let tmp = TempDir::new().unwrap();
        let roots = roots_on(tmp.path()).await;

        assert!(roots.validate(tmp.path()).await.is_ok());
        assert!(roots.validate(tmp.path().join("a/b.txt")).await.is_ok());
    }

    #[tokio::test]
    async fn accepts_a_target_that_does_not_exist_yet() {
        let tmp = TempDir::new().unwrap();
        let roots = roots_on(tmp.path()).await;

        assert!(roots.validate(tmp.path().join("new/deep/file.txt")).await.is_ok());
    }

    #[tokio::test]
    async fn rejects_traversal_out_of_the_root() {
        let tmp = TempDir::new().unwrap();
        let roots = roots_on(tmp.path()).await;

        assert!(roots.validate(tmp.path().join("../escaped")).await.is_err());
        assert!(roots.validate(tmp.path().join("a/../../escaped")).await.is_err());
    }

    #[tokio::test]
    async fn rejects_a_sibling_with_the_root_as_a_name_prefix() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("project");
        let sibling = tmp.path().join("project-secrets");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&sibling).unwrap();

        let roots = roots_on(&root).await;
        assert!(roots.validate(sibling.join("key.txt")).await.is_err());
    }

    #[tokio::test]
    async fn rejects_relative_and_empty_paths() {
        let tmp = TempDir::new().unwrap();
        let roots = roots_on(tmp.path()).await;

        assert!(roots.validate("relative/path").await.is_err());
        assert!(roots.validate("").await.is_err());
    }

    #[tokio::test]
    async fn removing_a_root_revokes_access() {
        let tmp = TempDir::new().unwrap();
        let roots = roots_on(tmp.path()).await;
        let canonical = dunce::canonicalize(tmp.path()).unwrap();

        roots.remove_root(&canonical);
        assert!(roots.validate(tmp.path().join("a.txt")).await.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_a_symlink_pointing_out_of_the_root() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("project");
        let outside = tmp.path().join("outside");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "s").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();

        let roots = roots_on(&root).await;
        assert!(roots.validate(root.join("link/secret.txt")).await.is_err());
    }
}
