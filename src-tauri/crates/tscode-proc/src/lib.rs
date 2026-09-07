//! Child-process spawn settings shared by the crates that shell out.
//!
//! Everything here is a no-op off the platform it is about, so a call site carries no
//! `cfg` of its own.

use std::fmt;
use std::process::Stdio;

use tokio::io::AsyncWriteExt;

/// `CREATE_NO_WINDOW`, the process creation flag that keeps a console subsystem child
/// from allocating a console of its own.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Keep `command` from flashing a console window on Windows.
///
/// Every console program the backend runs is run for its output, never for a user to
/// look at. This is the `windowsHide: true` upstream passes to its own `child_process`
/// calls.
pub fn hide_console(command: &mut tokio::process::Command) -> &mut tokio::process::Command {
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

/// A child process that ran and exited non-zero.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandFailure {
    pub program: String,
    pub argv: Vec<String>,
    pub code: i32,
    pub stderr: String,
    /// Kept because a command can report a recoverable condition on stdout rather than
    /// stderr — `git`'s `needs merge` is one.
    pub stdout: String,
}

impl fmt::Display for CommandFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let Self { program, argv, code, stderr, .. } = self;
        write!(f, "{program} {argv:?} exited with code {code}: {stderr}")
    }
}

impl std::error::Error for CommandFailure {}

/// The two ways running a child can go wrong: it never started, or it started and
/// refused. Callers map both into their own error type.
#[derive(Debug)]
pub enum RunError {
    Spawn(std::io::Error),
    Failed(CommandFailure),
}

/// One child process the backend is about to run.
///
/// The plumbing is the same wherever the backend shells out — an argv array and never a
/// shell string, a hidden console, piped stdio, the stdin pipe shut before the wait so
/// the child is not left reading a pipe nobody will close, and a non-zero exit carrying
/// the argv that produced it. What differs between `git`'s recipe and `sl`'s is the
/// working directory and the environment, which callers set through [`Run::command`].
pub struct Run {
    command: tokio::process::Command,
    program: String,
    argv: Vec<String>,
}

impl Run {
    pub fn new(program: &str, argv: Vec<String>) -> Self {
        let mut command = tokio::process::Command::new(program);
        command.args(&argv);
        Self { command, program: program.to_owned(), argv }
    }

    /// The command, for the cwd and environment the caller's recipe adds.
    pub fn command(&mut self) -> &mut tokio::process::Command {
        &mut self.command
    }

    /// Run to completion, writing `stdin` first when there is any, and return stdout.
    pub async fn output(mut self, stdin: Option<&[u8]>) -> Result<Vec<u8>, RunError> {
        self.command
            .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_console(&mut self.command);

        let output = self.spawn_and_wait(stdin).await.map_err(RunError::Spawn)?;
        if output.status.success() {
            return Ok(output.stdout);
        }

        Err(RunError::Failed(CommandFailure {
            program: self.program,
            argv: self.argv,
            code: output.status.code().unwrap_or(-1),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            stdout: String::from_utf8_lossy(&output.stdout).trim().to_owned(),
        }))
    }

    async fn spawn_and_wait(
        &mut self,
        stdin: Option<&[u8]>,
    ) -> std::io::Result<std::process::Output> {
        let mut child = self.command.spawn()?;

        if let Some(bytes) = stdin {
            let mut pipe = child
                .stdin
                .take()
                .ok_or_else(|| std::io::Error::other("child stdin was not piped"))?;
            pipe.write_all(bytes).await?;
            pipe.shutdown().await?;
        }

        child.wait_with_output().await
    }
}
