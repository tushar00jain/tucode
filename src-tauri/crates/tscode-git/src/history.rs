//! Commit history — the data behind the Source Control Graph view.
//!
//! A port of the history commands the git extension issues in `extensions/git/src/git.ts` —
//! `log`, `getRefs`, `getMergeBase`, `getCommit`, `getEmptyTree` and `diffBetweenWithStats` —
//! onto `gix`. Every one of them is a read, so every one runs in process: shelling out to
//! `git log` would consult the repository's own `core.pager` and hooks, which is exactly what
//! this crate's reads-use-`gix` rule exists to prevent.
//!
//! Three things `gix` does not reproduce, and what is done instead:
//!
//! - **`--topo-order`.** `gix::revision::walk::Sorting` has no topological mode, so the walk
//!   is `ByCommitTime(NewestFirst)` — git's own default order.
//! - **`--author=` / `--grep=`.** Both are POSIX regular expressions to git. This crate has
//!   no regex engine, so each is matched case-insensitively as a substring.
//! - **`--shortstat`.** git computes it during the walk; here it is [`stats`], a second call
//!   the frontend makes for a page it has already painted.

use std::collections::HashMap;

use gix::bstr::ByteSlice;
use gix::diff::blob::{Algorithm, InternedInput, diff_with_slider_heuristics};
use gix::diff::tree_with_rewrites::Change as TreeDiffChange;
use gix::revision::walk::Sorting;
use gix::traverse::commit::simple::CommitTimeOrder;
use serde::{Deserialize, Serialize};

use crate::diff::{is_binary, read_blob};
use crate::error::{GitError, Result};
use crate::model::Change;
use crate::status::{TreeChange, tree_change};

/// One commit. Port of `Commit` in `extensions/git/src/git.ts`, minus the fields this port
/// has no consumer for (`commitDate`, `coAuthors`, `shortStat` — see [`stats`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    /// Author date, seconds since the epoch — git's `%at`.
    pub author_date: i64,
    /// The full commit message, subject line included.
    pub message: String,
    /// The decorating ref names, in `git log --decorate=full`'s `%D` spellings:
    /// `HEAD -> refs/heads/x`, `refs/heads/x`, `refs/remotes/o/x`, `tag: refs/tags/x`.
    pub ref_names: Vec<String>,
}

/// What kind of ref a [`RefInfo`] names. Port of `RefType` in `api/git.d.ts`, minus the
/// `RemoteHead` alias-only variants this port does not read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    Head,
    RemoteHead,
    Tag,
}

/// One ref. `name` is the short spelling upstream's `Ref` carries — `main` for a local
/// branch, `origin/main` for a remote one, the tag name for a tag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefInfo {
    pub kind: RefKind,
    pub name: String,
    /// Hex object id of the commit the ref resolves to, tags peeled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
}

/// Port of `LogOptions` in `api/git.d.ts`, narrowed to the fields the history provider sets.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LogOptions {
    /// git's `-n`. Upstream's default is 32.
    pub max_entries: Option<usize>,
    pub skip: Option<usize>,
    /// A commit range. The graph's only spelling is `<parent>..`, meaning "hide everything
    /// reachable from `<parent>`".
    pub range: Option<String>,
    /// The tips to walk from. `None` walks from HEAD.
    pub ref_names: Option<Vec<String>>,
    /// git's `--max-parents`: keep commits with at most this many parents.
    pub max_parents: Option<usize>,
    pub author: Option<String>,
    pub grep: Option<String>,
}

/// Port of `CommitShortStat` in `extensions/git/src/git.ts`, keyed by the commit it is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitStats {
    pub files: usize,
    pub insertions: usize,
    pub deletions: usize,
}

