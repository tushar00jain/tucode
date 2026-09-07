//! The provider's value types, ported one-for-one from
//! `vs/platform/files/common/files.ts`. Names and numeric values match stock so
//! the copied TypeScript client needs no translation layer.

use std::path::PathBuf;

use serde::{Deserialize, Deserializer, Serialize};

/// Stock `FileType`. A bit set: `SymbolicLink` is OR-ed onto `File` /
/// `Directory` so callers can test the link target's type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct FileType(pub u32);

impl FileType {
    pub const UNKNOWN: Self = Self(0);
    pub const FILE: Self = Self(1);
    pub const DIRECTORY: Self = Self(2);
    pub const SYMBOLIC_LINK: Self = Self(64);

    #[must_use]
    pub fn contains(self, other: Self) -> bool {
        self.0 & other.0 != 0
    }
}

impl std::ops::BitOr for FileType {
    type Output = Self;

    fn bitor(self, rhs: Self) -> Self {
        Self(self.0 | rhs.0)
    }
}

/// Stock `FilePermission`. A bit set; `None` means "no special permissions".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct FilePermission(pub u32);

impl FilePermission {
    pub const READONLY: Self = Self(1);
    pub const LOCKED: Self = Self(2);
    pub const EXECUTABLE: Self = Self(4);
}

impl std::ops::BitOr for FilePermission {
    type Output = Self;

    fn bitor(self, rhs: Self) -> Self {
        Self(self.0 | rhs.0)
    }
}

/// Stock `IStat`. `mtime` / `ctime` are millis since the unix epoch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    #[serde(rename = "type")]
    pub file_type: FileType,
    pub mtime: u64,
    pub ctime: u64,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permissions: Option<FilePermission>,
}

/// Stock `FileSystemProviderCapabilities`.
///
/// Deliberately narrower than stock's disk provider: we do not declare
/// `FileReadStream` (the channel client reads whole buffers) or `Trash`.
pub mod capabilities {
    pub const NONE: u32 = 0;
    pub const FILE_READ_WRITE: u32 = 1 << 1;
    pub const FILE_OPEN_READ_WRITE_CLOSE: u32 = 1 << 2;
    pub const FILE_FOLDER_COPY: u32 = 1 << 3;
    pub const FILE_READ_STREAM: u32 = 1 << 4;
    pub const PATH_CASE_SENSITIVE: u32 = 1 << 10;
    pub const READONLY: u32 = 1 << 11;
    pub const TRASH: u32 = 1 << 12;
    pub const FILE_WRITE_UNLOCK: u32 = 1 << 13;
    pub const FILE_ATOMIC_READ: u32 = 1 << 14;
    pub const FILE_ATOMIC_WRITE: u32 = 1 << 15;
    pub const FILE_ATOMIC_DELETE: u32 = 1 << 16;
    pub const FILE_CLONE: u32 = 1 << 17;
    pub const FILE_REALPATH: u32 = 1 << 18;
    pub const FILE_APPEND: u32 = 1 << 19;
}

/// The capability set this provider declares. Mirrors the `get capabilities()`
/// accessor on stock's `DiskFileSystemProvider`.
#[must_use]
pub fn provider_capabilities() -> u32 {
    let mut caps = capabilities::FILE_READ_WRITE
        | capabilities::FILE_OPEN_READ_WRITE_CLOSE
        | capabilities::FILE_FOLDER_COPY
        | capabilities::FILE_WRITE_UNLOCK
        | capabilities::FILE_APPEND
        | capabilities::FILE_ATOMIC_READ
        | capabilities::FILE_ATOMIC_WRITE
        | capabilities::FILE_ATOMIC_DELETE
        | capabilities::FILE_CLONE
        | capabilities::FILE_REALPATH;

    if cfg!(target_os = "linux") {
        caps |= capabilities::PATH_CASE_SENSITIVE;
    }

    caps
}

/// True when this platform's paths compare case sensitively. Stock derives the
/// same fact from the `PathCaseSensitive` capability.
#[must_use]
pub fn is_path_case_sensitive() -> bool {
    provider_capabilities() & capabilities::PATH_CASE_SENSITIVE != 0
}

/// Stock `IFileAtomicOptions`: the postfix appended to the resource name to
/// form the temporary sibling used for an atomic write or delete.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AtomicOptions {
    pub postfix: String,
}

/// Stock sends `atomic` as `IFileAtomicOptions | false | undefined`. Accept all
/// three shapes and normalise to `Option<AtomicOptions>`.
fn deserialize_atomic<'de, D>(deserializer: D) -> Result<Option<AtomicOptions>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Atomic {
        /// The payload is only ever `false`; it exists so the variant matches a
        /// boolean rather than anything at all.
        Disabled(#[allow(dead_code)] bool),
        Enabled(AtomicOptions),
    }

    Ok(match Option::<Atomic>::deserialize(deserializer)? {
        Some(Atomic::Enabled(options)) => Some(options),
        Some(Atomic::Disabled(_)) | None => None,
    })
}

