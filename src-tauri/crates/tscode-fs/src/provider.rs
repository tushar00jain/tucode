//! Port of `vs/platform/files/node/diskFileSystemProvider.ts`.
//!
//! Same method set, same option flags, same error codes, same ordering of the
//! checks each operation makes. The differences are listed in the crate docs.
//!
//! Every method takes [`ValidatedPath`], so a path can only reach a syscall
//! after [`WorkspaceRoots::validate`] has cleared it.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::blocking::run as blocking;
use crate::error::{FsError, FsResult};
use crate::locks::{ResourceLock, ResourceLocks};
use crate::paths::paths_equal;
use crate::roots::{ValidatedPath, WorkspaceRoots};
use crate::types::{
    is_path_case_sensitive, provider_capabilities, DeleteOptions, FilePermission, FileType,
    OpenOptions, OverwriteOptions, ReadOptions, Stat, WriteOptions,
};

/// Stock retries a failing write three times, 100 ms apart, because the target
/// has already been truncated at that point and giving up leaves it empty.
const WRITE_RETRY_DELAY: Duration = Duration::from_millis(100);
const WRITE_RETRIES: usize = 3;

/// Upper bound on one handle read. Stock's client hands `read` a buffer it
/// already allocated (256 KB chunks); here the length arrives from the webview,
/// so it needs a ceiling before it becomes a `vec![0; n]`.
const MAX_READ_LENGTH: usize = 16 * 1024 * 1024;

/// Port of stock's `DiskFileSystemProvider.canFlush`: some exotic filesystems
/// fail `fdatasync`, and stock disables flushing process-wide on the first
/// failure rather than failing every subsequent close.
static CAN_FLUSH: AtomicBool = AtomicBool::new(true);

/// An open file handle. Stock exposes node file descriptors; we hand out our
/// own ids so a stale id from the webview can never name a real descriptor.
pub type FileHandle = u64;

struct OpenFile {
    file: Arc<File>,
    path: PathBuf,
    is_write: bool,
    /// Held for the lifetime of a write handle; released on `close`.
    _lock: Option<ResourceLock>,
}

/// The disk file system provider.
pub struct DiskFileSystemProvider {
    roots: WorkspaceRoots,
    locks: ResourceLocks,
    handles: Mutex<HashMap<FileHandle, OpenFile>>,
    next_handle: AtomicU64,
}

impl DiskFileSystemProvider {
    #[must_use]
    pub fn new(roots: WorkspaceRoots) -> Self {
        Self {
            roots,
            locks: ResourceLocks::new(),
            handles: Mutex::new(HashMap::new()),
            next_handle: AtomicU64::new(1),
        }
    }

    /// The workspace roots this provider validates against. Callers validate a
    /// path here before passing it to any method below.
    #[must_use]
    pub fn roots(&self) -> &WorkspaceRoots {
        &self.roots
    }

    /// Stock's `get capabilities()`.
    #[must_use]
    pub fn capabilities(&self) -> u32 {
        provider_capabilities()
    }

    // ── File metadata resolving ──────────────────────────────────────

    pub async fn stat(&self, resource: &ValidatedPath) -> FsResult<Stat> {
        let path = resource.as_path().to_path_buf();
        blocking(move || stat_sync(&path)).await
    }

    pub async fn realpath(&self, resource: &ValidatedPath) -> FsResult<PathBuf> {
        let path = resource.as_path().to_path_buf();
        blocking(move || {
            dunce::canonicalize(&path).map_err(|error| FsError::from_io(&path, &error))
        })
        .await
    }

    /// Stock resolves the target type of every symlink child and swallows
    /// per-entry errors, which are routine on directories the user cannot fully
    /// read.
    pub async fn readdir(&self, resource: &ValidatedPath) -> FsResult<Vec<(String, FileType)>> {
        let path = resource.as_path().to_path_buf();
        blocking(move || {
            let entries =
                fs::read_dir(&path).map_err(|error| FsError::from_io(&path, &error))?;

            let mut result = Vec::new();
            for entry in entries {
                let Ok(entry) = entry else { continue };
                let Ok(file_type) = entry.file_type() else {
                    continue;
                };

                let child_type = if file_type.is_symlink() {
                    match stat_sync(&entry.path()) {
                        Ok(stat) => stat.file_type,
                        Err(error) => {
                            log::trace!("readdir: skipping {}: {error}", entry.path().display());
                            continue;
                        }
                    }
                } else if file_type.is_file() {
                    FileType::FILE
                } else if file_type.is_dir() {
                    FileType::DIRECTORY
                } else {
                    FileType::UNKNOWN
                };

                result.push((entry.file_name().to_string_lossy().into_owned(), child_type));
            }

            Ok(result)
        })
        .await
    }

