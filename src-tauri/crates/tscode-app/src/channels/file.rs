//! Port of `AbstractDiskFileSystemProviderChannel` in
//! `vs/platform/files/node/diskFileSystemProviderServer.ts`.
//!
//! The command names below are that file's `switch`, verbatim, because they are
//! what the unmodified stock `DiskFileSystemProviderClient` calls. Stock's
//! `IURITransformer` has no analogue here — there is one process and one URI
//! space — so `transformIncoming` collapses into
//! [`WorkspaceRoots::validate`](tscode_fs::WorkspaceRoots::validate), which is
//! also the security check the whole backend rests on.
//!
//! Two stock names are deliberately absent:
//!
//! - `readFileStream` — the `FileReadStream` capability is not declared, so the
//!   client never takes that path (`tscode-fs`, "Deliberate deviations").
//! - nothing for `useTrash`; the option is accepted on `delete` and ignored.
//!
//! Watching (`watch` / `unwatch` / `fileChange`) is stock's too, but its
//! implementation lives in [`WatchChannel`] — one object serves both this
//! channel and the pinned `watch` channel name.
//!
//! # Non-stock commands
//!
//! `registerWorkspaceRoot` / `unregisterWorkspaceRoot` / `workspaceRoots` are
//! tscode's, not stock's. An empty root registry denies every path, so boot and
//! Open Folder both have to be able to register one, and the channel surface is
//! the only IPC there is.
//!
//! `userDataDir` is tscode's as well. Stock's desktop build learns where user
//! data lives from its own main process; this port's renderer has no such
//! source, and the directory has to exist and be a registered root before the
//! first settings read, so the backend both creates it and answers with it.
//!
//! `chmod` is tscode's too: stock's shell-integration injection runs in the pty
//! host and calls `fs.chmod` there, but ours runs in the renderer, which has no
//! filesystem but this channel.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Manager};
use tscode_fs::{
    DeleteOptions, DiskFileSystemProvider, OpenOptions, OverwriteOptions, ReadOptions,
    WorkspaceRoots, WriteOptions,
};

use crate::channel::{ChannelError, EventSink, ServerChannel, Subscription};
use crate::channels::watch::WatchChannel;
use crate::channels::{
    from_fs_error, json, unknown_command, unknown_event, Args, IncomingBuffer, UriComponents,
    VsBuffer,
};

const CHANNEL: &str = "file";

pub struct FileChannel {
    provider: Arc<DiskFileSystemProvider>,
    roots: Arc<WorkspaceRoots>,
    watch: Arc<WatchChannel>,
    app: AppHandle,
}

impl FileChannel {
    pub fn new(
        provider: Arc<DiskFileSystemProvider>,
        roots: Arc<WorkspaceRoots>,
        watch: Arc<WatchChannel>,
        app: AppHandle,
    ) -> Self {
        Self { provider, roots, watch, app }
    }

    /// Stock's `transformIncoming`: a `UriComponents` argument becomes the path
    /// the provider will act on, having proved it is inside a workspace root.
    async fn incoming(&self, args: &Args, index: usize) -> Result<tscode_fs::ValidatedPath, ChannelError> {
        let resource: UriComponents = args.at(index)?;
        self.roots
            .validate(resource.to_fs_path())
            .await
            .map_err(from_fs_error)
    }

    /// Both ends of a move / copy / clone, validated together so a call site
    /// cannot check one and forget the other.
    async fn incoming_pair(
        &self,
        args: &Args,
    ) -> Result<(tscode_fs::ValidatedPath, tscode_fs::ValidatedPath), ChannelError> {
        let source: UriComponents = args.at(0)?;
        let target: UriComponents = args.at(1)?;
        self.roots
            .validate_pair(source.to_fs_path(), target.to_fs_path())
            .await
            .map_err(from_fs_error)
    }

    //#region File metadata resolving

    async fn stat(&self, args: &Args) -> Result<Value, ChannelError> {
        let resource = self.incoming(args, 0).await?;
        let stat = self.provider.stat(&resource).await.map_err(from_fs_error)?;
        json(&stat)
    }

    /// Stock returns the resolved path as a plain string, not a URI.
    async fn realpath(&self, args: &Args) -> Result<Value, ChannelError> {
        let resource = self.incoming(args, 0).await?;
        let resolved = self.provider.realpath(&resource).await.map_err(from_fs_error)?;
        Ok(Value::String(resolved.to_string_lossy().into_owned()))
    }

    async fn readdir(&self, args: &Args) -> Result<Value, ChannelError> {
        let resource = self.incoming(args, 0).await?;
        let entries = self.provider.readdir(&resource).await.map_err(from_fs_error)?;
        json(&entries)
    }

    //#endregion

    //#region File reading / writing

