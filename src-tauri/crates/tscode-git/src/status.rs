//! Status: HEAD vs index vs worktree, translated into VS Code's SCM model.
//!
//! `gix` reports the two comparisons separately — `Item::TreeIndex` is HEAD↔index (git's
//! `X` column) and `Item::IndexWorktree` is index↔worktree (the `Y` column). That is the
//! same split `Repository.getStatus` in `extensions/git/src/repository.ts` switches on, so
//! the mapping below is that function's two `switch` statements plus its merge-conflict
//! table, one arm at a time. A path changed on both sides lands in both groups, exactly as
//! upstream.
//!
//! Everything here reads through `gix`, in-process. Nothing shells out, so a repository's
//! own `core.pager` / `core.fsmonitor` / `core.sshCommand` / hooks are never consulted.

use gix::bstr::{BStr, ByteSlice};
use gix::diff::index::Change as TreeIndexChange;
use gix::dir::entry::Status as DirEntryStatus;
use gix::status::index_worktree::{Item as IndexWorktreeItem, RewriteSource};
use gix::status::plumbing::index_as_worktree::{Change as WorktreeChange, Conflict, EntryStatus};
use gix::status::tree_index::TrackRenames;
use gix::status::{Item, Submodule, UntrackedFiles};

use crate::error::{GitError, Result};
use crate::model::{
    Change, Head, RepositoryStatus, ResourceGroupType, Status, StatusOptions, UntrackedChanges,
};

/// Compute one repository's status. `epoch` is read by the caller *before* this starts, so
/// a mutation interleaving with the walk shows up as an epoch mismatch on the snapshot.
pub(crate) fn compute(
    repo: &gix::Repository,
    opts: &StatusOptions,
    epoch: u64,
) -> Result<RepositoryStatus> {
    let root = repo
        .workdir()
        .ok_or_else(|| GitError::BareRepository(repo.git_dir().to_path_buf()))?
        .to_path_buf();

    let mut out = RepositoryStatus {
        root,
        head: head(repo)?,
        epoch,
        merge: Vec::new(),
        index: Vec::new(),
        working_tree: Vec::new(),
        untracked: Vec::new(),
    };

    let rewrites = opts
        .detect_renames
        .then(gix::diff::Rewrites::default);
    let hidden = opts.untracked_changes == UntrackedChanges::Hidden;
    let emit_ignored = (opts.show_ignored && !hidden).then_some(gix::dir::walk::EmissionMode::Matching);

    let platform = repo
        .status(gix::progress::Discard)
        .map_err(GitError::gix("configure status"))?
        .untracked_files(if hidden {
            UntrackedFiles::None
        } else {
            // `Files` rather than `Collapsed`: the SCM view lists individual resources.
            UntrackedFiles::Files
        })
        .index_worktree_rewrites(rewrites)
        .index_worktree_submodules(Submodule::AsConfigured { check_dirty: true })
        .tree_index_track_renames(match rewrites {
            Some(rewrites) => TrackRenames::Given(rewrites),
            None => TrackRenames::Disabled,
        })
        .dirwalk_options(|options| {
            options
                .emit_ignored(emit_ignored)
                .recurse_repositories(false)
        });

    let mut iter = platform
        .into_iter(Vec::<gix::bstr::BString>::new())
        .map_err(GitError::gix("start status walk"))?;

    for item in iter.by_ref() {
        match item.map_err(GitError::gix("walk status"))? {
            Item::TreeIndex(change) => out.push(tree_index_change(&change)),
            Item::IndexWorktree(item) => {
                if let Some(change) = index_worktree_change(&item, opts) {
                    out.push(change);
                }
            }
        }
    }

    // `iter.outcome_mut().write_changes()` would refresh the index's stat cache and make
    // the next poll cheaper, but this index was read before a concurrent `git add` could
    // have replaced it — writing it back would drop that stage. A poll never writes.
    drop(iter);

    out.sort();
    Ok(out)
}

