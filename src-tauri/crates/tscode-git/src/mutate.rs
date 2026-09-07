//! Mutations: stage, unstage, discard, commit.
//!
//! These are the only operations that shell out, and they do it exactly as VS Code's git
//! extension does — same subcommands, same flags, same recoverable-error handling — so the
//! behaviour in edge cases (unborn branch, unresolved merge, missing path) matches upstream.
//! Argv construction lives in [`crate::cmd`], which never builds a shell string.
//!
//! Note that `git commit` runs the repository's hooks. That is inherent to mutating with
//! `git` and is what upstream does; [`CommitOptions::no_verify`] is the opt-out.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::cmd;
use crate::error::{GitError, Result};

/// Port of `CommitOptions` in `extensions/git/src/git.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CommitOptions {
    /// Stage every tracked modification first (`git commit --all`).
    pub all: bool,
    pub amend: bool,
    pub signoff: bool,
    /// `Some(true)` forces `-S`, `Some(false)` forces `--no-gpg-sign`, `None` leaves it to config.
    pub sign_commit: Option<bool>,
    /// Allow a commit with no staged changes.
    pub empty: bool,
    /// Skip the repository's pre-commit and commit-msg hooks.
    pub no_verify: bool,
    /// Stop git guessing a user identity from the hostname.
    pub require_user_config: bool,
}

impl Default for CommitOptions {
    fn default() -> Self {
        Self {
            all: false,
            amend: false,
            signoff: false,
            sign_commit: None,
            empty: false,
            no_verify: false,
            require_user_config: true,
        }
    }
}

/// `git add -A -- <paths>`. Port of `Git.add`.
pub(crate) async fn stage(root: &Path, paths: &[String]) -> Result<()> {
    cmd::run_with_paths(root, &["add", "-A"], paths).await
}

/// Port of `Git.revert('HEAD', paths)`.
///
/// `unborn` replaces upstream's `git branch` probe for "are there any branches yet" — that
/// question is answered by reading HEAD, and reads go through `gix`.
pub(crate) async fn unstage(root: &Path, paths: &[String], unborn: bool) -> Result<()> {
    let args: &[&str] = if unborn {
        &["rm", "--cached", "-r"]
    } else {
        &["reset", "-q", "HEAD"]
    };

    match cmd::run_with_paths(root, args, paths).await {
        // An unresolved merge makes `git reset` report "needs merge" and exit non-zero,
        // having done the work anyway.
        Err(GitError::Command(ref failure)) if failure.stdout.contains(": needs merge") => Ok(()),
        other => other,
    }
}

/// Port of `Repository.clean`: tracked resources are restored from the index, untracked
/// ones are deleted. Which is which is decided by the caller from the `gix` index.
pub(crate) async fn discard(root: &Path, tracked: &[String], untracked: &[String]) -> Result<()> {
    if !tracked.is_empty() {
        match cmd::run_with_paths(root, &["checkout", "-q"], tracked).await {
            Err(GitError::Command(ref failure))
                if failure.stderr.contains("did not match any file(s) known to git") => {}
            other => other?,
        }
    }
    if !untracked.is_empty() {
        cmd::run_with_paths(root, &["clean", "-f", "-q"], untracked).await?;
    }
    Ok(())
}

/// Port of `Git.commit`. The message goes over stdin (`--file -`) so it can be any length
/// and any encoding without touching the command line.
pub(crate) async fn commit(root: &Path, message: &str, opts: &CommitOptions) -> Result<()> {
    let mut args: Vec<&str> = Vec::new();
    if opts.require_user_config {
        args.extend_from_slice(&["-c", "user.useConfigOnly=true"]);
    }
    args.extend_from_slice(&["commit", "--quiet", "--allow-empty-message", "--file", "-"]);

    if opts.all {
        args.push("--all");
    }
    if opts.amend {
        args.push("--amend");
    }
    if opts.signoff {
        args.push("--signoff");
    }
    match opts.sign_commit {
        Some(true) => args.push("-S"),
        Some(false) => args.push("--no-gpg-sign"),
        None => {}
    }
    if opts.empty {
        args.push("--allow-empty");
    }
    if opts.no_verify {
        args.push("--no-verify");
    }

    cmd::run(root, &args, Some(message.as_bytes())).await?;
    Ok(())
}

/// Split repository-relative paths into (tracked, untracked) by index membership.
///
/// One index read for the whole batch — a per-path lookup would re-read the index N times.
pub(crate) fn partition_tracked(
    repo: &gix::Repository,
    paths: &[String],
) -> Result<(Vec<String>, Vec<String>)> {
    let index = repo
        .index_or_empty()
        .map_err(GitError::gix("read index"))?;

    let mut tracked = Vec::new();
    let mut untracked = Vec::new();
    for path in paths {
        if index.entry_by_path(path.as_str().into()).is_some() {
            tracked.push(path.clone());
        } else {
            untracked.push(path.clone());
        }
    }
    Ok((tracked, untracked))
}
