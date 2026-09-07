//! Running `git` for mutations.
//!
//! Spec's Security item 2: **argv arrays only, never a shell string.** Paths and branch
//! names are attacker-controlled, and there is no shell in this path to interpret them.
//! Every call site also puts `--` before its path list, so a path beginning with `-`
//! cannot be read as an option.
//!
//! Reads never come through here — see [`crate::status`] and [`crate::diff`].

use std::path::Path;

use tscode_proc::Run;

use crate::error::Result;

/// Longest argv tail we build before splitting into another invocation.
/// Port of `MAX_CLI_LENGTH` in `extensions/git/src/git.ts`.
const MAX_CLI_LENGTH: usize = 30_000;

/// Run `git` in `root` with `args`, optionally writing `stdin` to it, and return stdout.
pub(crate) async fn run(root: &Path, args: &[&str], stdin: Option<&[u8]>) -> Result<Vec<u8>> {
    let mut run = Run::new("git", args.iter().map(|arg| (*arg).to_owned()).collect());
    run.command()
        .current_dir(root)
        // Port of the spawn environment in `Git.spawn` (`extensions/git/src/git.ts`):
        // no pager to fork, no credential prompt to block on, stable message parsing.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .env("LC_ALL", "en_US.UTF-8");

    Ok(run.output(stdin).await?)
}

/// Run `git <args> -- <paths>`, splitting the path list so no single command line grows
/// past [`MAX_CLI_LENGTH`]. Port of the `splitInChunks` loops in `extensions/git/src/git.ts`.
///
/// With no paths the caller's intent is "everything", which git spells `-- .`.
pub(crate) async fn run_with_paths(root: &Path, args: &[&str], paths: &[String]) -> Result<()> {
    if paths.is_empty() {
        let mut argv: Vec<&str> = args.to_vec();
        argv.extend_from_slice(&["--", "."]);
        run(root, &argv, None).await?;
        return Ok(());
    }

    for chunk in chunks(paths, MAX_CLI_LENGTH) {
        let mut argv: Vec<&str> = args.to_vec();
        argv.push("--");
        argv.extend(chunk.iter().map(String::as_str));
        run(root, &argv, None).await?;
    }
    Ok(())
}

/// Split `values` into runs whose combined length stays under `max_length`.
/// Port of `splitInChunks` in `extensions/git/src/util.ts`.
fn chunks(values: &[String], max_length: usize) -> Vec<&[String]> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut length = 0;

    for (index, value) in values.iter().enumerate() {
        if length > 0 && length + value.len() > max_length {
            out.push(&values[start..index]);
            start = index;
            length = 0;
        }
        length += value.len();
    }
    if start < values.len() {
        out.push(&values[start..]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_split_on_length() {
        let values: Vec<String> = vec!["aaaa".into(), "bbbb".into(), "cc".into()];

        assert_eq!(chunks(&values, 100).len(), 1);
        assert_eq!(chunks(&values, 6), vec![&values[0..1], &values[1..3]]);
        assert_eq!(chunks(&values, 8), vec![&values[0..2], &values[2..3]]);
    }

    #[test]
    fn chunks_of_empty_input_are_empty() {
        assert!(chunks(&[], 10).is_empty());
    }

    #[test]
    fn a_single_over_long_value_still_gets_its_own_chunk() {
        let values: Vec<String> = vec!["a".repeat(50)];
        assert_eq!(chunks(&values, 10), vec![&values[0..1]]);
    }
}