/// Stock `IFileOverwriteOptions`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
pub struct OverwriteOptions {
    #[serde(default)]
    pub overwrite: bool,
}

/// Stock `IFileAtomicReadOptions`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
pub struct ReadOptions {
    /// Serialize the read against in-process writes to the same resource.
    #[serde(default)]
    pub atomic: bool,
}

/// Stock `IFileWriteOptions` (overwrite + unlock + atomic + create + append).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct WriteOptions {
    #[serde(default)]
    pub overwrite: bool,
    #[serde(default)]
    pub create: bool,
    #[serde(default)]
    pub unlock: bool,
    #[serde(default)]
    pub append: bool,
    #[serde(default, deserialize_with = "deserialize_atomic")]
    pub atomic: Option<AtomicOptions>,
}

/// Stock `IFileOpenOptions`. The TS side is a union discriminated by
/// `create === true`; here that is `is_for_write()`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
pub struct OpenOptions {
    #[serde(default)]
    pub create: bool,
    #[serde(default)]
    pub unlock: bool,
    #[serde(default)]
    pub append: bool,
}

impl OpenOptions {
    /// Port of stock's `isFileOpenForWriteOptions`.
    #[must_use]
    pub fn is_for_write(self) -> bool {
        self.create
    }
}

/// Stock `IFileDeleteOptions`. `use_trash` is accepted for wire compatibility
/// but ignored — we do not declare the `Trash` capability.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOptions {
    #[serde(default)]
    pub recursive: bool,
    #[serde(default)]
    pub use_trash: bool,
    #[serde(default, deserialize_with = "deserialize_atomic")]
    pub atomic: Option<AtomicOptions>,
}

/// Stock `FileChangeType`. Values are the TS enum's implicit ordinals.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(into = "u8", try_from = "u8")]
pub enum FileChangeType {
    Updated,
    Added,
    Deleted,
}

impl From<FileChangeType> for u8 {
    fn from(value: FileChangeType) -> Self {
        match value {
            FileChangeType::Updated => 0,
            FileChangeType::Added => 1,
            FileChangeType::Deleted => 2,
        }
    }
}

impl TryFrom<u8> for FileChangeType {
    type Error = String;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Self::Updated),
            1 => Ok(Self::Added),
            2 => Ok(Self::Deleted),
            other => Err(format!("unknown FileChangeType: {other}")),
        }
    }
}

/// Stock `FileChangeFilter`, a bit set applied by `is_filtered`.
pub mod change_filter {
    pub const UPDATED: u32 = 1 << 1;
    pub const ADDED: u32 = 1 << 2;
    pub const DELETED: u32 = 1 << 3;
}

/// Stock `IFileChange`. `resource` is a plain path here; the channel layer
/// converts it to a `file://` URI on the way out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    #[serde(rename = "type")]
    pub change_type: FileChangeType,
    pub resource: PathBuf,
    #[serde(rename = "cId", skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<u32>,
}

/// Port of `isFiltered` in `vs/platform/files/common/watcher.ts`.
#[must_use]
pub fn is_filtered(change: &FileChange, filter: Option<u32>) -> bool {
    let Some(filter) = filter else {
        return false;
    };

    let bit = match change.change_type {
        FileChangeType::Added => change_filter::ADDED,
        FileChangeType::Deleted => change_filter::DELETED,
        FileChangeType::Updated => change_filter::UPDATED,
    };

    filter & bit == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_type_is_a_bit_set() {
        let link_to_dir = FileType::DIRECTORY | FileType::SYMBOLIC_LINK;
        assert!(link_to_dir.contains(FileType::DIRECTORY));
        assert!(link_to_dir.contains(FileType::SYMBOLIC_LINK));
        assert!(!link_to_dir.contains(FileType::FILE));
        assert_eq!(link_to_dir.0, 66);
    }

    #[test]
    fn atomic_accepts_false_object_and_missing() {
        let disabled: WriteOptions = serde_json::from_str(r#"{"atomic":false}"#).unwrap();
        assert_eq!(disabled.atomic, None);

        let missing: WriteOptions = serde_json::from_str("{}").unwrap();
        assert_eq!(missing.atomic, None);

        let enabled: WriteOptions =
            serde_json::from_str(r#"{"atomic":{"postfix":".vsctmp"}}"#).unwrap();
        assert_eq!(enabled.atomic.unwrap().postfix, ".vsctmp");
    }

    #[test]
    fn open_options_discriminate_writes() {
        assert!(OpenOptions {
            create: true,
            ..OpenOptions::default()
        }
        .is_for_write());
        assert!(!OpenOptions::default().is_for_write());
    }

    #[test]
    fn filter_drops_unrequested_kinds() {
        let change = FileChange {
            change_type: FileChangeType::Added,
            resource: PathBuf::from("a"),
            correlation_id: None,
        };

        assert!(!is_filtered(&change, None));
        assert!(!is_filtered(&change, Some(change_filter::ADDED)));
        assert!(is_filtered(&change, Some(change_filter::DELETED)));
    }
}