/// The commits a `git log` with these options would print.
pub(crate) fn log(repo: &gix::Repository, opts: &LogOptions) -> Result<Vec<Commit>> {
    let tips = tips(repo, opts.ref_names.as_deref());
    if tips.is_empty() {
        // An unborn branch, or every named ref has since been deleted.
        return Ok(Vec::new());
    }

    let mut platform = repo.rev_walk(tips);
    if let Some(range) = &opts.range {
        let Some(hidden) = commit_id(repo, range.trim_end_matches("..")) else {
            return Ok(Vec::new());
        };
        platform = platform.with_hidden([hidden]);
    }

    let walk = platform
        .sorting(Sorting::ByCommitTime(CommitTimeOrder::NewestFirst))
        .all()
        .map_err(GitError::gix("start revision walk"))?;

    let decorations = decorations(repo)?;
    let max_entries = opts.max_entries.unwrap_or(32);
    let mut skip = opts.skip.unwrap_or(0);
    let mut out = Vec::new();

    for info in walk {
        let info = info.map_err(GitError::gix("walk revisions"))?;
        let commit = info
            .object()
            .map_err(GitError::gix("read commit"))?;

        if opts
            .max_parents
            .is_some_and(|max| commit.parent_ids().count() > max)
        {
            continue;
        }

        let commit = to_commit(&commit, &decorations)?;
        if !matches(&commit, opts) {
            continue;
        }
        if skip > 0 {
            skip -= 1;
            continue;
        }

        out.push(commit);
        if out.len() >= max_entries {
            break;
        }
    }

    Ok(out)
}

/// One commit by revision. Port of `getCommit`.
pub(crate) fn get_commit(repo: &gix::Repository, rev: &str) -> Result<Commit> {
    let id = commit_id(repo, rev).ok_or_else(|| GitError::NoSuchEntry {
        path: rev.to_owned(),
        location: "revision",
    })?;
    let commit = repo
        .find_commit(id)
        .map_err(GitError::gix("read commit"))?;

    to_commit(&commit, &decorations(repo)?)
}

