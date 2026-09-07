//! Error type for the Sapling crate.

use std::path::PathBuf;

pub type Result<T> = std::result::Result<T, SlError>;

/// Anything that can go wrong while inspecting a Sapling repository.
#[derive(Debug, thiserror::Error)]
pub enum SlError {
    /// The caller asked about a path that is not inside any registered workspace root.
    #[error("path is outside the open workspace roots: {0}")]
    PathOutsideWorkspace(PathBuf),

    /// `sl root` refused the path — nothing at or above it is a Sapling repository.
    #[error("{0} is not inside a Sapling repository")]
    NotARepository(PathBuf),

    /// A revision reached the crate that is not a hash. `--rev` takes a whole revset
    /// language, so only a plain hash is accepted from the wire.
    #[error("not a commit hash: {0}")]
    InvalidRevision(String),

    /// `sl` ran and exited non-zero.
    #[error(transparent)]
    Command(tscode_proc::CommandFailure),

    #[error("failed to run sl: {0}")]
    Spawn(#[source] std::io::Error),

    #[error("i/o error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("the blocking task panicked")]
    TaskPanicked,
}

impl SlError {
    /// What a repository that could not be read says *in the view*.
    ///
    /// **`sl`'s own words, not the command that produced them.** A [`SlError::Command`]
    /// displays as the whole invocation — the smartlog template alone is four hundred
    /// characters of escaped `{node}\n{desc|firstline}` — and it is drawn in a sidebar pane
    /// where it buries the one line that tells the user anything: `abort: cannot initialize
    /// working copy`. The argv belongs in a log, and the error itself still carries it.
    ///
    /// Falls back to the whole thing when `sl` failed without saying why, so an empty pane
    /// is never the answer.
    pub fn user_message(&self) -> String {
        match self {
            SlError::Command(failure) => match failure.stderr.trim() {
                "" => self.to_string(),
                stderr => stderr.to_owned(),
            },
            other => other.to_string(),
        }
    }
}

impl From<tscode_proc::RunError> for SlError {
    fn from(error: tscode_proc::RunError) -> Self {
        match error {
            tscode_proc::RunError::Spawn(source) => SlError::Spawn(source),
            tscode_proc::RunError::Failed(failure) => SlError::Command(failure),
        }
    }
}

impl From<tokio::task::JoinError> for SlError {
    fn from(_: tokio::task::JoinError) -> Self {
        SlError::TaskPanicked
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The failure that produced this: a checkout `sl` refuses to open reached the pane as the
    /// whole `sl log` invocation, template included, with the `abort:` line at the very end.
    #[test]
    fn a_failed_command_reports_what_sl_said_and_not_what_it_was_asked() {
        let error = SlError::Command(tscode_proc::CommandFailure {
            program: "sl".to_owned(),
            argv: vec!["log".to_owned(), "--template".to_owned(), "{node}\\n{desc}".to_owned()],
            code: 255,
            stderr: "warning: failed to inspect working copy parent\nabort: cannot initialize working copy\n".to_owned(),
            stdout: String::new(),
        });

        assert_eq!(
            error.user_message(),
            "warning: failed to inspect working copy parent\nabort: cannot initialize working copy"
        );
    }

    /// A command that failed silently still has to say something, so the whole invocation is
    /// the fallback rather than an empty pane.
    #[test]
    fn a_silent_failure_falls_back_to_the_whole_invocation() {
        let error = SlError::Command(tscode_proc::CommandFailure {
            program: "sl".to_owned(),
            argv: vec!["log".to_owned()],
            code: 1,
            stderr: "   \n".to_owned(),
            stdout: String::new(),
        });

        assert!(error.user_message().contains("exited with code 1"));
    }
}
