//! File watching on `notify`, with stock's coalescing on top.
//!
//! `notify` reports every inotify/ReadDirectoryChangesW/FSEvents wake-up, which
//! is far more often than a tree view wants to re-render: a single editor save
//! is typically a create, several modifies and a rename. Two stages fix that:
//!
//! - **Debounce** — batch raw events into a quiet window, driven by
//!   `sleep_until` rather than a poll, and with an upper bound so a continuous
//!   stream of changes still flushes on time.
//! - **Coalesce** — [`coalesce_events`], a port of `EventCoalescer` in
//!   `vs/platform/files/common/watcher.ts`. This is what turns the batch into
//!   what stock's file service expects: one event per resource, create-then-
//!   delete cancelled out, delete-then-create flattened to a change, and the
//!   deletes of everything under a deleted folder dropped in favour of the
//!   folder's own delete.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use globset::{Glob, GlobSet, GlobSetBuilder};
use notify::event::{EventKind, ModifyKind, RenameMode};
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::error::{join_error, FsError, FsResult};
use crate::paths::{comparison_key, is_parent};
use crate::roots::ValidatedPath;
use crate::types::{is_filtered, FileChange, FileChangeType};

/// Quiet window a batch waits for before it is delivered.
pub const DEFAULT_DEBOUNCE: Duration = Duration::from_millis(100);

/// Upper bound on how long a batch may be held while events keep arriving —
/// without it, a long-running build would starve the UI of updates entirely.
pub const DEFAULT_MAX_DEBOUNCE: Duration = Duration::from_millis(500);

/// Called with each coalesced batch. The channel layer bridges it to an event.
pub type ChangeHandler = Arc<dyn Fn(Vec<FileChange>) + Send + Sync + 'static>;

/// Port of stock's `IWatchOptions`, plus the two debounce knobs.
#[derive(Debug, Clone)]
pub struct WatchOptions {
    pub recursive: bool,
    /// Glob patterns excluded from the watch. Relative patterns are matched
    /// against the path relative to the watched folder, as stock's
    /// `normalizeWatcherPattern` arranges.
    pub excludes: Vec<String>,
    /// When non-empty, only matching paths produce events.
    pub includes: Vec<String>,
    /// Stock `FileChangeFilter` bit set.
    pub filter: Option<u32>,
    pub correlation_id: Option<u32>,
    pub debounce: Duration,
    pub max_debounce: Duration,
}

impl Default for WatchOptions {
    fn default() -> Self {
        Self {
            recursive: true,
            excludes: Vec::new(),
            includes: Vec::new(),
            filter: None,
            correlation_id: None,
            debounce: DEFAULT_DEBOUNCE,
            max_debounce: DEFAULT_MAX_DEBOUNCE,
        }
    }
}

/// A live watch. Dropping it unregisters the OS watch and stops the debouncer.
pub struct FileWatcher {
    _watcher: RecommendedWatcher,
    debouncer: tokio::task::JoinHandle<()>,
}

impl Drop for FileWatcher {
    fn drop(&mut self) {
        self.debouncer.abort();
    }
}