    // ── File reading / writing ───────────────────────────────────────

    /// `opts.atomic` serialises the read against in-process writes to the same
    /// resource, so a read right after a change event cannot observe a partial
    /// file.
    pub async fn read_file(
        &self,
        resource: &ValidatedPath,
        opts: ReadOptions,
    ) -> FsResult<Vec<u8>> {
        let _lock = if opts.atomic {
            Some(self.locks.acquire(resource.as_path()).await)
        } else {
            None
        };

        let path = resource.as_path().to_path_buf();
        blocking(move || fs::read(&path).map_err(|error| FsError::from_io(&path, &error))).await
    }

    /// Port of stock `writeFile`: takes the atomic path when a postfix is given
    /// and the target is not a symlink, otherwise writes in place.
    pub async fn write_file(
        &self,
        resource: &ValidatedPath,
        content: Vec<u8>,
        opts: WriteOptions,
    ) -> FsResult<()> {
        if let Some(atomic) = opts.atomic.clone() {
            if self.can_write_file_atomic(resource).await {
                let temp = self
                    .roots
                    .validate(resource.sibling_path(&atomic.postfix))
                    .await?;

                return self.write_file_atomic(resource, &temp, content, opts).await;
            }
        }

        let _lock = self.locks.acquire(resource.as_path()).await;
        self.do_write_file(resource, content, &opts).await
    }

    /// Atomic writes rename over the target, and a rename is only atomic within
    /// one filesystem — a symlink may point at another one. Stock ignores stat
    /// failures here and writes atomically anyway.
    async fn can_write_file_atomic(&self, resource: &ValidatedPath) -> bool {
        let path = resource.as_path().to_path_buf();

        let is_symlink = blocking(move || {
            Ok(fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink()))
        })
        .await
        .unwrap_or(false);

