//! The smartlog fetch: one `sl log` per refresh, and the parse of what it prints.
//!
//! Port of `mainFetchTemplateFields` / `parseCommitInfoOutput` in
//! `addons/isl-server/src/templates.ts` and of the revset in
//! `Repository.fetchSmartlogCommits`. The template's field *order* is the parse's index,
//! exactly as upstream builds its index from the key order, so [`FIELDS`] and the
//! `field` constants below are one table read two ways.
//!
//! # Commit order is the wire contract
//!
//! Commits cross in the order `sl log` printed them — descendants first, the order the
//! ASCII smartlog `sl` itself draws — and nothing between here and the view reorders
//! them. An order lost here draws a wrong graph rather than failing, which is why it is
//! stated, and why [`SMARTLOG_REVSET`] asks `sl` for the order rather than assuming it.
//!
//! **This is where the port diverges from ISL, and it has to.** ISL builds a client-side
//! `Dag` keyed by hash, so `sl log`'s output order is discarded on arrival and the render
//! order is recomputed by `Dag.dagWalkerForRendering`, which is `sortAsc(...).reverse()`.
//! Nothing in `Repository.fetchSmartlogCommits` establishes an ordering, and its plain
//! `--rev smartlog(...)` in fact prints *ancestors* first — the opposite of what
//! `Renderer.nextRow` needs, which assigns a row its column from the columns its children
//! already claimed. This port ships `render.ts` but not the dag around it, so the order
//! has to be true on the wire, and `reverse()` in the revset is what makes it true.
//!
//! **One formatter differs from upstream.** ISL asks for `{committerdate|isodatesec}`
//! and hands the string to `new Date(...)`; [`SlCommit::date`] is unix seconds, so the
//! same field is fetched with `hgdate`, which prints them. Committer date rather than
//! author date is upstream's choice — an amended or rebased commit otherwise looks stale.

use std::path::Path;

use crate::changed_files::MAX_FETCHED_FILES_PER_COMMIT;
use crate::cmd;
use crate::error::Result;
use crate::model::{CommitPhase, SlCommit, SuccessorInfo};

/// Separates one commit's fields from the next commit's. Port of `COMMIT_END_MARK`.
///
/// Shared with [`crate::changed_files`], whose template ends in the same mark because
/// upstream's does — one constant, as upstream has one.
pub(crate) const COMMIT_END_MARK: &str = "<<COMMIT_END_MARK>>";
/// Separates the repeated values inside one field. Port of `NULL_CHAR`; the template
/// spells it `\0` for the templater to expand.
const NULL_CHAR: char = '\0';
/// What `isDot` prints for the working directory's parent. Port of `WDIR_PARENT_MARKER`.
const WDIR_PARENT_MARKER: &str = "@";

/// The template expression per field, in the order the parse indexes them.
const FIELDS: [&str; field::COUNT] = [
    "{node}",
    "{desc|firstline}",
    "{author}",
    "{committerdate|hgdate}",
    "{phase}",
    r"{bookmarks % '{bookmark}\0'}",
    r"{remotenames % '{remotename}\0'}",
    r#"{parents % "{node}\0"}"#,
    r#"{grandparents % "{node}\0"}"#,
    "{ifcontains(rev, revset('.'), '@')}",
    // Upstream's own comment: we don't need files for public commits, and public commits
    // are sometimes gigantic codemods without you realizing. No need to fetch if not draft.
    r"{ifeq(phase, 'draft', join(files,'\0'), '')}",
    // The files are skipped for a public commit, but the count is still wanted.
    "{files|count}",
    r#"{mutations % "{operation}:{successors % "{node}"},"}"#,
    r#"{predecessors % "{node},"}"#,
    // Description must be last: `{desc}` is the only multi-line field, so it runs to the
    // end of the chunk.
    "{desc}",
];