impl FileWatcher {
    /// Starts watching `resource`, calling `handler` with each coalesced batch.
    ///
    /// `async` because the debouncer runs as a task on the caller's runtime and
    /// registering a recursive watch is a blocking walk of the tree.
    pub async fn watch(
        resource: &ValidatedPath,
        opts: WatchOptions,
        handler: ChangeHandler,
    ) -> FsResult<Self> {
        let root = resource.as_path().to_path_buf();
        let excludes = build_globset(&root, &opts.excludes)?;
        let includes = build_globset(&root, &opts.includes)?;

        let (tx, rx) = mpsc::unbounded_channel::<FileChange>();
        let correlation_id = opts.correlation_id;
        let filter = opts.filter;

        let mut watcher = RecommendedWatcher::new(
            move |result: Result<notify::Event, notify::Error>| {
                let Ok(event) = result else { return };

                for change in to_file_changes(&event, correlation_id) {
                    if is_filtered(&change, filter) {
                        continue;
                    }
                    if !matches_patterns(&change.resource, excludes.as_ref(), includes.as_ref()) {
                        continue;
                    }
                    // Only fails once the debouncer is gone, i.e. on shutdown.
                    let _ = tx.send(change);
                }
            },
            Config::default(),
        )
        .map_err(|error| FsError::unknown(format!("watcher setup failed: {error}")))?;

        let mode = if opts.recursive {
            RecursiveMode::Recursive
        } else {
            RecursiveMode::NonRecursive
        };

        // Registering a recursive watch walks the tree, so it does not belong
        // on a runtime worker thread.
        let watch_root = root.clone();
        let watcher = tokio::task::spawn_blocking(move || {
            match watcher.watch(&watch_root, mode) {
                Ok(()) => Ok(watcher),
                Err(error) => Err(FsError::unknown(format!(
                    "cannot watch {}: {error}",
                    watch_root.display()
                ))),
            }
        })
        .await
        .map_err(join_error)??;

        Ok(Self {
            _watcher: watcher,
            debouncer: tokio::spawn(debounce_loop(rx, opts, handler)),
        })
    }
}

/// Trailing-edge debounce with a hard ceiling: a batch is delivered once no
/// event has arrived for `debounce`, or `max_debounce` after the first event of
/// the batch, whichever comes first.
async fn debounce_loop(
    mut rx: mpsc::UnboundedReceiver<FileChange>,
    opts: WatchOptions,
    handler: ChangeHandler,
) {
    let mut pending: Vec<FileChange> = Vec::new();
    let mut quiet_until = Instant::now();
    let mut batch_deadline = Instant::now();

    loop {
        let deadline = quiet_until.min(batch_deadline);

        tokio::select! {
            received = rx.recv() => match received {
                Some(change) => {
                    if pending.is_empty() {
                        batch_deadline = Instant::now() + opts.max_debounce;
                    }
                    quiet_until = Instant::now() + opts.debounce;
                    pending.push(change);
                }
                None => break, // the watcher was dropped
            },
            () = tokio::time::sleep_until(deadline), if !pending.is_empty() => {
                let batch = coalesce_events(std::mem::take(&mut pending));
                if !batch.is_empty() {
                    handler(batch);
                }
            }
        }
    }

    let batch = coalesce_events(pending);
    if !batch.is_empty() {
        handler(batch);
    }
}

/// Port of `coalesceEvents` in `vs/platform/files/common/watcher.ts`.
#[must_use]
pub fn coalesce_events(changes: Vec<FileChange>) -> Vec<FileChange> {
    let mut coalescer = EventCoalescer::default();
    for change in changes {
        coalescer.process(change);
    }

    coalescer.coalesce()
}

#[derive(Default)]
struct EventCoalescer {
    coalesced: Vec<Option<FileChange>>,
    by_path: HashMap<String, usize>,
}

impl EventCoalescer {
    fn process(&mut self, event: FileChange) {
        let key = comparison_key(&event.resource);
        let mut keep = false;

        match self.by_path.get(&key).copied() {
            Some(index) => {
                let existing = self.coalesced[index]
                    .as_mut()
                    .expect("index in by_path always points at a live entry");

                if existing.resource != event.resource
                    && matches!(
                        event.change_type,
                        FileChangeType::Deleted | FileChangeType::Added
                    )
                {
                    // macOS/Windows rename to a different case: keep both the
                    // create and the delete so the old spelling disappears.
                    keep = true;
                } else {
                    match (existing.change_type, event.change_type) {
                        (FileChangeType::Added, FileChangeType::Deleted) => {
                            self.by_path.remove(&key);
                            self.coalesced[index] = None;
                        }
                        (FileChangeType::Deleted, FileChangeType::Added) => {
                            existing.change_type = FileChangeType::Updated;
                        }
                        (FileChangeType::Added, FileChangeType::Updated) => {}
                        _ => existing.change_type = event.change_type,
                    }
                }
            }
            None => keep = true,
        }

        if keep {
            self.coalesced.push(Some(event));
            self.by_path.insert(key, self.coalesced.len() - 1);
        }
    }