/// Local branches, remote branches and tags. Port of `getRefs`, whose `pattern` is a list of
/// `for-each-ref` patterns — matched here with `*` as the only wildcard, which is all the
/// history provider ever passes.
pub(crate) fn refs(repo: &gix::Repository, pattern: Option<&[String]>) -> Result<Vec<RefInfo>> {
    let platform = repo
        .references()
        .map_err(GitError::gix("open reference database"))?;
    let iter = platform
        .all()
        .map_err(GitError::gix("iterate references"))?;

    let mut out = Vec::new();
    for reference in iter.filter_map(std::result::Result::ok) {
        let full_name = reference.name().as_bstr().to_str_lossy().into_owned();
        let Some((kind, name)) = classify(&full_name) else {
            continue;
        };
        if !pattern.is_none_or(|patterns| patterns.iter().any(|p| ref_matches(p, &full_name))) {
            continue;
        }

        out.push(RefInfo {
            kind,
            name: name.to_owned(),
            commit: peel(reference).map(|id| id.to_string()),
        });
    }

    // `for-each-ref` sorts by refname; the frontend groups by kind afterwards.
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// `git merge-base`, n-way. Port of `getMergeBase(ref1, ref2, ...rest)`: three or more refs
/// go through `--octopus`, and an unresolvable ref is `undefined` rather than an error, as
/// upstream's `catch` makes it.
pub(crate) fn merge_base(repo: &gix::Repository, revs: &[String]) -> Option<String> {
    let ids: Vec<_> = revs.iter().map(|rev| commit_id(repo, rev)).collect();
    if ids.iter().any(Option::is_none) {
        return None;
    }
    let ids: Vec<_> = ids.into_iter().flatten().collect();

    let base = match ids.as_slice() {
        [] | [_] => return ids.first().map(ToString::to_string),
        [one, two] => repo.merge_base(*one, *two).ok()?,
        many => repo.merge_base_octopus(many.iter().copied()).ok()?,
    };
    Some(base.to_string())
}

/// The name-status changes between two tree-ish revisions. Port of `diffBetweenWithStats`,
/// whose range is `ref1...ref2` — the merge base of the two against `ref2`, not `ref1`
/// against `ref2`.
pub(crate) fn diff_between(repo: &gix::Repository, rev1: &str, rev2: &str) -> Result<Vec<Change>> {
    let old = merge_base(repo, &[rev1.to_owned(), rev2.to_owned()]).unwrap_or_else(|| rev1.to_owned());
    let old_tree = tree(repo, &old)?;
    let new_tree = tree(repo, rev2)?;

    let mut out: Vec<Change> = repo
        .diff_tree_to_tree(&old_tree, &new_tree, None)
        .map_err(GitError::gix("diff two revisions"))?
        .iter()
        .filter(|change| is_file(change))
        .map(|change| tree_change(to_tree_change(change)))
        .collect();

    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// The empty-tree hash, which is a root commit's parent. Port of `getEmptyTree`.
pub(crate) fn empty_tree(repo: &gix::Repository) -> String {
    repo.empty_tree().id.to_string()
}

/// Files changed, insertions and deletions for each of `hashes` — git's `--shortstat`, which
/// diffs a merge against its first parent and a root commit against the empty tree.
///
/// This is the expensive read: one tree diff plus a line diff per changed blob, per commit.
/// It is a call of its own so a page of history can paint before it is asked for.
pub(crate) fn stats(
    repo: &gix::Repository,
    hashes: &[String],
) -> Result<HashMap<String, CommitStats>> {
    let mut out = HashMap::with_capacity(hashes.len());

    for hash in hashes {
        let Some(id) = commit_id(repo, hash) else {
            continue;
        };
        let commit = repo
            .find_commit(id)
            .map_err(GitError::gix("read commit"))?;

        let new_tree = commit.tree().map_err(GitError::gix("read commit tree"))?;
        let old_tree = match commit.parent_ids().next() {
            Some(parent) => tree(repo, &parent.to_string())?,
            None => repo.empty_tree(),
        };

        let changes = repo
            .diff_tree_to_tree(&old_tree, &new_tree, None)
            .map_err(GitError::gix("diff commit against its parent"))?;

        let files: Vec<_> = changes.iter().filter(|change| is_file(change)).collect();
        let mut stats = CommitStats {
            files: files.len(),
            insertions: 0,
            deletions: 0,
        };
        for change in files {
            let (before, after) = blob_pair(repo, change)?;
            if is_binary(&before) || is_binary(&after) {
                continue;
            }
            let input = InternedInput::new(before.as_slice(), after.as_slice());
            let diff = diff_with_slider_heuristics(Algorithm::Histogram, &input);
            stats.insertions += diff.count_additions() as usize;
            stats.deletions += diff.count_removals() as usize;
        }

        out.insert(hash.clone(), stats);
    }

    Ok(out)
}

/// Whether a tree-diff change is about a file rather than a directory. `gix` reports a whole
/// added or removed directory as a change of its own; `git diff --raw`, which is what the
/// graph is written against, lists only the blobs under it.
fn is_file(change: &TreeDiffChange) -> bool {
    let mode = match change {
        TreeDiffChange::Addition { entry_mode, .. }
        | TreeDiffChange::Deletion { entry_mode, .. }
        | TreeDiffChange::Modification { entry_mode, .. }
        | TreeDiffChange::Rewrite { entry_mode, .. } => entry_mode,
    };
    mode.is_blob_or_symlink()
}

/// The two blob sides of a tree-diff change; an added or deleted path has one empty side.
fn blob_pair(repo: &gix::Repository, change: &TreeDiffChange) -> Result<(Vec<u8>, Vec<u8>)> {
    let blob = |id: Option<gix::ObjectId>| -> Result<Vec<u8>> {
        Ok(match id {
            Some(id) => read_blob(repo, id)?.unwrap_or_default(),
            None => Vec::new(),
        })
    };

    let (before, after) = match change {
        TreeDiffChange::Addition { id, .. } => (None, Some(*id)),
        TreeDiffChange::Deletion { id, .. } => (Some(*id), None),
        TreeDiffChange::Modification { previous_id, id, .. } => (Some(*previous_id), Some(*id)),
        TreeDiffChange::Rewrite { source_id, id, .. } => (Some(*source_id), Some(*id)),
    };

    Ok((blob(before)?, blob(after)?))
}

fn to_tree_change(change: &TreeDiffChange) -> TreeChange<'_> {
    match change {
        TreeDiffChange::Addition { location, .. } => TreeChange::Addition(location.as_bstr()),
        TreeDiffChange::Deletion { location, .. } => TreeChange::Deletion(location.as_bstr()),
        TreeDiffChange::Modification { location, .. } => {
            TreeChange::Modification(location.as_bstr())
        }
        TreeDiffChange::Rewrite {
            source_location,
            location,
            copy,
            ..
        } => TreeChange::Rewrite {
            source: source_location.as_bstr(),
            location: location.as_bstr(),
            copy: *copy,
        },
    }
}

fn to_commit(commit: &gix::Commit<'_>, decorations: &Decorations) -> Result<Commit> {
    let author = commit.author().map_err(GitError::gix("read commit author"))?;
    let hash = commit.id().to_string();

    Ok(Commit {
        parents: commit.parent_ids().map(|id| id.to_string()).collect(),
        author_name: author.name.to_str_lossy().into_owned(),
        author_email: author.email.to_str_lossy().into_owned(),
        author_date: author.time().map(|time| time.seconds).unwrap_or_default(),
        message: commit.message_raw_sloppy().to_str_lossy().into_owned(),
        ref_names: decorations.get(&hash).cloned().unwrap_or_default(),
        hash,
    })
}

/// Every commit that a ref points at, by hash, in git's `%D` spellings.
type Decorations = HashMap<String, Vec<String>>;

/// One pass over the ref database, so a page of commits costs one ref read rather than one
/// per commit.
fn decorations(repo: &gix::Repository) -> Result<Decorations> {
    let head_referent = repo
        .head_name()
        .ok()
        .flatten()
        .map(|name| name.as_bstr().to_str_lossy().into_owned());

    let platform = repo
        .references()
        .map_err(GitError::gix("open reference database"))?;
    let iter = platform
        .all()
        .map_err(GitError::gix("iterate references"))?;

    let mut out: Decorations = HashMap::new();
    for reference in iter.filter_map(std::result::Result::ok) {
        let full_name = reference.name().as_bstr().to_str_lossy().into_owned();
        let Some((kind, _)) = classify(&full_name) else {
            continue;
        };
        let Some(id) = peel(reference) else {
            continue;
        };

        let decoration = match kind {
            RefKind::Tag => format!("tag: {full_name}"),
            RefKind::Head if head_referent.as_deref() == Some(full_name.as_str()) => {
                format!("HEAD -> {full_name}")
            }
            RefKind::Head | RefKind::RemoteHead => full_name,
        };
        out.entry(id.to_string()).or_default().push(decoration);
    }

    Ok(out)
}

/// The full ref name's kind and short name, or `None` for refs the graph does not show
/// (`refs/stash`, notes, and anything else outside the three namespaces).
fn classify(full_name: &str) -> Option<(RefKind, &str)> {
    if let Some(name) = full_name.strip_prefix("refs/heads/") {
        Some((RefKind::Head, name))
    } else if let Some(name) = full_name.strip_prefix("refs/remotes/") {
        Some((RefKind::RemoteHead, name))
    } else if let Some(name) = full_name.strip_prefix("refs/tags/") {
        Some((RefKind::Tag, name))
    } else {
        None
    }
}

/// `for-each-ref`'s pattern rule: a pattern without a `refs/` prefix gets one, and `*` is
/// the only wildcard.
fn ref_matches(pattern: &str, full_name: &str) -> bool {
    let pattern = if pattern.starts_with("refs/") {
        pattern.to_owned()
    } else {
        format!("refs/{pattern}")
    };

    let mut rest = full_name;
    let mut parts = pattern.split('*');
    let Some(first) = parts.next() else {
        return true;
    };
    let Some(stripped) = rest.strip_prefix(first) else {
        return false;
    };
    rest = stripped;

    let mut last = None;
    for part in parts {
        last = Some(part);
        match rest.find(part) {
            Some(at) => rest = &rest[at + part.len()..],
            None => return false,
        }
    }

    // A pattern with no `*` must match in full; one ending in a literal must end with it,
    // which the walk above has already consumed.
    last.is_some() || rest.is_empty()
}

fn peel(mut reference: gix::Reference<'_>) -> Option<gix::ObjectId> {
    reference.peel_to_id().ok().map(|id| id.detach())
}

/// The tips a walk starts from: the named refs, or HEAD when none were named.
fn tips(repo: &gix::Repository, ref_names: Option<&[String]>) -> Vec<gix::ObjectId> {
    match ref_names {
        Some(names) => names.iter().filter_map(|name| commit_id(repo, name)).collect(),
        None => commit_id(repo, "HEAD").into_iter().collect(),
    }
}

/// Resolve a revspec to the commit it names, tags peeled. A ref the caller no longer has is
/// `None`, not an error: the graph asks for the refs it last saw.
fn commit_id(repo: &gix::Repository, rev: &str) -> Option<gix::ObjectId> {
    Some(
        repo.rev_parse_single(rev)
            .ok()?
            .object()
            .ok()?
            .peel_to_commit()
            .ok()?
            .id,
    )
}

fn tree<'repo>(repo: &'repo gix::Repository, rev: &str) -> Result<gix::Tree<'repo>> {
    repo.rev_parse_single(rev)
        .map_err(GitError::gix("resolve revision"))?
        .object()
        .map_err(GitError::gix("read revision"))?
        .peel_to_tree()
        .map_err(GitError::gix("peel revision to tree"))
}