/// The four shapes a tree-to-tree comparison produces. `gix` has one such enum per diff
/// API — `diff::index::Change` for HEAD↔index, `diff::tree_with_rewrites::Change` for
/// commit↔commit — so each is narrowed to this and the `Status` mapping below is stated
/// once rather than per caller.
pub(crate) enum TreeChange<'a> {
    Addition(&'a BStr),
    Deletion(&'a BStr),
    Modification(&'a BStr),
    Rewrite {
        source: &'a BStr,
        location: &'a BStr,
        copy: bool,
    },
}

/// Port of `switch (raw.x)` in `Repository.getStatus` — git's `X` column, which is what a
/// tree-to-tree comparison reports whichever pair of trees it was given.
pub(crate) fn tree_change(change: TreeChange<'_>) -> Change {
    let (status, path, original_path) = match change {
        TreeChange::Addition(location) => (Status::IndexAdded, location, None),
        TreeChange::Deletion(location) => (Status::IndexDeleted, location, None),
        TreeChange::Modification(location) => (Status::IndexModified, location, None),
        TreeChange::Rewrite {
            source,
            location,
            copy,
        } => (
            if copy {
                Status::IndexCopied
            } else {
                Status::IndexRenamed
            },
            location,
            Some(text(source)),
        ),
    };

    Change {
        path: text(path),
        original_path,
        status,
        group: ResourceGroupType::Index,
    }
}

/// HEAD↔index — git's `X` column.
fn tree_index_change(change: &TreeIndexChange) -> Change {
    tree_change(match change {
        TreeIndexChange::Addition { location, .. } => TreeChange::Addition(location.as_ref()),
        TreeIndexChange::Deletion { location, .. } => TreeChange::Deletion(location.as_ref()),
        TreeIndexChange::Modification { location, .. } => {
            TreeChange::Modification(location.as_ref())
        }
        TreeIndexChange::Rewrite {
            source_location,
            location,
            copy,
            ..
        } => TreeChange::Rewrite {
            source: source_location.as_ref(),
            location: location.as_ref(),
            copy: *copy,
        },
    })
}

/// index↔worktree — git's `Y` column, plus untracked, ignored and conflicts.
/// Port of the `raw.x + raw.y` conflict table and `switch (raw.y)` in `Repository.getStatus`.
fn index_worktree_change(item: &IndexWorktreeItem, opts: &StatusOptions) -> Option<Change> {
    match item {
        IndexWorktreeItem::Modification {
            rela_path, status, ..
        } => {
            let (status, group) = match status {
                EntryStatus::Conflict { summary, .. } => {
                    (conflict_status(*summary), ResourceGroupType::Merge)
                }
                EntryStatus::Change(WorktreeChange::Removed) => {
                    (Status::Deleted, ResourceGroupType::WorkingTree)
                }
                EntryStatus::Change(WorktreeChange::Type { .. }) => {
                    (Status::TypeChanged, ResourceGroupType::WorkingTree)
                }
                EntryStatus::Change(WorktreeChange::Modification { .. })
                | EntryStatus::Change(WorktreeChange::SubmoduleModification(_)) => {
                    (Status::Modified, ResourceGroupType::WorkingTree)
                }
                EntryStatus::IntentToAdd => (Status::IntentToAdd, ResourceGroupType::WorkingTree),
                // Not a change — only a hint that the entry's stat cache is out of date.
                EntryStatus::NeedsUpdate(_) => return None,
            };
            Some(Change {
                path: text(rela_path.as_bstr()),
                original_path: None,
                status,
                group,
            })
        }

        IndexWorktreeItem::DirectoryContents { entry, .. } => {
            let status = match entry.status {
                DirEntryStatus::Untracked => Status::Untracked,
                DirEntryStatus::Ignored(_) => Status::Ignored,
                DirEntryStatus::Pruned | DirEntryStatus::Tracked => return None,
            };
            Some(Change {
                path: text(entry.rela_path.as_bstr()),
                original_path: None,
                status,
                group: untracked_group(opts.untracked_changes)?,
            })
        }

        // A tracked file disappeared and an untracked one matched its content: git's
        // worktree-column `R`, which upstream maps to INTENT_TO_RENAME.
        IndexWorktreeItem::Rewrite {
            source,
            dirwalk_entry,
            ..
        } => Some(Change {
            path: text(dirwalk_entry.rela_path.as_bstr()),
            original_path: Some(text(rewrite_source_path(source))),
            status: Status::IntentToRename,
            group: ResourceGroupType::WorkingTree,
        }),
    }
}

/// The seven conflict states, one-to-one with upstream's `DD`/`AU`/`UD`/`UA`/`DU`/`AA`/`UU`.
fn conflict_status(summary: Conflict) -> Status {
    match summary {
        Conflict::BothDeleted => Status::BothDeleted,
        Conflict::AddedByUs => Status::AddedByUs,
        Conflict::DeletedByThem => Status::DeletedByThem,
        Conflict::AddedByThem => Status::AddedByThem,
        Conflict::DeletedByUs => Status::DeletedByUs,
        Conflict::BothAdded => Status::BothAdded,
        Conflict::BothModified => Status::BothModified,
    }
}

/// Port of the `case '??'` / `case '!!'` switch on the `git.untrackedChanges` setting.
fn untracked_group(untracked_changes: UntrackedChanges) -> Option<ResourceGroupType> {
    match untracked_changes {
        UntrackedChanges::Mixed => Some(ResourceGroupType::WorkingTree),
        UntrackedChanges::Separate => Some(ResourceGroupType::Untracked),
        UntrackedChanges::Hidden => None,
    }
}

fn rewrite_source_path(source: &RewriteSource) -> &BStr {
    match source {
        RewriteSource::RewriteFromIndex {
            source_rela_path, ..
        } => source_rela_path.as_bstr(),
        RewriteSource::CopyFromDirectoryEntry {
            source_dirwalk_entry,
            ..
        } => source_dirwalk_entry.rela_path.as_bstr(),
    }
}

/// Git paths are bytes; the SCM view needs a `String`.
fn text(path: &BStr) -> String {
    path.to_str_lossy().into_owned()
}

/// The repository tip, plus how far it has diverged from its upstream.
fn head(repo: &gix::Repository) -> Result<Head> {
    let head = repo.head().map_err(GitError::gix("read HEAD"))?;

    let mut info = Head {
        detached: head.is_detached(),
        commit: head.id().map(|id| id.to_string()),
        ..Head::default()
    };

    let Some(referent) = head.referent_name() else {
        return Ok(info);
    };
    info.name = Some(referent.shorten().to_str_lossy().into_owned());

    let Some(Ok(tracking)) = repo
        .branch_remote_tracking_ref_name(referent, gix::remote::Direction::Fetch)
    else {
        return Ok(info);
    };
    info.upstream = Some(tracking.as_bstr().to_str_lossy().into_owned());

    let (Some(local), Ok(mut upstream_ref)) =
        (head.id(), repo.find_reference(tracking.as_bstr()))
    else {
        return Ok(info);
    };
    let Ok(upstream) = upstream_ref.peel_to_id() else {
        return Ok(info);
    };

    info.ahead = count_revisions(repo, local.detach(), upstream.detach());
    info.behind = count_revisions(repo, upstream.detach(), local.detach());
    Ok(info)
}

/// `git rev-list --count <tip> ^<hidden>`.
fn count_revisions(
    repo: &gix::Repository,
    tip: gix::ObjectId,
    hidden: gix::ObjectId,
) -> Option<usize> {
    Some(
        repo.rev_walk([tip])
            .with_hidden([hidden])
            .all()
            .ok()?
            // Not `Result::is_ok`: `Result` is this crate's alias, so the path would
            // fix the error type to `GitError` rather than the walk's own.
            .take_while(|info| info.is_ok())
            .count(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The seven merge cases of `Repository.getStatus`'s `raw.x + raw.y` switch, in the
    /// same order, so a flipped `Us`/`Them` arm fails here rather than in the UI.
    #[test]
    fn conflicts_map_to_upstreams_merge_states() {
        let cases = [
            (Conflict::BothDeleted, Status::BothDeleted),
            (Conflict::AddedByUs, Status::AddedByUs),
            (Conflict::DeletedByThem, Status::DeletedByThem),
            (Conflict::AddedByThem, Status::AddedByThem),
            (Conflict::DeletedByUs, Status::DeletedByUs),
            (Conflict::BothAdded, Status::BothAdded),
            (Conflict::BothModified, Status::BothModified),
        ];
        for (conflict, expected) in cases {
            assert_eq!(conflict_status(conflict), expected);
            assert!(expected.is_conflict());
        }
    }

    #[test]
    fn untracked_changes_setting_picks_the_group() {
        assert_eq!(
            untracked_group(UntrackedChanges::Mixed),
            Some(ResourceGroupType::WorkingTree)
        );
        assert_eq!(
            untracked_group(UntrackedChanges::Separate),
            Some(ResourceGroupType::Untracked)
        );
        assert_eq!(untracked_group(UntrackedChanges::Hidden), None);
    }

    /// Port of `Resource.getStatusLetter`.
    #[test]
    fn status_letters_match_upstream() {
        assert_eq!(Status::IndexModified.letter(), "M");
        assert_eq!(Status::IntentToAdd.letter(), "A");
        assert_eq!(Status::IndexCopied.letter(), "C");
        assert_eq!(Status::TypeChanged.letter(), "T");
        assert_eq!(Status::Untracked.letter(), "U");
        assert_eq!(Status::Ignored.letter(), "I");
        for conflict in [
            Status::BothDeleted,
            Status::AddedByUs,
            Status::DeletedByThem,
            Status::AddedByThem,
            Status::DeletedByUs,
            Status::BothAdded,
            Status::BothModified,
        ] {
            assert_eq!(conflict.letter(), "!");
        }
    }
}
