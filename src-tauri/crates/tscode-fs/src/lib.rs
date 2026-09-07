//! Filesystem backend for tscode.
//!
//! A port of VS Code's `vs/platform/files/node/diskFileSystemProvider.ts` onto
//! Rust: same method set, same option flags, same `FileSystemProviderErrorCode`
//! values, and both capability halves (whole-file read/write *and* the
//! handle-based open/read/write/close API) because the stock provider declares
//! both and the stock client picks between them.
//!
//! No Tauri types appear in this crate's API — the channel layer wraps it.
//!
//! # Security
//!
//! Our Tauri commands are not gated by the capability system, so
//! [`WorkspaceRoots`] is the only thing restricting what the webview can reach.
//! Every entry point takes a [`ValidatedPath`], which only
//! [`WorkspaceRoots::validate`] can produce.
//!
//! # Deliberate deviations from the reference implementation
//!
//! - **No `readFileStream`.** Stock streams in 256 KB chunks to cut Electron
//!   IPC overhead; the channel client reads whole buffers, so the
//!   `FileReadStream` capability is not declared and the method is absent.
//! - **No `Trash` capability.** Stock's `useTrash` needs Electron's shell; the
//!   option is accepted on the wire and ignored.
//! - **`read` returns the bytes it read** rather than filling a caller-supplied
//!   buffer and returning a count. The bytes have to be serialised back over
//!   the channel either way.
//! - **No `mapHandleToPos` bookkeeping.** Stock tracks each descriptor's
//!   position so it can pass `null` to `fs.read`/`fs.write` and avoid an extra
//!   `seek` that can fail over FTP mounts (microsoft/vscode#73884). Rust's
//!   positional I/O (`read_at` / `seek_read`) is that same single syscall, so
//!   the bookkeeping has nothing left to buy.
//! - **No encoding work.** Stock does detection and decoding in the renderer,
//!   not in the disk provider: `vs/workbench/services/textfile/common/encoding.ts`
//!   imports no Node builtins and is vendored as-is.
//! - **Watching is one debounced, coalesced watcher** rather than stock's split
//!   between a universal (parcel) watcher and a non-recursive Node one. The
//!   coalescing itself is a port of stock's `EventCoalescer`.

mod blocking;

pub mod discover;
pub mod error;
pub mod locks;
pub mod paths;
pub mod provider;
pub mod registry;
pub mod roots;
pub mod types;
pub mod watcher;

pub use discover::find_marked_dirs;
pub use error::{FileSystemProviderErrorCode, FsError, FsResult};
pub use locks::{ResourceLock, ResourceLocks};
pub use provider::{DiskFileSystemProvider, FileHandle};
pub use registry::{RootEntry, RootRegistry};
pub use roots::{ValidatedPath, WorkspaceRoots};
pub use types::{
    capabilities, change_filter, is_filtered, is_path_case_sensitive, provider_capabilities,
    AtomicOptions, DeleteOptions, FileChange, FileChangeType, FilePermission, FileType,
    OpenOptions, OverwriteOptions, ReadOptions, Stat, WriteOptions,
};
pub use watcher::{coalesce_events, ChangeHandler, FileWatcher, WatchOptions};
