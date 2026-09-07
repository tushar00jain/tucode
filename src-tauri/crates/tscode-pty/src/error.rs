//! Error type for the pty crate.
//!
//! Stock splits terminal failures in two: a *launch* failure is data
//! (`ITerminalLaunchError`, returned from `start()` so the frontend can render
//! it inside the terminal), and everything else throws. [`PtyError::Launch`]
//! keeps that distinction — the channel turns it back into the
//! `{ error: { message, code? } }` half of `start`'s return value.

pub type Result<T> = std::result::Result<T, PtyError>;

/// Anything that can go wrong driving a terminal process.
#[derive(Debug, thiserror::Error)]
pub enum PtyError {
    /// The frontend named a pty id that was never created, or has already
    /// exited and been swept.
    #[error("no terminal process with id {0}")]
    NoSuchProcess(u32),

    /// Stock `ITerminalLaunchError`. Not a thrown error upstream — `start()`
    /// resolves with it.
    #[error("{message}")]
    Launch { message: String, code: Option<i32> },

    /// A `portable-pty` call failed. Its errors are `anyhow::Error`, so they are
    /// boxed behind a short description of what was being attempted.
    #[error("{context}: {source}")]
    Pty {
        context: &'static str,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },

    #[error("the blocking task panicked")]
    TaskPanicked,
}

impl PtyError {
    /// Adapt any `portable-pty` error into [`PtyError::Pty`], labelled with what
    /// was attempted.
    pub(crate) fn pty(context: &'static str) -> impl FnOnce(anyhow::Error) -> Self {
        move |source| Self::Pty {
            context,
            source: source.into(),
        }
    }

    /// Stock's launch failures carry no code; `ITerminalLaunchError.code` is
    /// optional and only the extension-host proxy ever sets it.
    pub fn launch(message: impl Into<String>) -> Self {
        Self::Launch {
            message: message.into(),
            code: None,
        }
    }
}

impl From<tokio::task::JoinError> for PtyError {
    fn from(_: tokio::task::JoinError) -> Self {
        Self::TaskPanicked
    }
}
