//! Diff for a path, and file content at a revision.
//!
//! Both read through `gix`: blobs come from the object database and the index in-process,
//! and the unified rendering is `gix::diff::blob` (imara-diff with git's slider heuristics),
//! so the hunks match what `git diff` prints.

use std::path::Path;

use gix::bstr::ByteSlice;
use gix::diff::blob::unified_diff::{ConsumeHunk, ContextSize, DiffLineKind, HunkHeader};
use gix::diff::blob::{Algorithm, InternedInput, UnifiedDiff, diff_with_slider_heuristics};
use gix::index::entry::Stage;
use serde::{Deserialize, Serialize};

use crate::error::{GitError, Result};

/// Which pair of versions to compare. The names are the two halves of git's status
/// columns, so they line up with [`crate::model::ResourceGroupType`]: a resource in the
/// index group diffs [`DiffSource::HeadToIndex`], one in the working tree group diffs
/// [`DiffSource::IndexToWorktree`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffSource {
    /// Staged changes.
    HeadToIndex,
    /// Unstaged changes.
    #[default]
    IndexToWorktree,
    /// Everything, staged or not.
    HeadToWorktree,
}

/// The two sides of a diff, either of which may be absent (added or deleted file).
struct Sides {
    before: Option<Vec<u8>>,
    after: Option<Vec<u8>>,
}

/// A unified diff of one repository-relative path, or an empty string if the two sides
/// are identical.
pub(crate) fn unified(
    repo: &gix::Repository,
    rela_path: &str,
    source: DiffSource,
    context: u32,
) -> Result<String> {
    let sides = match source {
        DiffSource::HeadToIndex => Sides {
            before: head_blob(repo, rela_path)?,
            after: index_blob(repo, rela_path)?,
        },
        DiffSource::IndexToWorktree => Sides {
            before: index_blob(repo, rela_path)?,
            after: worktree_blob(repo, rela_path)?,
        },
        DiffSource::HeadToWorktree => Sides {
            before: head_blob(repo, rela_path)?,
            after: worktree_blob(repo, rela_path)?,
        },
    };

    let before = sides.before.unwrap_or_default();
    let after = sides.after.unwrap_or_default();
    if before == after {
        return Ok(String::new());
    }
    if is_binary(&before) || is_binary(&after) {
        return Ok(format!("Binary files a/{rela_path} and b/{rela_path} differ\n"));
    }

    let input = InternedInput::new(before.as_slice(), after.as_slice());
    let diff = diff_with_slider_heuristics(Algorithm::Histogram, &input);

    let mut out = format!("--- a/{rela_path}\n+++ b/{rela_path}\n");
    let hunks = UnifiedDiff::new(
        &diff,
        &input,
        UnifiedText::default(),
        ContextSize::symmetrical(context),
    )
    .consume()
    .map_err(|source| GitError::Io {
        path: Path::new(rela_path).to_path_buf(),
        source,
    })?;
    out.push_str(&hunks);
    Ok(out)
}

/// Renders hunks in unified format. `gix` hands us the header and the classified lines;
/// this only writes the `@@` line and the `+`/`-`/` ` prefixes.
#[derive(Default)]
struct UnifiedText {
    out: String,
}

impl ConsumeHunk for UnifiedText {
    type Out = String;

    fn consume_hunk(
        &mut self,
        header: HunkHeader,
        lines: &[(DiffLineKind, &[u8])],
    ) -> std::io::Result<()> {
        self.out.push_str(&format!(
            "@@ -{},{} +{},{} @@\n",
            header.before_hunk_start,
            header.before_hunk_len,
            header.after_hunk_start,
            header.after_hunk_len
        ));
        for (kind, line) in lines {
            self.out.push(match kind {
                DiffLineKind::Context => ' ',
                DiffLineKind::Add => '+',
                DiffLineKind::Remove => '-',
            });
            self.out.push_str(&line.to_str_lossy());
            if !line.ends_with(b"\n") {
                self.out.push_str("\n\\ No newline at end of file\n");
            }
        }
        Ok(())
    }

