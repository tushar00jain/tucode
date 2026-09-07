//! Shared Rust backend; `run` supplies the terminal stdio entry point.

pub mod channel;
pub mod channels;
pub mod host;

pub mod application;
pub mod rpc;

/// The crates whose logging is wanted. Everything else — `gix`, `ignore`,
/// `globset` — is capped at `Warn`: the frontend inherits this process's stderr,
/// and it is drawing a terminal UI on it.
const OUR_CRATES: [&str; 7] = [
    "tscode_app",
    "tscode_fs",
    "tscode_git",
    "tscode_proc",
    "tscode_pty",
    "tscode_search",
    "tscode_sl",
];

/// Shared diagnostics on stderr; stdout stays available for the terminal protocol.
pub fn init_logging() {
    let ours = if cfg!(debug_assertions) {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Warn
    };

    let mut logger = fern::Dispatch::new().level(log::LevelFilter::Warn);
    for name in OUR_CRATES {
        logger = logger.level_for(name, ours);
    }

    if let Err(error) = logger.chain(std::io::stderr()).apply() {
        eprintln!("tscode-host: cannot install the logger: {error}");
    }
}

/// Runs the standalone terminal host. Mac calls init_logging and owns its runtime.
pub fn run() {
    init_logging();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("error while starting the tscode-host runtime");

    runtime.block_on(host::serve());

    // Blocking work — a `spawn_blocking` file read, the reader parked on a stdin
    // that will never produce again — would otherwise hold the runtime's drop up
    // after the frontend it was serving has gone.
    runtime.shutdown_background();
}
