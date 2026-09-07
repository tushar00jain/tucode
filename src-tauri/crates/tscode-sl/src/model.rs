//! The Sapling model, ported from `CommitInfo` in `addons/isl/src/types.ts`.
//!
//! Field for field with upstream's type, restricted to what this slice fetches: diff ids,
//! stables and shelves are not here, and the template in [`crate::smartlog`] does not ask
//! for them.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Identity of an open repository — the `repoRoot` / `dotdir` pair `Repository.getRepoInfo`
/// resolves with `sl root` and `sl root --dotdir`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlRepositoryInfo {
    /// Absolute path of the checkout root.
    pub root: PathBuf,
    /// Absolute path of the `.sl` directory.
    pub dot_dir: PathBuf,
}

/// Port of `CommitPhaseType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommitPhase {
    Public,
    Draft,
}

impl CommitPhase {
    /// `sl` also has a `secret` phase, which `CommitPhaseType` does not model; ISL casts
    /// the template's output straight to its two members, and everything that is not
    /// public behaves as draft.
    pub(crate) fn parse(value: &str) -> Self {
        if value == "public" {
            Self::Public
        } else {
            Self::Draft
        }
    }
}

/// Port of `SuccessorInfo`: the commit an obsolete commit was rewritten into, and the
/// operation that rewrote it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SuccessorInfo {
    pub hash: String,
    /// `amend`, `rebase`, … — the mutation's operation name.
    #[serde(rename = "type")]
    pub kind: String,
}

/// One commit in the smartlog. Port of `CommitInfo`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlCommit {
    pub hash: String,
    /// The first line of the description.
    pub title: String,
    /// The whole commit message.
    pub description: String,
    pub author: String,
    /// Unix seconds. Upstream's `date` is a JS `Date`; see [`crate::smartlog`] for the
    /// one template formatter that differs because of it.
    pub date: i64,
    pub phase: CommitPhase,
    /// Whether this commit is `.`, the working directory's parent.
    pub is_dot: bool,
    pub parents: Vec<String>,
    /// The closest *indirect* ancestors present in the set, which is what connects nodes
    /// whose direct parents were not fetched. Empty by design when the parents are there.
    pub grandparents: Vec<String>,
    pub bookmarks: Vec<String>,
    pub remote_bookmarks: Vec<String>,
    /// The first [`crate::changed_files::MAX_FETCHED_FILES_PER_COMMIT`] paths this commit
    /// changed, and empty for a public commit — upstream skips the field there because a
    /// public commit is sometimes a codemod. Paths only: the statuses need the second read
    /// in [`crate::changed_files`].
    pub file_paths_sample: Vec<String>,
    /// How many files the commit changed, counted even where the sample is skipped.
    pub total_file_count: u32,
    /// Present only when the commit is obsolete.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub successor_info: Option<SuccessorInfo>,
    /// Closest predecessors only, never the whole rewrite chain — upstream's note is that
    /// the chain can be long enough to hurt.
    pub closest_predecessors: Vec<String>,
}

/// One repository's smartlog snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Smartlog {
    /// Absolute path of the checkout root.
    pub root: PathBuf,
    /// The registry epoch this snapshot was fetched under. If it no longer equals
    /// [`crate::SlService::epoch`] the repository set changed while it was being fetched
    /// and the caller should poll again — see [`crate::registry`].
    pub epoch: u64,
    /// In `sl`'s print order: descendants before ancestors. Nothing downstream re-sorts,
    /// so this order is part of the contract — see [`crate::smartlog`].
    pub commits: Vec<SlCommit>,
}