    async fn read_file(&self, args: &Args) -> Result<Value, ChannelError> {
        let resource = self.incoming(args, 0).await?;
        let opts: ReadOptions = args.opt(1)?;
        let content = self
            .provider
            .read_file(&resource, opts)
            .await
            .map_err(from_fs_error)?;
        json(&VsBuffer::new(content))
    }

    async fn write_file(&self, args: &Args) -> Result<Value, ChannelError> {
        let resource = self.incoming(args, 0).await?;
        let content: IncomingBuffer = args.at(1)?;
        let opts: WriteOptions = args.opt(2)?;
        self.provider
            .write_file(&resource, content.into_bytes(), opts)
            .await
            .map_err(from_fs_error)?;
        Ok(Value::Null)
    }

    async fn open(&self, args: &Args) -> Result<Value, ChannelError> {
        let resource = self.incoming(args, 0).await?;
        let opts: OpenOptions = args.opt(1)?;
        let handle = self.provider.open(&resource, opts).await.map_err(from_fs_error)?;
        json(&handle)
    }

    async fn close(&self, args: &Args) -> Result<Value, ChannelError> {
        self.provider.close(args.at(0)?).await.map_err(from_fs_error)?;
        Ok(Value::Null)
    }

    /// Stock allocates the buffer server-side and answers `[VSBuffer, number]`;
    /// the crate returns the bytes it read, so the count is their length.
    async fn read(&self, args: &Args) -> Result<Value, ChannelError> {
        let handle = args.at(0)?;
        let pos = args.at(1)?;
        let length = args.at(2)?;

        let bytes = self
            .provider
            .read(handle, pos, length)
            .await
            .map_err(from_fs_error)?;
        let bytes_read = bytes.len();

        Ok(Value::Array(vec![json(&VsBuffer::new(bytes))?, json(&bytes_read)?]))
    }

    async fn write(&self, args: &Args) -> Result<Value, ChannelError> {
        let handle = args.at(0)?;
        let pos = args.at(1)?;
        let data: IncomingBuffer = args.at(2)?;
        let offset: usize = args.at(3)?;
        let length: usize = args.at(4)?;

        let data = data.into_bytes();
        let end = offset.saturating_add(length).min(data.len());
        let slice = data.get(offset..end).unwrap_or_default();

        let written = self
            .provider
            .write(handle, pos, slice)
            .await
            .map_err(from_fs_error)?;
        json(&written)
    }

    //#endregion

    //#region Move / copy / delete / create folder

    async fn mkdir(&self, args: &Args) -> Result<Value, ChannelError> {
        let resource = self.incoming(args, 0).await?;
        self.provider.mkdir(&resource).await.map_err(from_fs_error)?;
        Ok(Value::Null)
    }

    async fn delete(&self, args: &Args) -> Result<Value, ChannelError> {
        let resource = self.incoming(args, 0).await?;
        let opts: DeleteOptions = args.opt(1)?;
        self.provider.delete(&resource, opts).await.map_err(from_fs_error)?;
        Ok(Value::Null)
    }

    async fn rename(&self, args: &Args) -> Result<Value, ChannelError> {
        let (source, target) = self.incoming_pair(args).await?;
        let opts: OverwriteOptions = args.opt(2)?;
        self.provider
            .rename(&source, &target, opts)
            .await
            .map_err(from_fs_error)?;
        Ok(Value::Null)
    }

    async fn copy(&self, args: &Args) -> Result<Value, ChannelError> {
        let (source, target) = self.incoming_pair(args).await?;
        let opts: OverwriteOptions = args.opt(2)?;
        self.provider
            .copy(&source, &target, opts)
            .await
            .map_err(from_fs_error)?;
        Ok(Value::Null)
    }

    async fn clone_file(&self, args: &Args) -> Result<Value, ChannelError> {
        let (source, target) = self.incoming_pair(args).await?;
        self.provider
            .clone_file(&source, &target)
            .await
            .map_err(from_fs_error)?;
        Ok(Value::Null)
    }

    /// `mode` is a POSIX mode, exactly as `fs.chmod`'s is — the caller writes it
    /// octal. See [`DiskFileSystemProvider::chmod`] for why this is not stock's.
    async fn chmod(&self, args: &Args) -> Result<Value, ChannelError> {
        let resource = self.incoming(args, 0).await?;
        let mode: u32 = args.at(1)?;
        self.provider
            .chmod(&resource, mode)
            .await
            .map_err(from_fs_error)?;
        Ok(Value::Null)
    }

    //#endregion

    //#region Workspace roots (not stock)

