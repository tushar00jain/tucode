//! Error model, ported from `vs/platform/files/common/files.ts`
//! (`FileSystemProviderErrorCode`) and the `toFileSystemProviderError` /
//! `toFileSystemProviderWriteError` helpers in
//! `vs/platform/files/node/diskFileSystemProvider.ts`.

use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// Stock `FileSystemProviderErrorCode`.
///
/// Serialized by *variant name* (`"FileNotFound"`, not the TS string value
/// `"EntryNotFound"`) because that is what the channel error payload contract
/// specifies and what the TS client rehydrates from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FileSystemProviderErrorCode {
    FileExists,
    FileNotFound,
    FileNotADirectory,
    FileIsADirectory,
    FileExceedsStorageQuota,
    FileTooLarge,
    FileWriteLocked,
    NoPermissions,
    Unavailable,
    Unknown,
}

/// A provider error: a stock error code plus a human readable message.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct FsError {
    pub code: FileSystemProviderErrorCode,
    pub message: String,
}

/// Convenience alias.
pub type FsResult<T> = Result<T, FsError>;

impl FsError {
    pub fn new(code: FileSystemProviderErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(FileSystemProviderErrorCode::FileNotFound, message)
    }

    pub fn exists(message: impl Into<String>) -> Self {
        Self::new(FileSystemProviderErrorCode::FileExists, message)
    }

    pub fn no_permissions(message: impl Into<String>) -> Self {
        Self::new(FileSystemProviderErrorCode::NoPermissions, message)
    }

    pub fn unknown(message: impl Into<String>) -> Self {
        Self::new(FileSystemProviderErrorCode::Unknown, message)
    }

    /// Port of `DiskFileSystemProvider.toFileSystemProviderError`.
    pub fn from_io(path: &Path, error: &io::Error) -> Self {
        Self::new(io_error_code(error), format!("{}: {error}", path.display()))
    }

    /// Port of `DiskFileSystemProvider.toFileSystemProviderWriteError`: a
    /// permission failure on a write is reported as `FileWriteLocked` when the
    /// file itself turns out to be read-only, so the editor can offer to
    /// remove the lock rather than just failing.
    pub fn from_io_write(path: &Path, error: &io::Error) -> Self {
        let mut result = Self::from_io(path, error);

        if result.code == FileSystemProviderErrorCode::NoPermissions
            && std::fs::metadata(path).is_ok_and(|meta| meta.permissions().readonly())
        {
            result.code = FileSystemProviderErrorCode::FileWriteLocked;
        }

        result
    }
}

/// Maps an `io::Error` onto the stock code the same way stock maps `errno`.
fn io_error_code(error: &io::Error) -> FileSystemProviderErrorCode {
    // `raw_os_error` first: `ErrorKind::IsADirectory` / `NotADirectory` only
    // surface on some platforms, and stock keys off `EISDIR` / `ENOTDIR`.
    #[cfg(unix)]
    match error.raw_os_error() {
        Some(21) => return FileSystemProviderErrorCode::FileIsADirectory, // EISDIR
        Some(20) => return FileSystemProviderErrorCode::FileNotADirectory, // ENOTDIR
        _ => {}
    }
    #[cfg(windows)]
    if error.raw_os_error() == Some(267) {
        // ERROR_DIRECTORY
        return FileSystemProviderErrorCode::FileNotADirectory;
    }

    match error.kind() {
        io::ErrorKind::NotFound => FileSystemProviderErrorCode::FileNotFound,
        io::ErrorKind::AlreadyExists => FileSystemProviderErrorCode::FileExists,
        io::ErrorKind::PermissionDenied => FileSystemProviderErrorCode::NoPermissions,
        _ => FileSystemProviderErrorCode::Unknown,
    }
}

/// A `spawn_blocking` join failure. Only reachable if the blocking task
/// panicked or the runtime shut down mid-call.
pub(crate) fn join_error(error: tokio::task::JoinError) -> FsError {
    FsError::new(
        FileSystemProviderErrorCode::Unavailable,
        format!("filesystem task failed: {error}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_not_found() {
        let err = io::Error::new(io::ErrorKind::NotFound, "nope");
        assert_eq!(io_error_code(&err), FileSystemProviderErrorCode::FileNotFound);
    }

    #[test]
    fn maps_permission_denied() {
        let err = io::Error::new(io::ErrorKind::PermissionDenied, "nope");
        assert_eq!(io_error_code(&err), FileSystemProviderErrorCode::NoPermissions);
    }

    #[test]
    fn maps_already_exists() {
        let err = io::Error::new(io::ErrorKind::AlreadyExists, "nope");
        assert_eq!(io_error_code(&err), FileSystemProviderErrorCode::FileExists);
    }

    #[test]
    fn maps_unrecognised_to_unknown() {
        let err = io::Error::new(io::ErrorKind::BrokenPipe, "nope");
        assert_eq!(io_error_code(&err), FileSystemProviderErrorCode::Unknown);
    }
}
