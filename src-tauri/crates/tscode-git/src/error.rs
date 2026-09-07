//! Error type for the git crate.

use std::path::PathBuf;

pub type Result<T> = std::result::Result<T, GitError>;

/// Anything that can go wrong while inspecting or mutating a repository.
#[derive(Debug, thiserror::Error)]
pub enum GitError {
    /// The caller asked about a path that is not inside any registered workspace root.
    #[error("path is outside the open workspace roots: {0}")]
    PathOutsideWorkspace(PathBuf),

    /// No `.git` was found at or above the given path.
    #[error("{0} is not inside a git repository")]
    NotARepository(PathBuf),

    /// The repository has no working tree, so it has no status and nothing to stage.
    #[error("{0} is a bare repository and has no working tree")]
    BareRepository(PathBuf),

    /// The path is inside the repository but could not be expressed relative to its root.
    #[error("{path} is not inside repository {root}")]
    PathOutsideRepository { root: PathBuf, path: PathBuf },

    /// `location` names what was searched — a revision, the index. It is not a `source`
    /// field: `thiserror` reserves that name for a nested error.
    #[error("no entry for {path} in {location}")]
    NoSuchEntry { path: String, location: &'static str },

    /// `git` ran and exited non-zero. Its `stdout` is kept because git reports some
    /// recoverable conditions (`needs merge`, `did not match any file(s) known to git`)
    /// there rather than on stderr.
    #[error(transparent)]
    Command(tscode_proc::CommandFailure),

    #[error("failed to run git: {0}")]
    Spawn(#[source] std::io::Error),

    #[error("i/o error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    /// A `gix` call failed. `gix` has one error type per operation, so they are boxed
    /// behind a short description of what was being attempted.
    #[error("{context}: {source}")]
    Gix {
        context: &'static str,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },

    #[error("the blocking task panicked")]
    TaskPanicked,
}

impl GitError {
    /// Adapt any `gix` error into [`GitError::Gix`], labelled with what was attempted.
    pub(crate) fn gix<E>(context: &'static str) -> impl FnOnce(E) -> GitError
    where
        E: std::error::Error + Send + Sync + 'static,
    {
        move |source| GitError::Gix {
            context,
            source: Box::new(source),
        }
    }
}

impl From<tscode_proc::RunError> for GitError {
    fn from(error: tscode_proc::RunError) -> Self {
        match error {
            tscode_proc::RunError::Spawn(source) => GitError::Spawn(source),
            tscode_proc::RunError::Failed(failure) => GitError::Command(failure),
        }
    }
}

impl From<tokio::task::JoinError> for GitError {
    fn from(_: tokio::task::JoinError) -> Self {
        GitError::TaskPanicked
    }
}