        !is_symlink
    }

    /// Port of `doWriteFileAtomic`: write the temporary sibling, then rename it
    /// over the target so a reader never observes a half-written file.
    async fn write_file_atomic(
        &self,
        resource: &ValidatedPath,
        temp: &ValidatedPath,
        content: Vec<u8>,
        opts: WriteOptions,
    ) -> FsResult<()> {
        let _locks = self
            .locks
            .acquire_pair(resource.as_path(), temp.as_path())
            .await;

        let temp_opts = WriteOptions {
            create: true,
            overwrite: true,
            atomic: None,
            ..opts
        };
        self.do_write_file(temp, content, &temp_opts).await?;

        match self
            .do_rename(temp, resource, OverwriteOptions { overwrite: true })
            .await
        {
            Ok(()) => Ok(()),
            Err(error) => {
                // Leaving the temporary file behind would make the next atomic
                // write to the same resource start from someone else's bytes.
                let _ = self.do_delete(temp, &DeleteOptions::default()).await;
                Err(error)
            }
        }
    }

    /// Port of `doWriteFile`: validate the target against `create` / `overwrite`,
    /// then open and write the whole buffer at position 0.
    async fn do_write_file(
        &self,
        resource: &ValidatedPath,
        content: Vec<u8>,
        opts: &WriteOptions,
    ) -> FsResult<()> {
        if !opts.create || !opts.overwrite {
            let path = resource.as_path().to_path_buf();
            let exists = blocking(move || Ok(path.symlink_metadata().is_ok())).await?;

            if exists {
                if !opts.overwrite {
                    return Err(FsError::exists(format!(
                        "{}: file already exists",
                        resource.as_path().display()
                    )));
                }
            } else if !opts.create {
                return Err(FsError::not_found(format!(
                    "{}: file does not exist",
                    resource.as_path().display()
                )));
            }
        }

        let handle = self
            .open_unlocked(
                resource,
                OpenOptions {
                    create: true,
                    append: opts.append,
                    unlock: opts.unlock,
                },
            )
            .await?;

        let result = self.write(handle, 0, &content).await.map(|_| ());
        let closed = self.close(handle).await;

        result.and(closed)
    }

    // ── Handle based API ─────────────────────────────────────────────

    /// Opens `resource`. Write opens take the resource lock for the lifetime of
    /// the handle, so two concurrent writers to one file cannot interleave.
    pub async fn open(&self, resource: &ValidatedPath, opts: OpenOptions) -> FsResult<FileHandle> {
        let lock = if opts.is_for_write() {
            Some(self.locks.acquire(resource.as_path()).await)
        } else {
            None
        };

        self.do_open(resource, opts, lock).await
    }

    /// The variant `do_write_file` uses: the caller already holds the lock, and
    /// taking it again on the same task would deadlock.
    async fn open_unlocked(
        &self,
        resource: &ValidatedPath,
        opts: OpenOptions,
    ) -> FsResult<FileHandle> {
        self.do_open(resource, opts, None).await
    }

    async fn do_open(
        &self,
        resource: &ValidatedPath,
        opts: OpenOptions,
        lock: Option<ResourceLock>,
    ) -> FsResult<FileHandle> {
        let path = resource.as_path().to_path_buf();
        let file = blocking(move || open_sync(&path, opts)).await?;

        let handle = self.next_handle.fetch_add(1, Ordering::Relaxed);
        self.handles_mut().insert(
            handle,
            OpenFile {
                file: Arc::new(file),
                path: resource.as_path().to_path_buf(),
                is_write: opts.is_for_write(),
                _lock: lock,
            },
        );

        Ok(handle)
    }

    /// Closes the handle, flushing first if it was opened for writing.
    pub async fn close(&self, handle: FileHandle) -> FsResult<()> {
        let Some(open) = self.handles_mut().remove(&handle) else {
            return Err(FsError::unknown(format!("unknown file handle: {handle}")));
        };

        if !open.is_write || !CAN_FLUSH.load(Ordering::Relaxed) {
            return Ok(());
        }

        let file = Arc::clone(&open.file);
        let path = open.path.clone();
        blocking(move || {
            if let Err(error) = file.sync_data() {
                CAN_FLUSH.store(false, Ordering::Relaxed);
                log::error!("close: flush failed for {}, disabling flush: {error}", path.display());
            }
            Ok(())
        })
        .await
    }

    /// Reads up to `length` bytes from `pos`. Stock fills a caller-supplied
    /// buffer and returns the count; the buffer has to be serialised back over
    /// the channel either way, so we return the bytes read.
    pub async fn read(&self, handle: FileHandle, pos: u64, length: usize) -> FsResult<Vec<u8>> {
        if length > MAX_READ_LENGTH {
            return Err(FsError::new(
                crate::error::FileSystemProviderErrorCode::FileTooLarge,
                format!("read of {length} bytes exceeds the {MAX_READ_LENGTH} byte limit"),
            ));
        }

        let (file, path) = self.resolve_handle(handle)?;

        blocking(move || {
            let mut buffer = vec![0u8; length];
            let read = read_at(&file, &mut buffer, pos)
                .map_err(|error| FsError::from_io(&path, &error))?;
            buffer.truncate(read);
            Ok(buffer)
        })
        .await
    }

    /// Writes `data` at `pos`, retrying as stock does: the target is already
    /// truncated by this point, so giving up on the first failure would leave
    /// an empty file behind.
    pub async fn write(&self, handle: FileHandle, pos: u64, data: &[u8]) -> FsResult<usize> {
        let mut last_error = None;

        for attempt in 0..=WRITE_RETRIES {
            if attempt > 0 {
                tokio::time::sleep(WRITE_RETRY_DELAY).await;
            }

            match self.do_write(handle, pos, data).await {
                Ok(written) => return Ok(written),
                Err(error) => last_error = Some(error),
            }
        }

        Err(last_error.unwrap_or_else(|| FsError::unknown("write failed")))
    }

    async fn do_write(&self, handle: FileHandle, pos: u64, data: &[u8]) -> FsResult<usize> {
        let (file, path) = self.resolve_handle(handle)?;
        let data = data.to_vec();

        blocking(move || {
            write_at(&file, &data, pos).map_err(|error| FsError::from_io_write(&path, &error))
        })
        .await
    }

    // ── Move / copy / delete / create folder ─────────────────────────

    /// Stock's `mkdir` is deliberately non-recursive; the file service creates
    /// intermediate folders itself.
    pub async fn mkdir(&self, resource: &ValidatedPath) -> FsResult<()> {
        let path = resource.as_path().to_path_buf();
        blocking(move || fs::create_dir(&path).map_err(|error| FsError::from_io(&path, &error)))
            .await
    }

    pub async fn delete(&self, resource: &ValidatedPath, opts: DeleteOptions) -> FsResult<()> {
        let move_to = match (&opts.atomic, opts.recursive) {
            (Some(atomic), true) => Some(
                self.roots
                    .validate(resource.sibling_path(&atomic.postfix))
                    .await?,
            ),
            _ => None,
        };

        let path = resource.as_path().to_path_buf();
        let move_to = move_to.map(ValidatedPath::into_path_buf);
        let recursive = opts.recursive;

        blocking(move || delete_sync(&path, recursive, move_to.as_deref())).await
    }

    async fn do_delete(&self, resource: &ValidatedPath, opts: &DeleteOptions) -> FsResult<()> {
        self.delete(resource, opts.clone()).await
    }

    pub async fn rename(
        &self,
        from: &ValidatedPath,
        to: &ValidatedPath,
        opts: OverwriteOptions,
    ) -> FsResult<()> {
        self.do_rename(from, to, opts).await
    }

    async fn do_rename(
        &self,
        from: &ValidatedPath,
        to: &ValidatedPath,
        opts: OverwriteOptions,
    ) -> FsResult<()> {
        if from.as_path() == to.as_path() {
            return Ok(()); // stock no-ops when the paths match
        }

        self.validate_move_copy(from, to, MoveCopyMode::Move, opts.overwrite)
            .await?;

        let (from_path, to_path) = (
            from.as_path().to_path_buf(),
            to.as_path().to_path_buf(),
        );

        blocking(move || {
            fs::rename(&from_path, &to_path)
                .map_err(|error| FsError::from_io(&from_path, &error))
        })
        .await
    }

    pub async fn copy(
        &self,
        from: &ValidatedPath,
        to: &ValidatedPath,
        opts: OverwriteOptions,
    ) -> FsResult<()> {
        if from.as_path() == to.as_path() {
            return Ok(());
        }

        self.validate_move_copy(from, to, MoveCopyMode::Copy, opts.overwrite)
            .await?;

        let (from_path, to_path) = (
            from.as_path().to_path_buf(),
            to.as_path().to_path_buf(),
        );

        blocking(move || copy_recursive(&from_path, &to_path)).await
    }

    /// Port of stock's `cloneFile`: a plain file copy with both resources
    /// locked, creating the target's parent folders only if the first attempt
    /// says they are missing.
    pub async fn clone_file(&self, from: &ValidatedPath, to: &ValidatedPath) -> FsResult<()> {
        if paths_equal(from.as_path(), to.as_path()) {
            return Ok(());
        }

        let _locks = self
            .locks
            .acquire_pair(from.as_path(), to.as_path())
            .await;

        let (from_path, to_path) = (
            from.as_path().to_path_buf(),
            to.as_path().to_path_buf(),
        );

        blocking(move || {
            match fs::copy(&from_path, &to_path) {
                Ok(_) => Ok(()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    if let Some(parent) = to_path.parent() {
                        fs::create_dir_all(parent)
                            .map_err(|error| FsError::from_io(parent, &error))?;
                    }
                    fs::copy(&from_path, &to_path)
                        .map(|_| ())
                        .map_err(|error| FsError::from_io(&from_path, &error))
                }
                Err(error) => Err(FsError::from_io(&from_path, &error)),
            }
        })
        .await
    }

    /// Not stock's: the stock provider has no `chmod` because `IFileService`
    /// exposes none — the one caller that needs it, the zsh shell-integration
    /// injection, runs in the pty host and calls `fs.chmod` directly. It gives
    /// `$ZDOTDIR` mode `0o1700`, so on a shared `/tmp` no other user can replace
    /// the scripts the shell is about to source.
    pub async fn chmod(&self, resource: &ValidatedPath, mode: u32) -> FsResult<()> {
        let path = resource.as_path().to_path_buf();
        blocking(move || {
            chmod_sync(&path, mode).map_err(|error| FsError::from_io(&path, &error))
        })
        .await
    }

    /// Port of `validateMoveCopy`.
    async fn validate_move_copy(
        &self,
        from: &ValidatedPath,
        to: &ValidatedPath,
        mode: MoveCopyMode,
        overwrite: bool,
    ) -> FsResult<()> {
        if !is_path_case_sensitive() && paths_equal(from.as_path(), to.as_path()) {
            return match mode {
                // A case-insensitive filesystem cannot hold both spellings.
                MoveCopyMode::Copy => Err(FsError::exists(
                    "file cannot be copied to same path with different path case",
                )),
                MoveCopyMode::Move => Ok(()),
            };
        }

        let Some(from_stat) = self.stat_ignore_error(from).await else {
            return Err(FsError::not_found(format!(
                "{}: file to move/copy does not exist",
                from.as_path().display()
            )));
        };

        let Some(to_stat) = self.stat_ignore_error(to).await else {
            return Ok(()); // target free
        };

        if !overwrite {
            return Err(FsError::exists(format!(
                "{}: file at target already exists and will not be overwritten",
                to.as_path().display()
            )));
        }

        // A file replacing a file is handled by `rename` / `copy` themselves;
        // anything else has to be cleared first.
        if from_stat.file_type.contains(FileType::FILE) && to_stat.file_type.contains(FileType::FILE)
        {
            return Ok(());
        }

        self.do_delete(
            to,
            &DeleteOptions {
                recursive: true,
                use_trash: false,
                atomic: None,
            },
        )
        .await
    }

    async fn stat_ignore_error(&self, resource: &ValidatedPath) -> Option<Stat> {
        self.stat(resource).await.ok()
    }

    fn resolve_handle(&self, handle: FileHandle) -> FsResult<(Arc<File>, PathBuf)> {
        self.handles_mut()
            .get(&handle)
            .map(|open| (Arc::clone(&open.file), open.path.clone()))
            .ok_or_else(|| FsError::unknown(format!("unknown file handle: {handle}")))
    }

    fn handles_mut(&self) -> std::sync::MutexGuard<'_, HashMap<FileHandle, OpenFile>> {
        self.handles
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MoveCopyMode {
    Move,
    Copy,
}