    fn finish(self) -> Self::Out {
        self.out
    }
}

/// The bytes of `rela_path` at `rev`. This is what the diff editor's left-hand side reads.
///
/// `rev` is any revspec (`HEAD`, a sha, `origin/main~2`), or one of the index spellings
/// `git show` itself accepts: the empty string is stage 0, and `:1`/`:2`/`:3` are the merge
/// stages. VS Code's git extension addresses a `git:` URI's left-hand side with exactly
/// those, so the whole set is served here rather than only the tree-ish half.
pub(crate) fn show(repo: &gix::Repository, rev: &str, rela_path: &str) -> Result<Vec<u8>> {
    if let Some(stage) = index_stage(rev) {
        return index_blob_at_stage(repo, rela_path, stage)?.ok_or_else(|| {
            GitError::NoSuchEntry {
                path: rela_path.to_owned(),
                location: "index",
            }
        });
    }

    let tree = repo
        .rev_parse_single(rev)
        .map_err(GitError::gix("resolve revision"))?
        .object()
        .map_err(GitError::gix("read revision"))?
        .peel_to_tree()
        .map_err(GitError::gix("peel revision to tree"))?;

    blob_from_tree(repo, &tree, rela_path)?.ok_or_else(|| GitError::NoSuchEntry {
        path: rela_path.to_owned(),
        location: "revision",
    })
}

fn head_blob(repo: &gix::Repository, rela_path: &str) -> Result<Option<Vec<u8>>> {
    let Ok(tree) = repo.head_tree() else {
        // Unborn branch: everything in the index is an addition.
        return Ok(None);
    };
    blob_from_tree(repo, &tree, rela_path)
}

fn blob_from_tree(
    repo: &gix::Repository,
    tree: &gix::Tree<'_>,
    rela_path: &str,
) -> Result<Option<Vec<u8>>> {
    let Some(entry) = tree
        .lookup_entry_by_path(rela_path)
        .map_err(GitError::gix("look up path in tree"))?
    else {
        return Ok(None);
    };
    if !entry.mode().is_blob() {
        return Ok(None);
    }
    read_blob(repo, entry.object_id())
}

/// The index stage `rev` names, if it names one at all. Empty is stage 0, as it is to
/// `git show :path`; `:1`/`:2`/`:3` are base/ours/theirs of a conflict.
fn index_stage(rev: &str) -> Option<Stage> {
    match rev {
        "" => Some(Stage::Unconflicted),
        ":1" => Some(Stage::Base),
        ":2" => Some(Stage::Ours),
        ":3" => Some(Stage::Theirs),
        _ => None,
    }
}

fn index_blob(repo: &gix::Repository, rela_path: &str) -> Result<Option<Vec<u8>>> {
    index_blob_at_stage(repo, rela_path, Stage::Unconflicted)
}

fn index_blob_at_stage(
    repo: &gix::Repository,
    rela_path: &str,
    stage: Stage,
) -> Result<Option<Vec<u8>>> {
    let index = repo.index_or_empty().map_err(GitError::gix("read index"))?;
    let Some(entry) = index.entry_by_path_and_stage(rela_path.into(), stage) else {
        return Ok(None);
    };
    read_blob(repo, entry.id)
}

pub(crate) fn read_blob(repo: &gix::Repository, id: gix::ObjectId) -> Result<Option<Vec<u8>>> {
    let mut blob = repo
        .find_object(id)
        .map_err(GitError::gix("read blob"))?
        .into_blob();
    Ok(Some(blob.take_data()))
}

fn worktree_blob(repo: &gix::Repository, rela_path: &str) -> Result<Option<Vec<u8>>> {
    let Some(path) = repo.workdir_path(rela_path) else {
        return Err(GitError::BareRepository(repo.git_dir().to_path_buf()));
    };
    match std::fs::read(&path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(GitError::Io { path, source }),
    }
}

/// Git's own heuristic: a NUL in the first 8000 bytes means binary.
pub(crate) fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|byte| *byte == 0)
}
