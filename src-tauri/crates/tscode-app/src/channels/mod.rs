//! The six [`ServerChannel`](crate::channel::ServerChannel) implementations,
//! plus the wire vocabulary they share.
//!
//! Each channel is a thin adapter over one crate — `tscode_fs`, `tscode_git`,
//! `tscode_search`, `tscode_sl`, `tscode_pty` — and owns no logic of its own. Where a shape
//! has to change at the boundary (a `URI` becoming a path, a `glob.IExpression`
//! becoming a glob list) the conversion is a port of the stock function that
//! already does it, named in the doc comment.

pub mod file;
pub mod pty;
pub mod scm;
pub mod search;
pub mod sl;
pub mod watch;

use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tscode_fs::{FileSystemProviderErrorCode, FsError};

use crate::channel::{ChannelError, ChannelErrorCode};

//#region Errors

/// `tscode_fs`'s error code and the channel's are the same stock enum, ported
/// twice because the crate carries no Tauri types. Mapping them is the only
/// place the two spellings meet.
pub fn from_fs_error(error: FsError) -> ChannelError {
    let code = match error.code {
        FileSystemProviderErrorCode::FileExists => ChannelErrorCode::FileExists,
        FileSystemProviderErrorCode::FileNotFound => ChannelErrorCode::FileNotFound,
        FileSystemProviderErrorCode::FileNotADirectory => ChannelErrorCode::FileNotADirectory,
        FileSystemProviderErrorCode::FileIsADirectory => ChannelErrorCode::FileIsADirectory,
        FileSystemProviderErrorCode::FileExceedsStorageQuota => {
            ChannelErrorCode::FileExceedsStorageQuota
        }
        FileSystemProviderErrorCode::FileTooLarge => ChannelErrorCode::FileTooLarge,
        FileSystemProviderErrorCode::FileWriteLocked => ChannelErrorCode::FileWriteLocked,
        FileSystemProviderErrorCode::NoPermissions => ChannelErrorCode::NoPermissions,
        FileSystemProviderErrorCode::Unavailable => ChannelErrorCode::Unavailable,
        FileSystemProviderErrorCode::Unknown => ChannelErrorCode::Unknown,
    };
    ChannelError::new(code, error.message)
}

/// The error a channel returns for a command name it does not implement.
/// Mirrors stock's `throw new Error(\`IPC Command ${command} not found\`)`.
pub fn unknown_command(channel: &str, command: &str) -> ChannelError {
    ChannelError::unknown(format!("IPC Command {command} not found on channel {channel}"))
}

/// The error a channel returns for an event name it does not implement.
pub fn unknown_event(channel: &str, event: &str) -> ChannelError {
    ChannelError::unknown(format!("Unknown event {event} on channel {channel}"))
}

//#endregion

//#region Positional arguments

/// Stock `IChannel.call(command, arg)` passes its parameters as a single JSON
/// array — `channel.call('read', [fd, pos, length])`. `Args` reads that array
/// positionally so a channel body reads like the stock `switch` it ports.
pub struct Args(Vec<Value>);

impl Args {
    /// A missing or non-array `arg` becomes an empty list, so a command whose
    /// parameters are all optional still dispatches.
    pub fn new(arg: Value) -> Self {
        match arg {
            Value::Array(items) => Self(items),
            Value::Null => Self(Vec::new()),
            other => Self(vec![other]),
        }
    }

    fn raw(&self, index: usize) -> Value {
        self.0.get(index).cloned().unwrap_or(Value::Null)
    }

    /// Argument `index`, which must be present and of the expected shape.
    pub fn at<T: DeserializeOwned>(&self, index: usize) -> Result<T, ChannelError> {
        serde_json::from_value(self.raw(index))
            .map_err(|error| ChannelError::unknown(format!("bad argument {index}: {error}")))
    }

    /// Argument `index`, defaulting when it is absent or `null` — the shape of
    /// every stock `opts?` parameter.
    pub fn opt<T: DeserializeOwned + Default>(&self, index: usize) -> Result<T, ChannelError> {
        match self.raw(index) {
            Value::Null => Ok(T::default()),
            value => serde_json::from_value(value)
                .map_err(|error| ChannelError::unknown(format!("bad argument {index}: {error}"))),
        }
    }
}

/// The channels whose commands take one named-argument object rather than stock
/// `IChannel`'s positional array — `scm`, `sl` and `pty`, none of which has a
/// stock server to mirror. A missing argument becomes an empty object, so a command
/// whose parameters are all optional still dispatches.
pub fn params<T: DeserializeOwned>(channel: &str, arg: Value) -> Result<T, ChannelError> {
    let arg = if arg.is_null() { Value::Object(serde_json::Map::new()) } else { arg };
    serde_json::from_value(arg)
        .map_err(|error| ChannelError::unknown(format!("bad {channel} arguments: {error}")))
}