mod field {
    pub(super) const HASH: usize = 0;
    pub(super) const TITLE: usize = 1;
    pub(super) const AUTHOR: usize = 2;
    pub(super) const DATE: usize = 3;
    pub(super) const PHASE: usize = 4;
    pub(super) const BOOKMARKS: usize = 5;
    pub(super) const REMOTE_BOOKMARKS: usize = 6;
    pub(super) const PARENTS: usize = 7;
    pub(super) const GRANDPARENTS: usize = 8;
    pub(super) const IS_DOT: usize = 9;
    pub(super) const FILES: usize = 10;
    pub(super) const TOTAL_FILE_COUNT: usize = 11;
    pub(super) const SUCCESSOR_INFO: usize = 12;
    pub(super) const CLOSEST_PREDECESSORS: usize = 13;
    pub(super) const DESCRIPTION: usize = 14;
    pub(super) const COUNT: usize = 15;
}

/// The revset ISL fetches, without its date-range and stable-location terms: the
/// interesting bookmarks, the draft heads, and always the working directory parent.
///
/// `reverse()` is this port's, not upstream's — see the module docs. A revision's number
/// is always above its parents', so descending revision order is a topological order with
/// every child ahead of its parents, which is what `render.ts` requires.
const SMARTLOG_REVSET: &str = "reverse(smartlog((interestingbookmarks() + heads(draft())) + .))";

/// Port of `getMainFetchTemplate`.
fn template() -> String {
    let mut template = FIELDS.join("\n");
    template.push('\n');
    template.push_str(COMMIT_END_MARK);
    template
}

/// The `sl log` argv one refresh runs. Separated from the spawn so the recipe can be
/// asserted without a subprocess, as [`crate::cmd::exec_params`] is.
fn log_args<'a>(template: &'a str, limit: Option<&'a str>) -> Vec<&'a str> {
    let mut args = vec!["log", "--template", template, "--rev", SMARTLOG_REVSET];
    if let Some(limit) = limit {
        args.push("--limit");
        args.push(limit);
    }
    args
}

/// Fetch the smartlog of the repository at `root`, in `sl`'s own print order —
/// descendants before ancestors.
///
/// One `sl` process per refresh, never one per commit: every field the view renders is
/// in the template.
pub(crate) async fn fetch(root: &Path, limit: Option<u32>) -> Result<Vec<SlCommit>> {
    let template = template();
    let limit = limit.filter(|limit| *limit > 0).map(|limit| limit.to_string());

    let args = log_args(&template, limit.as_deref());
    Ok(parse(cmd::run(root, &args).await?.trim()))
}

/// Port of `parseCommitInfoOutput`. A chunk that does not parse is dropped rather than
/// failing the refresh, which is upstream's per-commit `try`/`catch`.
fn parse(output: &str) -> Vec<SlCommit> {
    output.split(COMMIT_END_MARK).filter_map(parse_commit).collect()
}

fn parse_commit(chunk: &str) -> Option<SlCommit> {
    let lines: Vec<&str> = chunk.trim_start().split('\n').collect();
    if lines.len() < field::COUNT {
        return None;
    }

    Some(SlCommit {
        hash: lines[field::HASH].to_owned(),
        title: lines[field::TITLE].to_owned(),
        // The first line of `{desc}` is the title, which is already its own field.
        description: lines[field::DESCRIPTION + 1..].join("\n").trim().to_owned(),
        author: lines[field::AUTHOR].to_owned(),
        date: parse_date(lines[field::DATE])?,
        phase: CommitPhase::parse(lines[field::PHASE]),
        is_dot: lines[field::IS_DOT] == WDIR_PARENT_MARKER,
        parents: split_line(lines[field::PARENTS], NULL_CHAR),
        grandparents: split_line(lines[field::GRANDPARENTS], NULL_CHAR),
        bookmarks: split_line(lines[field::BOOKMARKS], NULL_CHAR),
        remote_bookmarks: split_line(lines[field::REMOTE_BOOKMARKS], NULL_CHAR),
        file_paths_sample: {
            let mut files = split_line(lines[field::FILES], NULL_CHAR);
            files.truncate(MAX_FETCHED_FILES_PER_COMMIT);
            files
        },
        // `{files|count}` always prints a number; a field that somehow did not is no
        // files, which is what upstream's `parseInt` NaN would render as.
        total_file_count: lines[field::TOTAL_FILE_COUNT].parse().unwrap_or(0),
        successor_info: parse_successor_data(lines[field::SUCCESSOR_INFO]),
        closest_predecessors: split_line(lines[field::CLOSEST_PREDECESSORS], ','),
    })
}