/// The `--author=` and `--grep=` filters, as substrings — see the module docs.
fn matches(commit: &Commit, opts: &LogOptions) -> bool {
    let contains = |haystack: &str, needle: &str| {
        haystack.to_lowercase().contains(&needle.to_lowercase())
    };

    if let Some(author) = &opts.author {
        if !contains(&commit.author_name, author) && !contains(&commit.author_email, author) {
            return false;
        }
    }
    if let Some(grep) = &opts.grep {
        if !contains(&commit.message, grep) {
            return false;
        }
    }

    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `for-each-ref`'s pattern rule, including the `refs/` prefix it supplies.
    #[test]
    fn ref_patterns_match_the_way_for_each_ref_does() {
        assert!(ref_matches("refs/heads/main", "refs/heads/main"));
        assert!(!ref_matches("refs/heads/main", "refs/heads/mainline"));
        // Unprefixed patterns are taken as relative to `refs/`.
        assert!(ref_matches("heads/main", "refs/heads/main"));
        assert!(ref_matches("refs/heads/*", "refs/heads/feature/x"));
        assert!(!ref_matches("refs/heads/*", "refs/tags/v1"));
        assert!(ref_matches("refs/*/main", "refs/heads/main"));
        assert!(!ref_matches("refs/*/main", "refs/heads/other"));
    }

    /// The three namespaces the graph shows, and the ones it does not.
    #[test]
    fn refs_are_classified_by_namespace() {
        assert_eq!(classify("refs/heads/main"), Some((RefKind::Head, "main")));
        assert_eq!(
            classify("refs/remotes/origin/main"),
            Some((RefKind::RemoteHead, "origin/main"))
        );
        assert_eq!(classify("refs/tags/v1.0"), Some((RefKind::Tag, "v1.0")));
        assert_eq!(classify("refs/stash"), None);
        assert_eq!(classify("HEAD"), None);
    }

    fn commit(author_name: &str, author_email: &str, message: &str) -> Commit {
        Commit {
            hash: "0".repeat(40),
            parents: Vec::new(),
            author_name: author_name.to_owned(),
            author_email: author_email.to_owned(),
            author_date: 0,
            message: message.to_owned(),
            ref_names: Vec::new(),
        }
    }

    /// `_searchHistoryItems` runs an author search and a grep search; each arm matches
    /// case-insensitively, and the author arm covers the email as `--author` does.
    #[test]
    fn author_and_grep_filters_are_case_insensitive_substrings() {
        let entry = commit("Ada Lovelace", "ada@example.org", "Fix the Analytical Engine");

        let author = |value: &str| LogOptions {
            author: Some(value.to_owned()),
            ..LogOptions::default()
        };
        assert!(matches(&entry, &author("lovelace")));
        assert!(matches(&entry, &author("ADA@EXAMPLE.ORG")));
        assert!(!matches(&entry, &author("babbage")));

        let grep = |value: &str| LogOptions {
            grep: Some(value.to_owned()),
            ..LogOptions::default()
        };
        assert!(matches(&entry, &grep("analytical")));
        assert!(!matches(&entry, &grep("difference")));

        // Both set means both must hold, as two `git log` filters do.
        assert!(matches(
            &entry,
            &LogOptions {
                author: Some("ada".to_owned()),
                grep: Some("engine".to_owned()),
                ..LogOptions::default()
            }
        ));
        assert!(!matches(
            &entry,
            &LogOptions {
                author: Some("babbage".to_owned()),
                grep: Some("engine".to_owned()),
                ..LogOptions::default()
            }
        ));
        // No filter set matches everything.
        assert!(matches(&entry, &LogOptions::default()));
    }

    //#region Against a real repository

    /// A fixed signature, so the assertions below are about the walk rather than about the
    /// machine's git identity or clock.
    fn signature(name: &'static str, time: &'static str) -> gix::actor::SignatureRef<'static> {
        gix::actor::SignatureRef {
            name: name.into(),
            email: "author@example.org".into(),
            time,
        }
    }

    /// Commit a single file at `path` with `content`, on top of whatever HEAD names.
    fn commit_file(
        repo: &gix::Repository,
        path: &str,
        content: &str,
        message: &'static str,
        time: &'static str,
    ) -> gix::ObjectId {
        let blob = repo.write_blob(content).expect("write blob").detach();
        let tree = repo
            .write_object(gix::objs::Tree {
                entries: vec![gix::objs::tree::Entry {
                    mode: gix::objs::tree::EntryKind::Blob.into(),
                    filename: path.into(),
                    oid: blob,
                }],
            })
            .expect("write tree")
            .detach();

        let parents: Vec<_> = repo.head_id().map(|id| id.detach()).into_iter().collect();
        let author = signature("Ada Lovelace", time);
        repo.commit_as(author, author, "HEAD", message, tree, parents)
            .expect("commit")
            .detach()
    }

    fn fixture() -> (tempfile::TempDir, gix::Repository) {
        let dir = tempfile::tempdir().expect("temp dir");
        let repo = gix::init(dir.path()).expect("init repository");
        (dir, repo)
    }

    #[test]
    fn log_walks_newest_first_and_records_parents() {
        let (_dir, repo) = fixture();
        let first = commit_file(&repo, "a.txt", "one\n", "first", "1700000000 +0000");
        let second = commit_file(&repo, "a.txt", "one\ntwo\n", "second", "1700000060 +0000");

        let commits = log(&repo, &LogOptions::default()).expect("log");
        assert_eq!(
            commits.iter().map(|c| c.hash.as_str()).collect::<Vec<_>>(),
            [second.to_string(), first.to_string()]
        );
        assert_eq!(commits[0].parents, vec![first.to_string()]);
        assert!(commits[1].parents.is_empty());
        assert_eq!(commits[0].message, "second");
        assert_eq!(commits[0].author_name, "Ada Lovelace");
        assert_eq!(commits[0].author_date, 1_700_000_060);
    }

    /// `maxEntries`, `skip` and `maxParents` are three separate `git log` flags; each is
    /// asserted where it can only pass if that flag alone did the work.
    #[test]
    fn log_honours_max_entries_skip_and_max_parents() {
        let (_dir, repo) = fixture();
        let first = commit_file(&repo, "a.txt", "one\n", "first", "1700000000 +0000");
        let second = commit_file(&repo, "a.txt", "one\ntwo\n", "second", "1700000060 +0000");

        let page = |opts: LogOptions| {
            log(&repo, &opts)
                .expect("log")
                .into_iter()
                .map(|c| c.hash)
                .collect::<Vec<_>>()
        };

        assert_eq!(
            page(LogOptions {
                max_entries: Some(1),
                ..LogOptions::default()
            }),
            [second.to_string()]
        );
        assert_eq!(
            page(LogOptions {
                skip: Some(1),
                ..LogOptions::default()
            }),
            [first.to_string()]
        );
        // `--max-parents=0` is the root-commits filter `resolveHistoryItemRefsCommonAncestor`
        // falls back to.
        assert_eq!(
            page(LogOptions {
                max_parents: Some(0),
                ..LogOptions::default()
            }),
            [first.to_string()]
        );
        // `<parent>..` hides everything reachable from the parent.
        assert_eq!(
            page(LogOptions {
                range: Some(format!("{first}..")),
                ..LogOptions::default()
            }),
            [second.to_string()]
        );
    }

    #[test]
    fn head_branch_decorates_its_commit() {
        let (_dir, repo) = fixture();
        commit_file(&repo, "a.txt", "one\n", "first", "1700000000 +0000");

        let commits = log(&repo, &LogOptions::default()).expect("log");
        let head = repo
            .head_name()
            .expect("head")
            .expect("not detached")
            .as_bstr()
            .to_string();
        assert_eq!(commits[0].ref_names, vec![format!("HEAD -> {head}")]);

        let named = refs(&repo, None).expect("refs");
        assert_eq!(named.len(), 1);
        assert_eq!(named[0].kind, RefKind::Head);
        assert_eq!(named[0].commit.as_deref(), Some(commits[0].hash.as_str()));
    }

    /// A root commit diffs against the empty tree, so its every line is an insertion; the
    /// second commit adds one line and removes none.
    #[test]
    fn stats_count_files_insertions_and_deletions() {
        let (_dir, repo) = fixture();
        let first = commit_file(&repo, "a.txt", "one\ntwo\n", "first", "1700000000 +0000");
        let second = commit_file(&repo, "a.txt", "one\ntwo\nthree\n", "second", "1700000060 +0000");

        let stats = stats(&repo, &[first.to_string(), second.to_string()]).expect("stats");
        assert_eq!(
            stats[&first.to_string()],
            CommitStats {
                files: 1,
                insertions: 2,
                deletions: 0
            }
        );
        assert_eq!(
            stats[&second.to_string()],
            CommitStats {
                files: 1,
                insertions: 1,
                deletions: 0
            }
        );
    }

    #[test]
    fn diff_between_reports_the_changed_paths() {
        let (_dir, repo) = fixture();
        let first = commit_file(&repo, "a.txt", "one\n", "first", "1700000000 +0000");
        let second = commit_file(&repo, "b.txt", "two\n", "second", "1700000060 +0000");

        let changes = diff_between(&repo, &first.to_string(), &second.to_string()).expect("diff");
        assert_eq!(
            changes
                .iter()
                .map(|change| (change.path.as_str(), change.status))
                .collect::<Vec<_>>(),
            [
                ("a.txt", crate::model::Status::IndexDeleted),
                ("b.txt", crate::model::Status::IndexAdded)
            ]
        );
    }

    #[test]
    fn empty_tree_is_gits_own_constant() {
        let (_dir, repo) = fixture();
        assert_eq!(empty_tree(&repo), "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    }

    #[test]
    fn merge_base_of_a_commit_and_its_ancestor_is_the_ancestor() {
        let (_dir, repo) = fixture();
        let first = commit_file(&repo, "a.txt", "one\n", "first", "1700000000 +0000");
        let second = commit_file(&repo, "a.txt", "one\ntwo\n", "second", "1700000060 +0000");

        assert_eq!(
            merge_base(&repo, &[first.to_string(), second.to_string()]),
            Some(first.to_string())
        );
        // A ref that does not resolve is `undefined`, as upstream's `catch` makes it.
        assert_eq!(merge_base(&repo, &[first.to_string(), "nope".to_owned()]), None);
    }

    //#endregion
}