// ── Blocking helpers ─────────────────────────────────────────────────

/// Port of stock's `stat()`, which uses `SymlinkSupport.stat` so a symlink
/// reports the type of what it points at while still flagging itself as a link.
fn stat_sync(path: &Path) -> FsResult<Stat> {
    let link_meta =
        fs::symlink_metadata(path).map_err(|error| FsError::from_io(path, &error))?;
    let is_symlink = link_meta.file_type().is_symlink();

    let (meta, dangling) = if is_symlink {
        match fs::metadata(path) {
            Ok(target) => (target, false),
            Err(_) => (link_meta, true),
        }
    } else {
        (link_meta, false)
    };

    let mut file_type = if dangling {
        FileType::UNKNOWN
    } else if meta.is_file() {
        FileType::FILE
    } else if meta.is_dir() {
        FileType::DIRECTORY
    } else {
        FileType::UNKNOWN
    };

    if is_symlink {
        file_type = file_type | FileType::SYMBOLIC_LINK;
    }

    Ok(Stat {
        file_type,
        mtime: millis_since_epoch(meta.modified().ok()),
        // Stock deliberately uses birth time, not `ctime`.
        ctime: millis_since_epoch(meta.created().ok()),
        size: meta.len(),
        permissions: file_permissions(&meta),
    })
}