    /// Drops every DELETE that already has a deleted ancestor, so removing a
    /// folder yields one event rather than one per descendant.
    fn coalesce(self) -> Vec<FileChange> {
        let (mut deleted, add_or_change): (Vec<_>, Vec<_>) = self
            .coalesced
            .into_iter()
            .flatten()
            .partition(|change| change.change_type == FileChangeType::Deleted);

        // Shortest path first, so an ancestor is always recorded before its
        // descendants are tested against it.
        deleted.sort_by_key(|change| change.resource.as_os_str().len());

        let mut deleted_roots: Vec<PathBuf> = Vec::new();
        let mut result: Vec<FileChange> = Vec::new();

        for change in deleted {
            if deleted_roots
                .iter()
                .any(|root| is_parent(&change.resource, root))
            {
                continue;
            }

            deleted_roots.push(change.resource.clone());
            result.push(change);
        }

        result.extend(add_or_change);
        result
    }
}

/// Maps a `notify` event onto stock change types. A both-ends rename carries
/// two paths and becomes a delete plus an add.
fn to_file_changes(event: &notify::Event, correlation_id: Option<u32>) -> Vec<FileChange> {
    let change = |change_type: FileChangeType, resource: &Path| FileChange {
        change_type,
        resource: resource.to_path_buf(),
        correlation_id,
    };

    match event.kind {
        EventKind::Create(_) => event
            .paths
            .iter()
            .map(|path| change(FileChangeType::Added, path))
            .collect(),
        EventKind::Remove(_) => event
            .paths
            .iter()
            .map(|path| change(FileChangeType::Deleted, path))
            .collect(),
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => event
            .paths
            .iter()
            .map(|path| change(FileChangeType::Deleted, path))
            .collect(),
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => event
            .paths
            .iter()
            .map(|path| change(FileChangeType::Added, path))
            .collect(),
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => match event.paths.as_slice() {
            [from, to] => vec![
                change(FileChangeType::Deleted, from),
                change(FileChangeType::Added, to),
            ],
            paths => paths
                .iter()
                .map(|path| change(FileChangeType::Updated, path))
                .collect(),
        },
        EventKind::Modify(_) => event
            .paths
            .iter()
            .map(|path| change(FileChangeType::Updated, path))
            .collect(),
        _ => Vec::new(),
    }
}

fn build_globset(root: &Path, patterns: &[String]) -> FsResult<Option<GlobSet>> {
    if patterns.is_empty() {
        return Ok(None);
    }

    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        // Port of `normalizeWatcherPattern`: a relative pattern is anchored at
        // the watched folder.
        let absolute = if Path::new(pattern).is_absolute() {
            pattern.clone()
        } else {
            root.join(pattern).to_string_lossy().into_owned()
        };

        let glob = Glob::new(&absolute).map_err(|error| {
            FsError::unknown(format!("invalid watch pattern '{pattern}': {error}"))
        })?;
        builder.add(glob);
    }

    builder
        .build()
        .map(Some)
        .map_err(|error| FsError::unknown(format!("invalid watch patterns: {error}")))
}

