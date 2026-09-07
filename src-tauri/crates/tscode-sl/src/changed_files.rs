//! The changed files of one commit: a second `sl log`, and the parse of what it prints.
//!
//! Port of `CHANGED_FILES_FIELDS` / `CHANGED_FILES_TEMPLATE` in
//! `addons/isl-server/src/templates.ts` and of `Repository.getAllChangedFiles`.
//!
//! **It is a `log`, not a `status`.** The obvious command for "what did this commit
//! change" is `sl status --change <rev>`, and it is not what upstream runs: the file lists
//! come out of the *log template* as three JSON arrays — `{file_adds|json}`,
//! `{file_mods|json}`, `{file_dels|json}` — so the read is the same shape, the same
//! environment and the same blackbox exclusion as the smartlog fetch beside it. The status
//! letters are then implied by which array a path came out of rather than parsed from a
//! column, which is why there is no status parser here.
//!
//! The smartlog fetch carries a *sample* of the same list — [`crate::smartlog`]'s `files`
//! field, capped at [`MAX_FETCHED_FILES_PER_COMMIT`] — so the view has something to paint
//! before this lands. That sample has no statuses, which is the whole reason this second
//! read exists; upstream says as much in `ChangedFilesWithFetching.tsx`.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::cmd;
use crate::error::{Result, SlError};
use crate::smartlog::COMMIT_END_MARK;

/// Port of `MAX_FETCHED_FILES_PER_COMMIT` in `addons/isl-server/src/commands.ts`: how many
/// of a commit's paths the *smartlog* fetch carries, before this module is asked for the
/// rest.
pub const MAX_FETCHED_FILES_PER_COMMIT: usize = 25;

/// Port of `ChangedFileType`, restricted to the three states a *committed* file can be in.
/// Upstream's union also carries the working-copy states (`?`, `!`, `U`, `Resolved`), which
/// only `sl status` produces and nothing here reads.
///
/// The wire spelling is upstream's single letter, because that is what
/// `nameAndIconForFileStatus` keys on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChangedFileStatus {
    #[serde(rename = "A")]
    Added,
    #[serde(rename = "M")]
    Modified,
    #[serde(rename = "R")]
    Removed,
}

/// Port of `ChangedFile`. Upstream's optional `copy` field is absent: it is filled from
/// `sl status`'s copy source, which this read does not have.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangedFile {
    /// Repository-relative, as `sl` prints it.
    pub path: String,
    pub status: ChangedFileStatus,
}

/// The template expression per field, in the order the parse indexes them — upstream's
/// `CHANGED_FILES_FIELDS`, key order included.
const FIELDS: [&str; field::COUNT] = [
    "{node}",
    "{file_adds|json}",
    "{file_mods|json}",
    "{file_dels|json}",
];

mod field {
    pub(super) const ADDED: usize = 1;
    pub(super) const MODIFIED: usize = 2;
    pub(super) const REMOVED: usize = 3;
    pub(super) const COUNT: usize = 4;
}

/// Port of `CHANGED_FILES_TEMPLATE`.
fn template() -> String {
    let mut template = FIELDS.join("\n");
    template.push('\n');
    template.push_str(COMMIT_END_MARK);
    template
}

/// The `sl log` argv one lookup runs. Separated from the spawn so the recipe can be
/// asserted without a subprocess, as [`crate::cmd::exec_params`] is.
fn log_args<'a>(template: &'a str, hash: &'a str) -> Vec<&'a str> {
    vec!["log", "--template", template, "--rev", hash]
}

/// A revision that is safe to hand to `sl` as `--rev`.
///
/// Upstream interpolates the hash unchecked, because its only caller is its own client. The
/// hash reaching this crate crossed a channel, so it is checked here for the same reason
/// every path is: `sl` is invoked with an argv array, so a shell cannot be reached through
/// it, but a value beginning with `-` is still read as a flag and a revset expression is
/// still evaluated. A smartlog hash is 40 hex characters, so nothing legitimate is refused.
fn validate_hash(hash: &str) -> Result<()> {
    let valid = !hash.is_empty()
        && hash.len() <= 64
        && hash.bytes().all(|byte| byte.is_ascii_hexdigit());

    if valid {
        Ok(())
    } else {
        Err(SlError::InvalidRevision(hash.to_owned()))
    }
}