fn millis_since_epoch(time: Option<SystemTime>) -> u64 {
    time.and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

#[cfg(unix)]
fn file_permissions(meta: &fs::Metadata) -> Option<FilePermission> {
    use std::os::unix::fs::MetadataExt;

    let mode = meta.mode();
    let mut permissions = None;

    if mode & 0o200 == 0 {
        permissions = Some(FilePermission::LOCKED);
    }
    if mode & 0o111 != 0 {
        permissions = Some(match permissions {
            Some(existing) => existing | FilePermission::EXECUTABLE,
            None => FilePermission::EXECUTABLE,
        });
    }

    permissions
}

#[cfg(not(unix))]
fn file_permissions(meta: &fs::Metadata) -> Option<FilePermission> {
    meta.permissions()
        .readonly()
        .then_some(FilePermission::LOCKED)
}

/// Port of stock's `open()`, including the Windows `r+`-then-truncate dance:
/// opening with `w` there loses alternate data streams and breaks saving hidden
/// files (microsoft/vscode#931, #6363).
fn open_sync(path: &Path, opts: OpenOptions) -> FsResult<File> {
    if opts.is_for_write() && opts.unlock {
        if let Err(error) = unlock_file(path) {
            if error.kind() != io::ErrorKind::NotFound {
                log::trace!("open: could not unlock {}: {error}", path.display());
            }
        }
    }

    if !opts.is_for_write() {
        return File::open(path).map_err(|error| FsError::from_io(path, &error));
    }

    if opts.append {
        return fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(path)
            .map_err(|error| FsError::from_io_write(path, &error));
    }

    if cfg!(windows) {
        if let Ok(file) = fs::OpenOptions::new().read(true).write(true).open(path) {
            if file.set_len(0).is_ok() {
                return Ok(file);
            }
        }
    }

    fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .map_err(|error| FsError::from_io_write(path, &error))
}

#[cfg(unix)]
fn unlock_file(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let meta = fs::metadata(path)?;
    let mode = meta.permissions().mode();
    if mode & 0o200 != 0 {
        return Ok(());
    }

    fs::set_permissions(path, fs::Permissions::from_mode(mode | 0o200))
}

#[cfg(not(unix))]
fn unlock_file(path: &Path) -> io::Result<()> {
    let mut permissions = fs::metadata(path)?.permissions();
    if !permissions.readonly() {
        return Ok(());
    }

    permissions.set_readonly(false);
    fs::set_permissions(path, permissions)
}

#[cfg(unix)]
fn chmod_sync(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

/// Windows has no POSIX mode, and its callers only ever ask for owner-only
/// permissions a Windows ACL already gives them; stock's own use of `chmod` is
/// zsh-only. So there is nothing to set rather than something to translate.
#[cfg(not(unix))]
fn chmod_sync(_path: &Path, _mode: u32) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn read_at(file: &File, buffer: &mut [u8], pos: u64) -> io::Result<usize> {
    use std::os::unix::fs::FileExt;
    file.read_at(buffer, pos)
}

#[cfg(windows)]
fn read_at(file: &File, buffer: &mut [u8], pos: u64) -> io::Result<usize> {
    use std::os::windows::fs::FileExt;
    file.seek_read(buffer, pos)
}

#[cfg(unix)]
fn write_at(file: &File, data: &[u8], pos: u64) -> io::Result<usize> {
    use std::os::unix::fs::FileExt;
    file.write_at(data, pos)
}

#[cfg(windows)]
fn write_at(file: &File, data: &[u8], pos: u64) -> io::Result<usize> {
    use std::os::windows::fs::FileExt;
    file.seek_write(data, pos)
}

/// Port of stock's `delete()`. `move_to` is the atomic-delete path: rename the
/// target out of the way first so it disappears in one step, then remove it.
fn delete_sync(path: &Path, recursive: bool, move_to: Option<&Path>) -> FsResult<()> {
    if recursive {
        let target = match move_to {
            Some(temp) if fs::rename(path, temp).is_ok() => temp,
            _ => path,
        };

        return match fs::symlink_metadata(target) {
            Ok(meta) if meta.is_dir() => fs::remove_dir_all(target),
            Ok(_) => fs::remove_file(target),
            Err(error) => Err(error),
        }
        .map_err(|error| FsError::from_io(target, &error));
    }

    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) => {
            // `remove_file` refuses directories; stock detects that and retries
            // as `rmdir` rather than reporting a permission error.
            let is_directory = fs::symlink_metadata(path)
                .is_ok_and(|meta| meta.is_dir() && !meta.file_type().is_symlink());

            if is_directory {
                fs::remove_dir(path).map_err(|error| FsError::from_io(path, &error))
            } else {
                Err(FsError::from_io(path, &error))
            }
        }
    }
}