fn matches_patterns(path: &Path, excludes: Option<&GlobSet>, includes: Option<&GlobSet>) -> bool {
    if excludes.is_some_and(|set| set.is_match(path)) {
        return false;
    }

    includes.map_or(true, |set| set.is_match(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(change_type: FileChangeType, path: &str) -> FileChange {
        FileChange {
            change_type,
            resource: PathBuf::from(path),
            correlation_id: None,
        }
    }

    fn root_path(segments: &[&str]) -> String {
        let joined: PathBuf = segments.iter().collect();
        format!("{}{}", std::path::MAIN_SEPARATOR, joined.display())
    }

    /// A sequence of events over one file, coalesced. The single-file rules differ only in the
    /// types that go in, so the path and the `change` calls are the helper's rather than each
    /// test's.
    fn coalesce_one_file(types: &[FileChangeType]) -> Vec<FileChange> {
        let path = root_path(&["w", "a.txt"]);
        coalesce_events(
            types
                .iter()
                .map(|change_type| change(*change_type, &path))
                .collect(),
        )
    }

    /// The one event such a sequence is left with, read as its type — which is what every rule
    /// below asserts. A sequence that left anything other than one event is that rule's failure,
    /// reported here rather than as an index panic.
    fn coalesces_to(types: &[FileChangeType]) -> FileChangeType {
        let result = coalesce_one_file(types);
        assert_eq!(result.len(), 1, "{result:?}");
        result[0].change_type
    }

    #[test]
    fn create_then_delete_cancels_out() {
        let result = coalesce_one_file(&[FileChangeType::Added, FileChangeType::Deleted]);

        assert!(result.is_empty());
    }

    #[test]
    fn delete_then_create_flattens_to_update() {
        assert_eq!(
            coalesces_to(&[FileChangeType::Deleted, FileChangeType::Added]),
            FileChangeType::Updated
        );
    }

    #[test]
    fn create_then_update_stays_a_create() {
        assert_eq!(
            coalesces_to(&[
                FileChangeType::Added,
                FileChangeType::Updated,
                FileChangeType::Updated
            ]),
            FileChangeType::Added
        );
    }

    #[test]
    fn repeated_updates_collapse_to_one() {
        assert_eq!(
            coalesces_to(&[
                FileChangeType::Updated,
                FileChangeType::Updated,
                FileChangeType::Updated
            ]),
            FileChangeType::Updated
        );
    }

    #[test]
    fn deleting_a_folder_suppresses_its_children() {
        let folder = root_path(&["w", "sub"]);
        let child = root_path(&["w", "sub", "a.txt"]);
        let deeper = root_path(&["w", "sub", "nested", "b.txt"]);
        let sibling = root_path(&["w", "other.txt"]);

        let result = coalesce_events(vec![
            change(FileChangeType::Deleted, &child),
            change(FileChangeType::Deleted, &deeper),
            change(FileChangeType::Deleted, &folder),
            change(FileChangeType::Deleted, &sibling),
        ]);

        let mut resources: Vec<_> = result
            .iter()
            .map(|change| change.resource.to_string_lossy().into_owned())
            .collect();
        resources.sort();

        let mut expected = vec![folder, sibling];
        expected.sort();

        assert_eq!(resources, expected);
    }

    #[test]
    fn adds_and_changes_survive_alongside_deletes() {
        let deleted = root_path(&["w", "gone.txt"]);
        let added = root_path(&["w", "new.txt"]);

        let result = coalesce_events(vec![
            change(FileChangeType::Deleted, &deleted),
            change(FileChangeType::Added, &added),
        ]);

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].change_type, FileChangeType::Deleted);
        assert_eq!(result[1].change_type, FileChangeType::Added);
    }

    #[test]
    fn excludes_win_over_includes() {
        let root = PathBuf::from(root_path(&["w"]));
        let excludes = build_globset(&root, &["**/node_modules/**".into()]).unwrap();
        let includes = build_globset(&root, &["**/*.ts".into()]).unwrap();

        let source = root.join("src/a.ts");
        let vendored = root.join("node_modules/pkg/a.ts");
        let other = root.join("src/a.md");

        assert!(matches_patterns(&source, excludes.as_ref(), includes.as_ref()));
        assert!(!matches_patterns(&vendored, excludes.as_ref(), includes.as_ref()));
        assert!(!matches_patterns(&other, excludes.as_ref(), includes.as_ref()));
    }

    #[test]
    fn no_patterns_matches_everything() {
        assert!(matches_patterns(Path::new("anything"), None, None));
    }
}