    /// Opens a folder to the backend: it becomes a `WorkspaceRoots` entry *and*
    /// an `assetProtocol` scope entry, in one call.
    ///
    /// The two are one operation because a root the webview may name but not
    /// load — or load but not name — is a half-open folder, and a call site that
    /// did one and forgot the other would fail in a way that looks like a
    /// permissions bug in the other half. Returns the canonical root as a URI.
    async fn register_workspace_root(&self, args: &Args) -> Result<Value, ChannelError> {
        let resource: UriComponents = args.at(0)?;
        let root = self.register_root(resource.to_fs_path()).await?;

        json(&UriComponents::file(&root))
    }

    /// Registers `path` and widens the asset scope to it, answering with the
    /// canonical root. Every caller goes through here so the pair cannot come
    /// apart: a root registered without the scope is a folder the webview may
    /// name but not load.
    async fn register_root(&self, path: PathBuf) -> Result<PathBuf, ChannelError> {
        let root = self.roots.add_root(path).await.map_err(from_fs_error)?;

        self.app
            .asset_protocol_scope()
            .allow_directory(&root, true)
            .map_err(|error| {
                self.roots.remove_root(&root);
                ChannelError::no_permissions(format!(
                    "cannot widen the asset scope to {}: {error}",
                    root.display()
                ))
            })?;

        Ok(root)
    }

    /// The directory `vscode-userdata:` is backed by — `settings.json`,
    /// `keybindings.json`, the caches and the profile state under it.
    ///
    /// It is created before it is registered, because a root is canonicalized
    /// as it is stored and canonicalization needs the directory to exist. The
    /// shape is stock's: the platform's config directory for the app, then
    /// `User`, which is what `%APPDATA%\Code\User` is on a stock desktop
    /// install.
    ///
    /// `TSCODE_USER_DATA_DIR` overrides it, and is this port's stand-in for
    /// stock's `--user-data-dir`: the app parses no command line at all, and
    /// the end-to-end suite has to run against user data that is not the
    /// developer's own.
    async fn user_data_dir(&self) -> Result<Value, ChannelError> {
        let home = match std::env::var_os("TSCODE_USER_DATA_DIR") {
            Some(override_path) => PathBuf::from(override_path),
            None => self
                .app
                .path()
                .app_config_dir()
                .map_err(|error| {
                    ChannelError::no_permissions(format!("cannot resolve the app config directory: {error}"))
                })?
                .join("User"),
        };

        tokio::fs::create_dir_all(&home).await.map_err(|error| {
            ChannelError::no_permissions(format!("cannot create {}: {error}", home.display()))
        })?;

        let root = self.register_root(home).await?;

        json(&UriComponents::file(&root))
    }

    /// Revokes the workspace root. The asset scope stays widened: Tauri's scope
    /// has no removal, and its `forbid_directory` is a separate deny list that
    /// wins over `allow` forever, so using it would make the folder unopenable
    /// for the rest of the process.
    fn unregister_workspace_root(&self, args: &Args) -> Result<Value, ChannelError> {
        let resource: UriComponents = args.at(0)?;
        self.roots.remove_root(resource.to_fs_path());
        Ok(Value::Null)
    }

    fn workspace_roots(&self) -> Result<Value, ChannelError> {
        let roots: Vec<UriComponents> = self
            .roots
            .roots()
            .iter()
            .map(PathBuf::as_path)
            .map(UriComponents::file)
            .collect();
        json(&roots)
    }

    //#endregion
}

#[async_trait::async_trait]
impl ServerChannel for FileChannel {
    async fn call(&self, command: &str, arg: Value) -> Result<Value, ChannelError> {
        let args = Args::new(arg);
        match command {
            "stat" => self.stat(&args).await,
            "realpath" => self.realpath(&args).await,
            "readdir" => self.readdir(&args).await,
            "open" => self.open(&args).await,
            "close" => self.close(&args).await,
            "read" => self.read(&args).await,
            "readFile" => self.read_file(&args).await,
            "write" => self.write(&args).await,
            "writeFile" => self.write_file(&args).await,
            "rename" => self.rename(&args).await,
            "copy" => self.copy(&args).await,
            "cloneFile" => self.clone_file(&args).await,
            "mkdir" => self.mkdir(&args).await,
            "delete" => self.delete(&args).await,
            "chmod" => self.chmod(&args).await,
            "watch" => self.watch.watch(&args).await,
            "unwatch" => self.watch.unwatch(&args),
            "userDataDir" => self.user_data_dir().await,
            "registerWorkspaceRoot" => self.register_workspace_root(&args).await,
            "unregisterWorkspaceRoot" => self.unregister_workspace_root(&args),
            "workspaceRoots" => self.workspace_roots(),
            other => Err(unknown_command(CHANNEL, other)),
        }
    }

    fn listen(&self, event: &str, arg: Value, sink: EventSink) -> Result<Subscription, ChannelError> {
        match event {
            "fileChange" => self.watch.on_file_change(arg, sink),
            other => Err(unknown_event(CHANNEL, other)),
        }
    }
}