/// Recursive copy preserving symlinks, matching stock's
/// `Promises.copy(..., { preserveSymlinks: true })`.
fn copy_recursive(from: &Path, to: &Path) -> FsResult<()> {
    let meta = fs::symlink_metadata(from).map_err(|error| FsError::from_io(from, &error))?;

    if meta.file_type().is_symlink() {
        return copy_symlink(from, to);
    }

    if !meta.is_dir() {
        return fs::copy(from, to)
            .map(|_| ())
            .map_err(|error| FsError::from_io(from, &error));
    }

    fs::create_dir_all(to).map_err(|error| FsError::from_io(to, &error))?;

    for entry in fs::read_dir(from).map_err(|error| FsError::from_io(from, &error))? {
        let entry = entry.map_err(|error| FsError::from_io(from, &error))?;
        copy_recursive(&entry.path(), &to.join(entry.file_name()))?;
    }

    Ok(())
}

#[cfg(unix)]
fn copy_symlink(from: &Path, to: &Path) -> FsResult<()> {
    let target = fs::read_link(from).map_err(|error| FsError::from_io(from, &error))?;
    std::os::unix::fs::symlink(target, to).map_err(|error| FsError::from_io(to, &error))
}

/// Creating a symlink on Windows needs Developer Mode or elevation, so fall
/// back to copying what the link resolves to.
#[cfg(windows)]
fn copy_symlink(from: &Path, to: &Path) -> FsResult<()> {
    let target = fs::read_link(from).map_err(|error| FsError::from_io(from, &error))?;
    let resolved = fs::metadata(from).map_err(|error| FsError::from_io(from, &error))?;

    let created = if resolved.is_dir() {
        std::os::windows::fs::symlink_dir(&target, to)
    } else {
        std::os::windows::fs::symlink_file(&target, to)
    };

    match created {
        Ok(()) => Ok(()),
        Err(_) => copy_recursive(&fs::canonicalize(from).unwrap_or_else(|_| from.to_path_buf()), to),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    async fn provider_on(dir: &Path) -> DiskFileSystemProvider {
        let roots = WorkspaceRoots::new();
        roots.add_root(dir).await.unwrap();
        DiskFileSystemProvider::new(roots)
    }

    async fn at(provider: &DiskFileSystemProvider, path: PathBuf) -> ValidatedPath {
        provider.roots().validate(path).await.unwrap()
    }

    fn write_opts() -> WriteOptions {
        WriteOptions {
            create: true,
            overwrite: true,
            ..WriteOptions::default()
        }
    }

    #[tokio::test]
    async fn write_then_read_round_trips() {
        let tmp = TempDir::new().unwrap();
        let provider = provider_on(tmp.path()).await;
        let file = at(&provider, tmp.path().join("a.txt")).await;

        provider
            .write_file(&file, b"hello".to_vec(), write_opts())
            .await
            .unwrap();

        let read = provider.read_file(&file, ReadOptions::default()).await.unwrap();
        assert_eq!(read, b"hello");
    }

    #[tokio::test]
    async fn atomic_write_replaces_and_leaves_no_temp() {
        let tmp = TempDir::new().unwrap();
        let provider = provider_on(tmp.path()).await;
        let file = at(&provider, tmp.path().join("a.txt")).await;

        provider
            .write_file(&file, b"first".to_vec(), write_opts())
            .await
            .unwrap();

        let opts = WriteOptions {
            atomic: Some(crate::types::AtomicOptions {
                postfix: ".vsctmp".into(),
            }),
            ..write_opts()
        };
        provider.write_file(&file, b"second".to_vec(), opts).await.unwrap();

        let read = provider.read_file(&file, ReadOptions::default()).await.unwrap();
        assert_eq!(read, b"second");
        assert!(!tmp.path().join("a.txt.vsctmp").exists());
    }

    #[tokio::test]
    async fn write_without_create_rejects_a_missing_file() {
        let tmp = TempDir::new().unwrap();
        let provider = provider_on(tmp.path()).await;
        let file = at(&provider, tmp.path().join("missing.txt")).await;

        let error = provider
            .write_file(
                &file,
                b"x".to_vec(),
                WriteOptions {
                    create: false,
                    overwrite: true,
                    ..WriteOptions::default()
                },
            )
            .await
            .unwrap_err();

        assert_eq!(
            error.code,
            crate::error::FileSystemProviderErrorCode::FileNotFound
        );
    }

    #[tokio::test]
    async fn write_without_overwrite_rejects_an_existing_file() {
        let tmp = TempDir::new().unwrap();
        let provider = provider_on(tmp.path()).await;
        let file = at(&provider, tmp.path().join("a.txt")).await;
        provider
            .write_file(&file, b"x".to_vec(), write_opts())
            .await
            .unwrap();

        let error = provider
            .write_file(
                &file,
                b"y".to_vec(),
                WriteOptions {
                    create: true,
                    overwrite: false,
                    ..WriteOptions::default()
                },
            )
            .await
            .unwrap_err();

        assert_eq!(
            error.code,
            crate::error::FileSystemProviderErrorCode::FileExists
        );
    }

    #[tokio::test]
    async fn handle_api_reads_at_a_position() {
        let tmp = TempDir::new().unwrap();
        let provider = provider_on(tmp.path()).await;
        let file = at(&provider, tmp.path().join("a.txt")).await;
        provider
            .write_file(&file, b"0123456789".to_vec(), write_opts())
            .await
            .unwrap();

        let handle = provider.open(&file, OpenOptions::default()).await.unwrap();
        let chunk = provider.read(handle, 4, 3).await.unwrap();
        provider.close(handle).await.unwrap();

        assert_eq!(chunk, b"456");
    }

    #[tokio::test]
    async fn handle_api_writes_at_a_position() {
        let tmp = TempDir::new().unwrap();
        let provider = provider_on(tmp.path()).await;
        let file = at(&provider, tmp.path().join("a.txt")).await;

        let handle = provider
            .open(&file, OpenOptions { create: true, ..OpenOptions::default() })
            .await
            .unwrap();
        provider.write(handle, 0, b"abc").await.unwrap();
        provider.write(handle, 3, b"def").await.unwrap();
        provider.close(handle).await.unwrap();

        let read = provider.read_file(&file, ReadOptions::default()).await.unwrap();
        assert_eq!(read, b"abcdef");
    }

    #[tokio::test]
    async fn stale_handles_are_rejected() {
        let tmp = TempDir::new().unwrap();
        let provider = provider_on(tmp.path()).await;
        assert!(provider.read(9999, 0, 1).await.is_err());
        assert!(provider.close(9999).await.is_err());
    }

    #[tokio::test]
    async fn readdir_reports_types() {
        let tmp = TempDir::new().unwrap();
        let provider = provider_on(tmp.path()).await;
        fs::create_dir(tmp.path().join("sub")).unwrap();
        fs::write(tmp.path().join("a.txt"), "x").unwrap();

        let root = at(&provider, tmp.path().to_path_buf()).await;
        let mut entries = provider.readdir(&root).await.unwrap();
        entries.sort_by(|a, b| a.0.cmp(&b.0));

        assert_eq!(
            entries,
            vec![
                ("a.txt".to_string(), FileType::FILE),
                ("sub".to_string(), FileType::DIRECTORY),
            ]
        );
    }

    #[tokio::test]
    async fn mkdir_is_not_recursive() {
        let tmp = TempDir::new().unwrap();
        let provider = provider_on(tmp.path()).await;

        let deep = at(&provider, tmp.path().join("a/b")).await;
        assert!(provider.mkdir(&deep).await.is_err());

        let shallow = at(&provider, tmp.path().join("a")).await;
        provider.mkdir(&shallow).await.unwrap();
        assert!(tmp.path().join("a").is_dir());
    }

    #[tokio::test]
    async fn delete_non_recursive_refuses_a_non_empty_folder() {
        let tmp = TempDir::new().unwrap();
        let provider = provider_on(tmp.path()).await;
        fs::create_dir(tmp.path().join("sub")).unwrap();
        fs::write(tmp.path().join("sub/a.txt"), "x").unwrap();

        let folder = at(&provider, tmp.path().join("sub")).await;
        assert!(provider.delete(&folder, DeleteOptions::default()).await.is_err());

        provider
            .delete(
                &folder,
                DeleteOptions {
                    recursive: true,
                    ..DeleteOptions::default()
                },
            )
            .await
            .unwrap();
        assert!(!tmp.path().join("sub").exists());
    }

    #[tokio::test]
    async fn rename_respects_overwrite() {
        let tmp = TempDir::new().unwrap();
        let provider = provider_on(tmp.path()).await;
        fs::write(tmp.path().join("a.txt"), "a").unwrap();
        fs::write(tmp.path().join("b.txt"), "b").unwrap();

        let from = at(&provider, tmp.path().join("a.txt")).await;
        let to = at(&provider, tmp.path().join("b.txt")).await;

        assert!(provider
            .rename(&from, &to, OverwriteOptions { overwrite: false })
            .await
            .is_err());

        provider
            .rename(&from, &to, OverwriteOptions { overwrite: true })
            .await
            .unwrap();
        assert_eq!(fs::read_to_string(tmp.path().join("b.txt")).unwrap(), "a");
    }

    #[tokio::test]
    async fn copy_handles_folders() {
        let tmp = TempDir::new().unwrap();
        let provider = provider_on(tmp.path()).await;
        fs::create_dir_all(tmp.path().join("src/nested")).unwrap();
        fs::write(tmp.path().join("src/nested/a.txt"), "a").unwrap();

        let from = at(&provider, tmp.path().join("src")).await;
        let to = at(&provider, tmp.path().join("dst")).await;
        provider
            .copy(&from, &to, OverwriteOptions { overwrite: false })
            .await
            .unwrap();

        assert_eq!(
            fs::read_to_string(tmp.path().join("dst/nested/a.txt")).unwrap(),
            "a"
        );
    }

    #[tokio::test]
    async fn clone_file_creates_missing_parents() {
        let tmp = TempDir::new().unwrap();
        let provider = provider_on(tmp.path()).await;
        fs::write(tmp.path().join("a.txt"), "a").unwrap();

        let from = at(&provider, tmp.path().join("a.txt")).await;
        let to = at(&provider, tmp.path().join("deep/new/a.txt")).await;
        provider.clone_file(&from, &to).await.unwrap();

        assert_eq!(
            fs::read_to_string(tmp.path().join("deep/new/a.txt")).unwrap(),
            "a"
        );
    }

    #[tokio::test]
    async fn stat_flags_directories_and_sizes() {
        let tmp = TempDir::new().unwrap();
        let provider = provider_on(tmp.path()).await;
        fs::write(tmp.path().join("a.txt"), "12345").unwrap();

        let file = at(&provider, tmp.path().join("a.txt")).await;
        let stat = provider.stat(&file).await.unwrap();
        assert!(stat.file_type.contains(FileType::FILE));
        assert_eq!(stat.size, 5);

        let root = at(&provider, tmp.path().to_path_buf()).await;
        assert!(provider.stat(&root).await.unwrap().file_type.contains(FileType::DIRECTORY));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stat_reports_symlink_and_target_type() {
        let tmp = TempDir::new().unwrap();
        let provider = provider_on(tmp.path()).await;
        fs::write(tmp.path().join("a.txt"), "a").unwrap();
        std::os::unix::fs::symlink(tmp.path().join("a.txt"), tmp.path().join("link")).unwrap();

        let link = at(&provider, tmp.path().join("link")).await;
        let stat = provider.stat(&link).await.unwrap();
        assert!(stat.file_type.contains(FileType::SYMBOLIC_LINK));
        assert!(stat.file_type.contains(FileType::FILE));
    }
}
