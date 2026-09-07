//! The SCM model, ported from VS Code's git extension.
//!
//! `Status` and `ResourceGroupType` are `extensions/git/src/api/git.d.ts` and
//! `extensions/git/src/repository.ts` respectively, kept variant-for-variant so the
//! workbench SCM view's grouping, decorations and letters come out right without
//! re-deriving them from how the UI looks.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Per-file change kind. Port of `Status` in `extensions/git/src/api/git.d.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Status {
    IndexModified,
    IndexAdded,
    IndexDeleted,
    IndexRenamed,
    IndexCopied,

    Modified,
    Deleted,
    Untracked,
    Ignored,
    IntentToAdd,
    IntentToRename,
    TypeChanged,

    AddedByUs,
    AddedByThem,
    DeletedByUs,
    DeletedByThem,
    BothAdded,
    BothDeleted,
    BothModified,
}

impl Status {
    /// The single-letter decoration VS Code renders on a tree row.
    /// Port of `Resource.getStatusLetter` in `extensions/git/src/repository.ts`.
    pub fn letter(self) -> &'static str {
        match self {
            Status::IndexModified | Status::Modified => "M",
            Status::IndexAdded | Status::IntentToAdd => "A",
            Status::IndexDeleted | Status::Deleted => "D",
            Status::IndexRenamed | Status::IntentToRename => "R",
            Status::IndexCopied => "C",
            Status::Untracked => "U",
            Status::Ignored => "I",
            Status::TypeChanged => "T",
            // Using ! instead of ⚠, because the latter looks really bad on windows.
            Status::BothDeleted
            | Status::AddedByUs
            | Status::DeletedByThem
            | Status::AddedByThem
            | Status::DeletedByUs
            | Status::BothAdded
            | Status::BothModified => "!",
        }
    }

    /// `true` for the seven conflict states, which live in the merge group.
    pub fn is_conflict(self) -> bool {
        matches!(
            self,
            Status::AddedByUs
                | Status::AddedByThem
                | Status::DeletedByUs
                | Status::DeletedByThem
                | Status::BothAdded
                | Status::BothDeleted
                | Status::BothModified
        )
    }
}

/// Which resource group a change belongs to.
/// Port of `ResourceGroupType` in `extensions/git/src/repository.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResourceGroupType {
    Merge,
    Index,
    WorkingTree,
    Untracked,
}

/// One changed path in one group. Port of `Change` in `extensions/git/src/api/git.d.ts`,
/// with repository-relative forward-slash paths instead of URIs — T6 turns these into URIs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    /// Repository-relative path, forward slashes, of the resource as it exists now.
    pub path: String,
    /// For renames and copies, the repository-relative path it came from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    pub status: Status,
    pub group: ResourceGroupType,
}

/// The `git.untrackedChanges` setting. Port of the same three-way switch in
/// `Repository.getStatus` (`extensions/git/src/repository.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UntrackedChanges {
    /// Untracked and ignored resources join the working-tree group.
    #[default]
    Mixed,
    /// They get their own group.
    Separate,
    /// They are not reported at all.
    Hidden,
}

/// What to include in a status query.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StatusOptions {
    pub untracked_changes: UntrackedChanges,
    /// Ignored files cost a full walk of ignored directories; off by default, as in `git status`.
    pub show_ignored: bool,
    /// Rename/copy detection, both HEAD↔index and index↔worktree.
    pub detect_renames: bool,
}

impl Default for StatusOptions {
    fn default() -> Self {
        Self {
            untracked_changes: UntrackedChanges::default(),
            show_ignored: false,
            detect_renames: true,
        }
    }
}

/// The tip of the repository. Port of the fields of `Branch` in `api/git.d.ts` that the
/// SCM view actually renders (name, commit, and the sync counts on the status bar).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Head {
    /// Short branch name, or `None` when detached or unborn.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Hex object id of the commit at HEAD, or `None` on an unborn branch.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    pub detached: bool,
    /// Full name of the remote-tracking ref, e.g. `refs/remotes/origin/main`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    /// Commits on HEAD that the upstream does not have.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ahead: Option<usize>,
    /// Commits on the upstream that HEAD does not have.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behind: Option<usize>,
}

/// One repository's contribution to the multi-repo SCM view.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryStatus {
    /// Absolute path of the working tree root.
    pub root: PathBuf,
    pub head: Head,
    /// The registry epoch this snapshot was computed under. If it no longer equals
    /// [`crate::GitService::epoch`], a mutation landed while it was being computed and
    /// the caller should poll again — see [`crate::registry`].
    pub epoch: u64,
    pub merge: Vec<Change>,
    pub index: Vec<Change>,
    pub working_tree: Vec<Change>,
    /// Populated only under [`UntrackedChanges::Separate`].
    pub untracked: Vec<Change>,
}

impl RepositoryStatus {
    /// Push a change into the group named on it. The four vectors mirror
    /// `Repository.getStatus`'s `indexGroup` / `mergeGroup` / `untrackedGroup` /
    /// `workingTreeGroup` locals.
    pub(crate) fn push(&mut self, change: Change) {
        match change.group {
            ResourceGroupType::Merge => self.merge.push(change),
            ResourceGroupType::Index => self.index.push(change),
            ResourceGroupType::WorkingTree => self.working_tree.push(change),
            ResourceGroupType::Untracked => self.untracked.push(change),
        }
    }

    /// Sort every group by path so two consecutive polls of an unchanged repository
    /// produce equal snapshots — `gix`'s parallel status has no defined output order.
    pub(crate) fn sort(&mut self) {
        for group in [
            &mut self.merge,
            &mut self.index,
            &mut self.working_tree,
            &mut self.untracked,
        ] {
            group.sort_by(|a, b| a.path.cmp(&b.path));
        }
    }
}

/// Identity of an open repository, for the frontend's repository picker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryInfo {
    /// Absolute path of the working tree root.
    pub root: PathBuf,
    /// Absolute path of the `.git` directory (or file, for worktrees and submodules).
    pub git_dir: PathBuf,
}
