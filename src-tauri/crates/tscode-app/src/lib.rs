//! tscode's Tauri app shell.
//!
//! The Rust process *is* the application: it starts first, creates the window,
//! and lives until quit. Everything it holds across calls — watcher handles, git
//! repository handles, search cancellation tokens, the channel subscription
//! registry — exists because of that.
//!
//! `apps/tscode` is the binary over this crate. It owns the `tauri.conf.json` and
//! expands `generate_context!` against it, so the context arrives as an argument
//! rather than being read here.

pub mod channel;
pub mod channels;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Manager, WebviewWindowBuilder, WindowEvent};
use tscode_fs::{DiskFileSystemProvider, WorkspaceRoots};
use tscode_git::GitService;
use tscode_sl::SlService;

use crate::channel::{ChannelRegistry, ServerChannel};
use crate::channels::file::FileChannel;
use crate::channels::pty::PtyChannel;
use crate::channels::scm::ScmChannel;
use crate::channels::search::SearchChannel;
use crate::channels::sl::SlChannel;
use crate::channels::watch::WatchChannel;

/// The six channels the frontend addresses.
///
/// One `WorkspaceRoots` is shared by every channel: it is the only thing
/// restricting what the webview can reach, so a channel with its own copy would
/// be a hole. `WatchChannel` is registered under its pinned name *and* handed to
/// `FileChannel`, because stock's client calls `watch` / `unwatch` / `fileChange`
/// on the same channel as `stat` and `readFile`.
///
/// `PtyChannel` is deliberately outside that gate: a terminal's cwd is wherever
/// the user's shell is entitled to be, and stock applies no workspace
/// restriction to it either. It is also managed separately, so the window's
/// teardown can shut its shells down.
///
/// Built in `setup` rather than before the builder because `FileChannel`'s
/// `registerWorkspaceRoot` widens the `assetProtocol` scope, which needs the
/// `AppHandle`. `invoke` is dispatched on the event loop, which does not start
/// until `setup` returns, so no command can arrive before the registry exists.
///
/// Nothing is registered as a root here: the frontend registers the resource
/// directory at boot through the same command Open Folder will use, so there is
/// one mechanism rather than a startup path and a user path that can diverge.
fn build_backend(app: &AppHandle) -> (ChannelRegistry, Arc<PtyChannel>) {
    let roots = Arc::new(WorkspaceRoots::new());
    let provider = Arc::new(DiskFileSystemProvider::new((*roots).clone()));
    let watch = Arc::new(WatchChannel::new(Arc::clone(&roots)));
    let pty = Arc::new(PtyChannel::new());

    let mut registry = ChannelRegistry::new();
    registry.register(
        "file",
        Arc::new(FileChannel::new(
            provider,
            Arc::clone(&roots),
            Arc::clone(&watch),
            app.clone(),
        )),
    );
    registry.register("watch", watch);
    let git = Arc::new(GitService::new(Arc::clone(&roots)));
    let sl = Arc::new(SlService::new(Arc::clone(&roots)));
    registry.register("search", Arc::new(SearchChannel::new(Arc::clone(&roots))));
    registry.register("scm", Arc::new(ScmChannel::new(git)));
    registry.register("sl", Arc::new(SlChannel::new(sl)));
    // `Arc::clone(&pty)` cannot unsize here: the expected type flows into the
    // generic parameter, so the coercion has to happen on a plain method call.
    let pty_channel: Arc<dyn ServerChannel> = pty.clone();
    registry.register("pty", pty_channel);

    (registry, pty)
}

/// The label of the one window `tauri.conf.json` declares.
const WINDOW: &str = "main";

/// Creates that window, with the WebView2 user-data folder `WEBVIEW2_USER_DATA_FOLDER` names.
///
/// It is built here rather than by Tauri's own startup — hence `"create": false` in the config —
/// because building it is the only place the data directory can be chosen, and on Windows it has
/// to be: Tauri forces a webview that names no directory to `<local app data>/<identifier>`, which
/// is the *same* folder for every build of this app on the machine. WebView2 serves every client of
/// one folder from a single browser process, so a second build does not get a process of its own —
/// it joins the first's, and a kill or a `Browser.close` aimed at one window reaches the other.
/// That is what put the end-to-end suite and somebody's open editor in one process.
///
/// `WEBVIEW2_USER_DATA_FOLDER` is WebView2's own variable for this, and Tauri's forced directory is
/// exactly what stops the loader from reading it; passing it through gives it back its documented
/// meaning. Unset — every ordinary run — nothing is passed and Tauri forces the folder it always
/// did, so a user's profile stays where it is.
fn create_window(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let Some(config) = app.config().app.windows.iter().find(|window| window.label == WINDOW).cloned() else {
        return Err(format!("tauri.conf.json declares no window labelled {WINDOW}").into());
    };

    let mut builder = WebviewWindowBuilder::from_config(app, &config)?;
    if let Some(folder) = std::env::var_os("WEBVIEW2_USER_DATA_FOLDER") {
        builder = builder.data_directory(PathBuf::from(folder));
    }
    builder.build()?;

    Ok(())
}

/// Moves the window to the physical position `TSCODE_WINDOW_POSITION` names, as `"<x>,<y>"`.
///
/// It exists for the end-to-end suite, which drives a real window on the machine somebody is
/// working on: unset, the window opens where it always did. Off-screen coordinates rather than
/// hidden or minimised, because WebView2 has no headless embedding mode and throttles rendering on
/// host visibility — and every layout-dependent assertion in that suite (a virtualised list's row
/// count, a `getBoundingClientRect`) would then fail plausibly rather than cleanly.
///
/// A value that does not parse is logged and ignored: a mistyped variable must not be the reason
/// the app will not start.
fn place_window(app: &AppHandle) {
    let Ok(value) = std::env::var("TSCODE_WINDOW_POSITION") else {
        return;
    };

    let position = value
        .split_once(',')
        .and_then(|(x, y)| Some(tauri::PhysicalPosition::new(x.trim().parse::<i32>().ok()?, y.trim().parse::<i32>().ok()?)));

    match (position, app.get_webview_window(WINDOW)) {
        (Some(position), Some(window)) => {
            if let Err(error) = window.set_position(position) {
                log::warn!("could not move the window to {value}: {error}");
            }
        }
        (None, _) => log::warn!("TSCODE_WINDOW_POSITION is {value}, which is not \"<x>,<y>\""),
        (_, None) => log::warn!("TSCODE_WINDOW_POSITION is set but this app has no window labelled {WINDOW}"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(context: tauri::Context<tauri::Wry>) {
    #[cfg(target_os = "linux")]
    {
        // WebKitGTK's DMA-BUF renderer is broken on several drivers and paints a
        // blank window; the shared-memory path is the supported fallback.
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Warn
                })
                .build(),
        )
        .setup(|app| {
            let (registry, pty) = build_backend(app.handle());
            app.manage(registry);
            app.manage(pty);
            // After the registry is managed, because this is what starts the frontend that calls
            // into it — the event loop has not started, but the ordering is the invariant.
            create_window(app.handle())?;
            place_window(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // The frontend that owned the subscriptions is gone; its producers
            // would otherwise keep watching and emitting into nothing, and its
            // shells would outlive the window that was drawing them.
            if matches!(event, WindowEvent::Destroyed) {
                window.state::<ChannelRegistry>().cancel_all();
                window.state::<Arc<PtyChannel>>().shutdown_all();
            }
        })
        .invoke_handler(tauri::generate_handler![
            channel::channel_call,
            channel::channel_listen,
            channel::channel_unlisten,
        ])
        .run(context)
        .expect("error while running tscode");
}
