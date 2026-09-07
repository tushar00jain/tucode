//! Application services outlive every window connection.

use std::path::PathBuf;
use std::sync::Arc;

use tscode_fs::{DiskFileSystemProvider, WorkspaceRoots};
use tscode_git::GitService;
use tscode_sl::SlService;

use crate::channel::{ChannelError, ChannelRegistry, EventEmitter, ServerChannel};
use crate::channels::{
    file::FileChannel, from_fs_error, pty::PtyChannel, scm::ScmChannel, search::SearchChannel,
    sl::SlChannel, watch::WatchChannel,
};

pub struct ApplicationBackend {
    roots: Arc<WorkspaceRoots>,
    files: Arc<DiskFileSystemProvider>,
    user_data_home: PathBuf,
}

impl ApplicationBackend {
    pub async fn new() -> Result<Self, ChannelError> {
        // Keep the shared tscode/tucode profile location stable.
        let home = match std::env::var_os("TSCODE_USER_DATA_DIR") {
            Some(path) => PathBuf::from(path),
            None => dirs::config_dir()
                .ok_or_else(|| {
                    ChannelError::unavailable("cannot resolve the application config directory")
                })?
                .join("dev.tscode.app")
                .join("User"),
        };
        tokio::fs::create_dir_all(&home)
            .await
            .map_err(ChannelError::from)?;
        let roots = Arc::new(WorkspaceRoots::new());
        let user_data_home = roots
            .add_application_root(home)
            .await
            .map_err(from_fs_error)?;
        let files = Arc::new(DiskFileSystemProvider::new((*roots).clone()));
        Ok(Self {
            roots,
            files,
            user_data_home,
        })
    }

    pub fn connect(&self, emitter: Arc<dyn EventEmitter>) -> WindowConnection {
        let watch = Arc::new(WatchChannel::new(Arc::clone(&self.roots)));
        let files = Arc::new(FileChannel::new(
            Arc::clone(&self.files),
            Arc::clone(&self.roots),
            Arc::clone(&watch),
            self.user_data_home.clone(),
        ));
        let pty = Arc::new(PtyChannel::new());
        let mut registry = ChannelRegistry::new(emitter);
        registry.register("file", files.clone());
        registry.register("watch", watch);
        registry.register(
            "scm",
            Arc::new(ScmChannel::new(Arc::new(GitService::new(Arc::clone(
                &self.roots,
            ))))),
        );
        registry.register(
            "sl",
            Arc::new(SlChannel::new(Arc::new(SlService::new(Arc::clone(
                &self.roots,
            ))))),
        );
        registry.register(
            "search",
            Arc::new(SearchChannel::new(Arc::clone(&self.roots))),
        );
        let pty_channel: Arc<dyn ServerChannel> = pty.clone();
        registry.register("pty", pty_channel);
        WindowConnection {
            registry: Arc::new(registry),
            files,
            pty,
        }
    }
}

/// Registries, open handles, watchers, searches and terminals belong to the connection.
/// The disk provider (including write locks) and application data belong to the app.
pub struct WindowConnection {
    pub registry: Arc<ChannelRegistry>,
    pub files: Arc<FileChannel>,
    pub pty: Arc<PtyChannel>,
}