/// Serializes a command's result, turning a serialization failure into a
/// channel error rather than a panic.
pub fn json<T: Serialize>(value: &T) -> Result<Value, ChannelError> {
    serde_json::to_value(value).map_err(ChannelError::from)
}

/// One path — `open` and `close` on both source control channels.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathParams {
    pub path: PathBuf,
}

/// Where to look for repositories and how deep, for either channel's `discover`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverParams {
    pub path: PathBuf,
    #[serde(default = "default_max_depth")]
    pub max_depth: usize,
}

fn default_max_depth() -> usize {
    3
}

//#endregion

//#region URIs

/// Stock `UriComponents`. Everything but `scheme` is defaulted because
/// `URI.toJSON()` omits empty parts, and unknown fields (`$mid`, `fsPath`,
/// `external`) are ignored.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UriComponents {
    pub scheme: String,
    #[serde(default)]
    pub authority: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub fragment: String,
}

impl UriComponents {
    /// Port of `URI.file` in `vs/base/common/uri.ts`: forward slashes on
    /// Windows, UNC shares become the authority, and the reference resolution
    /// in the `URI` constructor prepends the leading slash a `file:` path needs.
    pub fn file(path: &Path) -> Self {
        let mut path = path.to_string_lossy().into_owned();
        if cfg!(windows) {
            path = path.replace('\\', "/");
        }

        let mut authority = String::new();
        if path.starts_with("//") {
            match path[2..].find('/') {
                Some(offset) => {
                    let split = 2 + offset;
                    authority = path[2..split].to_owned();
                    path = path[split..].to_owned();
                }
                None => {
                    authority = path[2..].to_owned();
                    path = "/".to_owned();
                }
            }
        }

        if !path.starts_with('/') {
            path.insert(0, '/');
        }

        Self { scheme: "file".to_owned(), authority, path, ..Self::default() }
    }

    /// Port of `uriToFsPath(uri, false)` in `vs/base/common/uri.ts`.
    pub fn to_fs_path(&self) -> PathBuf {
        let chars: Vec<char> = self.path.chars().take(3).collect();
        let has_drive_letter = chars.len() == 3
            && chars[0] == '/'
            && chars[1].is_ascii_alphabetic()
            && chars[2] == ':';

        let mut value = if !self.authority.is_empty() && self.path.len() > 1 && self.scheme == "file"
        {
            format!("//{}{}", self.authority, self.path)
        } else if has_drive_letter {
            let mut drive = chars[1].to_ascii_lowercase().to_string();
            drive.push_str(&self.path[2..]);
            drive
        } else {
            self.path.clone()
        };

        if cfg!(windows) {
            value = value.replace('/', "\\");
        }

        PathBuf::from(value)
    }
}

//#endregion

//#region Buffers

/// Stock `VSBuffer` over a JSON transport.
///
/// Electron's IPC passes `VSBuffer` as binary and the stock client unwraps
/// `.buffer` on the other side, so a bare JSON array would arrive as a plain
/// `Array` with no `.buffer`. The `$type` tag — the same discriminator the
/// channel error contract uses — lets the Tauri transport revive it.
#[derive(Debug, Clone, Serialize)]
pub struct VsBuffer {
    #[serde(rename = "$type")]
    type_name: &'static str,
    data: Vec<u8>,
}

impl VsBuffer {
    pub fn new(data: Vec<u8>) -> Self {
        Self { type_name: "VSBuffer", data }
    }
}

/// The incoming half: the tagged form the transport sends, or a bare byte array.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum IncomingBuffer {
    Tagged { data: Vec<u8> },
    Raw(Vec<u8>),
}

impl IncomingBuffer {
    pub fn into_bytes(self) -> Vec<u8> {
        match self {
            Self::Tagged { data } | Self::Raw(data) => data,
        }
    }
}

//#endregion

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_uri_round_trips_a_path() {
        let path = if cfg!(windows) { Path::new(r"c:\a\b.txt") } else { Path::new("/a/b.txt") };
        let uri = UriComponents::file(path);

        assert_eq!(uri.scheme, "file");
        assert_eq!(uri.path, if cfg!(windows) { "/c:/a/b.txt" } else { "/a/b.txt" });
        assert_eq!(uri.to_fs_path(), path);
    }

    #[test]
    fn drive_letter_case_is_normalized_like_stock() {
        let uri = UriComponents { scheme: "file".to_owned(), path: "/C:/a".to_owned(), ..UriComponents::default() };
        let expected = if cfg!(windows) { r"c:\a" } else { "c:/a" };
        assert_eq!(uri.to_fs_path(), PathBuf::from(expected));
    }

    #[test]
    fn args_read_positionally_and_default() {
        let args = Args::new(serde_json::json!([3, null]));
        assert_eq!(args.at::<u32>(0).unwrap(), 3);
        assert_eq!(args.opt::<u32>(1).unwrap(), 0);
        assert_eq!(args.opt::<u32>(9).unwrap(), 0);
        assert!(args.at::<u32>(1).is_err());
    }
}