/// `hgdate` prints `<unix seconds> <utc offset>`; the offset is presentation only, and
/// the wire carries the instant.
fn parse_date(value: &str) -> Option<i64> {
    value.split_whitespace().next()?.parse().ok()
}

/// Port of `parseSuccessorData`: only the first mutation is of interest.
fn parse_successor_data(value: &str) -> Option<SuccessorInfo> {
    let (operation, successors) = value.split(',').next()?.split_once(':')?;
    Some(SuccessorInfo {
        hash: successors.to_owned(),
        kind: operation.to_owned(),
    })
}

/// Port of `splitLine`: the separator is a terminator, so empty pieces are dropped.
fn split_line(line: &str, separator: char) -> Vec<String> {
    line.split(separator)
        .filter(|piece| !piece.is_empty())
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The lines one commit contributes, in template order, joined the way `sl` prints
    /// them. Every fixture below is written as `sl` would emit it, never as the parser
    /// happens to accept it.
    fn chunk(fields: [&str; field::COUNT]) -> String {
        format!("{}\n{COMMIT_END_MARK}", fields.join("\n"))
    }

    #[test]
    fn the_template_is_one_field_per_line_ending_in_the_mark() {
        let template = template();
        let lines: Vec<&str> = template.split('\n').collect();

        assert_eq!(lines.len(), field::COUNT + 1);
        assert_eq!(lines[field::HASH], "{node}");
        assert_eq!(lines[field::DESCRIPTION], "{desc}");
        assert_eq!(lines[field::COUNT], COMMIT_END_MARK);
    }

    /// `sl log --rev <set>` prints the set in ascending revision order, so an unwrapped
    /// revset hands the view its ancestors first and the graph renders upside down
    /// without erroring. The `reverse()` is the whole ordering contract.
    #[test]
    fn the_revset_is_reversed_so_descendants_are_printed_first() {
        assert_eq!(
            log_args("{node}", None),
            [
                "log",
                "--template",
                "{node}",
                "--rev",
                "reverse(smartlog((interestingbookmarks() + heads(draft())) + .))",
            ]
        );
        assert_eq!(log_args("{node}", Some("20"))[5..], ["--limit", "20"]);
    }

    #[test]
    fn a_plain_draft_commit_parses() {
        let output = chunk([
            "0123456789abcdef0123456789abcdef01234567",
            "Add a thing",
            "Ada <ada@example.com>",
            "1700000000 -28800",
            "draft",
            "my-bookmark\u{0}",
            "remote/main\u{0}",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\u{0}",
            "",
            "@",
            "src/one.rs\u{0}src/two.rs\u{0}",
            "2",
            "",
            "",
            "Add a thing\n\nWith a body.",
        ]);

        let commits = parse(&output);
        assert_eq!(commits.len(), 1);
        let commit = &commits[0];

        assert_eq!(commit.hash, "0123456789abcdef0123456789abcdef01234567");
        assert_eq!(commit.title, "Add a thing");
        assert_eq!(commit.description, "With a body.");
        assert_eq!(commit.author, "Ada <ada@example.com>");
        assert_eq!(commit.date, 1_700_000_000);
        assert_eq!(commit.phase, CommitPhase::Draft);
        assert!(commit.is_dot);
        assert_eq!(commit.parents, ["a".repeat(40)]);
        assert!(commit.grandparents.is_empty());
        assert_eq!(commit.bookmarks, ["my-bookmark"]);
        assert_eq!(commit.remote_bookmarks, ["remote/main"]);
        assert_eq!(commit.file_paths_sample, ["src/one.rs", "src/two.rs"]);
        assert_eq!(commit.total_file_count, 2);
        assert_eq!(commit.successor_info, None);
        assert!(commit.closest_predecessors.is_empty());
    }

    /// Upstream's template prints no `files` for a public commit — a public commit is
    /// sometimes a codemod — but still counts them, and the count is what the commit-info
    /// panel's badge reads.
    #[test]
    fn a_public_commit_carries_its_file_count_without_the_sample() {
        let output = chunk([
            "abc", "Title", "Ada", "1700000000 0", "public", "", "", "", "", "", "", "412",
            "", "", "Title",
        ]);

        let commit = &parse(&output)[0];
        assert!(commit.file_paths_sample.is_empty());
        assert_eq!(commit.total_file_count, 412);
    }

    /// The sample is capped where upstream caps it, so a codemod cannot put thousands of
    /// paths on the wire; the count still reports the whole of it.
    #[test]
    fn the_file_sample_is_capped_and_the_count_is_not() {
        let files: String = (0..40).map(|i| format!("f{i}.txt\u{0}")).collect();
        let output = chunk([
            "abc", "Title", "Ada", "1700000000 0", "draft", "", "", "", "", "", &files,
            "40", "", "", "Title",
        ]);

        let commit = &parse(&output)[0];
        assert_eq!(commit.file_paths_sample.len(), MAX_FETCHED_FILES_PER_COMMIT);
        assert_eq!(commit.file_paths_sample[0], "f0.txt");
        assert_eq!(commit.total_file_count, 40);
    }

    #[test]
    fn a_merge_commit_carries_both_parents_and_its_grandparents() {
        let output = chunk([
            "c0ffee",
            "Merge",
            "Ada",
            "1700000000 0",
            "public",
            "",
            "",
            &format!("{}\u{0}{}\u{0}", "a".repeat(40), "b".repeat(40)),
            &format!("{}\u{0}", "c".repeat(40)),
            "",
            "",
            "0",
            "",
            "",
            "Merge",
        ]);

        let commit = &parse(&output)[0];
        assert_eq!(commit.parents, ["a".repeat(40), "b".repeat(40)]);
        assert_eq!(commit.grandparents, ["c".repeat(40)]);
        assert_eq!(commit.phase, CommitPhase::Public);
        assert!(!commit.is_dot);
        // `{desc}`'s only line is the title, so nothing is left for the description.
        assert_eq!(commit.description, "");
    }

    #[test]
    fn an_obsolete_commit_reports_its_first_successor_only() {
        let output = chunk([
            "dead",
            "Rewritten",
            "Ada",
            "1700000000 0",
            "draft",
            "",
            "",
            "",
            "",
            "",
            "",
            "0",
            "amend:beef,rebase:feed,",
            "cafe,babe,",
            "Rewritten",
        ]);

        let commit = &parse(&output)[0];
        assert_eq!(
            commit.successor_info,
            Some(SuccessorInfo { hash: "beef".to_owned(), kind: "amend".to_owned() })
        );
        assert_eq!(commit.closest_predecessors, ["cafe", "babe"]);
    }

    #[test]
    fn empty_bookmark_and_remote_fields_parse_as_empty_lists() {
        let output = chunk([
            "abc", "Title", "Ada", "1700000000 0", "draft", "", "", "", "", "", "", "0",
            "", "", "Title",
        ]);

        let commit = &parse(&output)[0];
        assert!(commit.bookmarks.is_empty());
        assert!(commit.remote_bookmarks.is_empty());
        assert!(commit.parents.is_empty());
        assert!(commit.grandparents.is_empty());
        assert!(commit.closest_predecessors.is_empty());
        assert_eq!(commit.successor_info, None);
    }

    /// The order `sl` printed is the order the view draws, so the parse must not reorder
    /// — not by date, not by hash. The fixture is deliberately a descendant printed
    /// first whose date is *older* than its ancestor's and whose hash sorts after it, so
    /// any sort that crept in would swap the two.
    #[test]
    fn commits_keep_the_order_sl_printed_them_in() {
        let descendant = chunk([
            "ccc", "Tip", "Ada", "1700000000 0", "draft", "", "", "aaa\u{0}", "", "@", "",
            "0", "", "", "Tip",
        ]);
        let ancestor = chunk([
            "aaa", "Base", "Bob", "1700009999 0", "public", "", "", "", "", "", "", "0",
            "", "", "Base",
        ]);

        let commits = parse(&format!("{descendant}\n{ancestor}"));
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].hash, "ccc");
        assert_eq!(commits[0].parents, ["aaa"]);
        assert_eq!(commits[1].hash, "aaa");
        assert_eq!(commits[1].date, 1_700_009_999);
    }

    #[test]
    fn a_short_chunk_is_skipped_rather_than_failing_the_refresh() {
        assert!(parse("").is_empty());
        assert!(parse(&format!("abc\nTitle\n{COMMIT_END_MARK}")).is_empty());
    }
}