/// Every file `hash` changed, with the status implied by the list it came from.
///
/// One `sl` process per lookup. Upstream fetches this only for the commit the user
/// selected, never for the whole smartlog, and so does its caller here.
pub(crate) async fn fetch(root: &Path, hash: &str) -> Result<Vec<ChangedFile>> {
    validate_hash(hash)?;

    let template = template();
    let args = log_args(&template, hash);

    Ok(parse(&cmd::run(root, &args).await?))
}

/// Port of `getAllChangedFiles`' parse: three JSON arrays, in upstream's own output order —
/// modified, then added, then removed. A field that does not parse yields no files for that
/// status rather than failing the lookup, which is upstream's `try`/`catch` around the whole
/// of it.
fn parse(output: &str) -> Vec<ChangedFile> {
    let Some(chunk) = output.split(COMMIT_END_MARK).next() else {
        return Vec::new();
    };

    let lines: Vec<&str> = chunk.trim().split('\n').collect();
    if lines.len() < field::COUNT {
        return Vec::new();
    }

    [
        (field::MODIFIED, ChangedFileStatus::Modified),
        (field::ADDED, ChangedFileStatus::Added),
        (field::REMOVED, ChangedFileStatus::Removed),
    ]
    .into_iter()
    .flat_map(|(index, status)| {
        paths(lines[index])
            .into_iter()
            .map(move |path| ChangedFile { path, status })
    })
    .collect()
}

/// One `{…|json}` field: a JSON array of strings, or nothing usable.
fn paths(line: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(line).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(fields: [&str; field::COUNT]) -> String {
        format!("{}\n{COMMIT_END_MARK}", fields.join("\n"))
    }

    #[test]
    fn the_template_is_upstreams_four_fields_ending_in_the_mark() {
        let template = template();
        let lines: Vec<&str> = template.split('\n').collect();

        assert_eq!(
            lines,
            [
                "{node}",
                "{file_adds|json}",
                "{file_mods|json}",
                "{file_dels|json}",
                COMMIT_END_MARK,
            ]
        );
    }

    #[test]
    fn the_lookup_asks_for_one_revision() {
        assert_eq!(
            log_args("{node}", "c0ffee"),
            ["log", "--template", "{node}", "--rev", "c0ffee"]
        );
    }

    /// Upstream's own concatenation order, which is what the view lists them in.
    #[test]
    fn modified_files_come_first_then_added_then_removed() {
        let output = chunk([
            "c0ffee",
            r#"["added.txt"]"#,
            r#"["mod.txt","other.txt"]"#,
            r#"["gone.txt"]"#,
        ]);

        assert_eq!(
            parse(&output),
            [
                ChangedFile { path: "mod.txt".to_owned(), status: ChangedFileStatus::Modified },
                ChangedFile { path: "other.txt".to_owned(), status: ChangedFileStatus::Modified },
                ChangedFile { path: "added.txt".to_owned(), status: ChangedFileStatus::Added },
                ChangedFile { path: "gone.txt".to_owned(), status: ChangedFileStatus::Removed },
            ]
        );
    }

    #[test]
    fn a_commit_that_changed_nothing_parses_as_no_files() {
        assert_eq!(parse(&chunk(["c0ffee", "[]", "[]", "[]"])), []);
    }

    /// `--rev` takes the first commit only; a template that matched more than one must not
    /// fold the second commit's files into the first's.
    #[test]
    fn only_the_first_chunk_is_read() {
        let first = chunk(["aaa", "[]", r#"["one.txt"]"#, "[]"]);
        let second = chunk(["bbb", "[]", r#"["two.txt"]"#, "[]"]);

        let files = parse(&format!("{first}\n{second}"));
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "one.txt");
    }

    #[test]
    fn a_short_or_unparseable_chunk_yields_no_files() {
        assert_eq!(parse(""), []);
        assert_eq!(parse("aaa\n[]"), []);
        // A field that is not a JSON array contributes nothing, and the others still parse.
        assert_eq!(
            parse(&chunk(["aaa", "not json", r#"["kept.txt"]"#, "[]"])),
            [ChangedFile { path: "kept.txt".to_owned(), status: ChangedFileStatus::Modified }]
        );
    }

    #[test]
    fn a_hash_that_is_not_hexadecimal_is_refused() {
        assert!(validate_hash(&"a".repeat(40)).is_ok());
        assert!(validate_hash("C0FFEE").is_ok());

        assert!(validate_hash("").is_err());
        assert!(validate_hash("--config").is_err());
        assert!(validate_hash("draft()").is_err());
        assert!(validate_hash(".").is_err());
        assert!(validate_hash(&"a".repeat(65)).is_err());
    }
}
