//! AppKit owns the UI. Wry owns only the editor WebView; backend work runs on Tokio.
#![cfg(target_os = "macos")]

mod asset;

use objc2::{rc::Retained, MainThreadMarker};
use objc2_app_kit::NSView;
use objc2_web_kit::WKWebViewConfiguration;
use raw_window_handle::{
    AppKitWindowHandle, HandleError, HasWindowHandle, RawWindowHandle, WindowHandle,
};
use std::{
    cell::RefCell,
    collections::HashMap,
    ffi::{c_char, c_void, CString},
    ptr::NonNull,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    runtime::Runtime,
    sync::{mpsc, OnceCell},
    task::JoinHandle,
};
use tscode_app::{application::ApplicationBackend, channel::ChannelError, rpc::Connection};
use wry::{WebView, WebViewBuilder, WebViewBuilderExtMacos, WebViewExtMacOS};

type Frames = mpsc::UnboundedSender<String>;
struct Open {
    incoming: mpsc::UnboundedReceiver<String>,
    outgoing: Frames,
}
pub struct MacApp {
    runtime: Runtime,
    windows: mpsc::UnboundedSender<Open>,
    task: JoinHandle<()>,
    application: Arc<OnceCell<Result<ApplicationBackend, ChannelError>>>,
}
struct Editor {
    view: WebView,
}
thread_local! {
    static EDITORS: RefCell<HashMap<u64, Editor>> = RefCell::new(HashMap::new());
    static ERROR: RefCell<CString> = RefCell::new(CString::default());
}
static NEXT_EDITOR: AtomicU64 = AtomicU64::new(1);

// libdispatch schedules only WebView access on AppKit's main thread. No backend
// worker retains or dereferences a Cocoa object; late replies use an editor ID.
#[link(name = "System")]
extern "C" {
    static _dispatch_main_q: c_void;
    fn dispatch_async_f(
        queue: *const c_void,
        context: *mut c_void,
        work: extern "C" fn(*mut c_void),
    );
}
fn on_main(work: impl FnOnce() + Send + 'static) {
    extern "C" fn run(context: *mut c_void) {
        let work = unsafe { Box::from_raw(context.cast::<Box<dyn FnOnce() + Send>>()) };
        work();
    }
    let work: Box<Box<dyn FnOnce() + Send>> = Box::new(Box::new(work));
    unsafe {
        dispatch_async_f(&raw const _dispatch_main_q, Box::into_raw(work).cast(), run);
    }
}
fn error(message: impl ToString) {
    ERROR.with(|slot| {
        *slot.borrow_mut() = CString::new(message.to_string().replace('\0', " ")).unwrap()
    });
}
#[no_mangle]
pub extern "C" fn tucode_editor_error() -> *const c_char {
    ERROR.with(|slot| slot.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn tucode_app_start() -> *mut MacApp {
    tscode_app::init_logging();
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => {
            error(e);
            return std::ptr::null_mut();
        }
    };
    let (windows, mut incoming) = mpsc::unbounded_channel::<Open>();
    let application = Arc::new(OnceCell::new());
    let backend = Arc::clone(&application);
    // Initialization starts with the app, before any WebView connects.
    let task = runtime.spawn(async move {
        let application = backend.get_or_init(ApplicationBackend::new).await;
        let mut sessions = tokio::task::JoinSet::new();
        while let Some(open) = incoming.recv().await {
            while sessions.try_join_next().is_some() {}
            match &application {
                Ok(application) => {
                    let connection = Connection::new(application, &open.outgoing);
                    sessions.spawn(connection.serve(open.incoming, open.outgoing));
                }
                Err(e) => {
                    let message = serde_json::json!({"fatal":e.to_string()}).to_string();
                    sessions.spawn(async move {
                        let mut incoming = open.incoming;
                        // Reply after JS has installed its receiver and issued a request.
                        while incoming.recv().await.is_some() {
                            let _ = open.outgoing.send(message.clone());
                        }
                    });
                }
            }
        }
        while sessions.join_next().await.is_some() {}
    });
    Box::into_raw(Box::new(MacApp {
        runtime,
        windows,
        task,
        application,
    }))
}

/// Takes ownership of the app after its editors have closed. Never wait on AppKit.
#[no_mangle]
pub unsafe extern "C" fn tucode_app_stop(app: *mut MacApp, finished: extern "C" fn()) {
    let app = Box::from_raw(app);
    std::thread::spawn(move || {
        let MacApp {
            runtime,
            windows,
            task,
            application: _,
        } = *app;
        drop(windows);
        runtime.block_on(async {
            let _ = tokio::time::timeout(Duration::from_secs(8), task).await;
        });
        runtime.shutdown_background();
        on_main(move || finished());
    });
}

struct Parent(NonNull<c_void>);
impl HasWindowHandle for Parent {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        Ok(unsafe {
            WindowHandle::borrow_raw(RawWindowHandle::AppKit(AppKitWindowHandle::new(self.0)))
        })
    }
}

/// Called on AppKit's main thread with a view attached to the destination window.
/// Swift retains the returned WKWebView, and releases the editor ID on window close.
#[no_mangle]
pub unsafe extern "C" fn tucode_editor_create(
    app: *const MacApp,
    parent: *mut c_void,
    configuration: *mut c_void,
) -> u64 {
    let result = (|| -> Result<u64, Box<dyn std::error::Error>> {
        let _main = MainThreadMarker::new().ok_or("editor creation must run on the main thread")?;
        let parent = NonNull::new(parent).ok_or("missing parent view")?;
        if (&*parent.as_ptr().cast::<NSView>()).window().is_none() {
            return Err("editor parent has no window".into());
        }
        let configuration = Retained::retain(configuration.cast::<WKWebViewConfiguration>())
            .ok_or("missing WebView configuration")?;
        let id = NEXT_EDITOR.fetch_add(1, Ordering::Relaxed);
        let (commands, incoming) = mpsc::unbounded_channel::<String>();
        let (outgoing, mut replies) = mpsc::unbounded_channel::<String>();
        // Swift installs its final content layout after creation and moves this
        // WKWebView into the editor area. Use normal mode: Wry's child mode
        // overrides performKeyEquivalent and suppresses Command keys in WebKit.
        let application = Arc::clone(&(*app).application);
        let runtime = (*app).runtime.handle().clone();
        let view = WebViewBuilder::new()
            .with_webview_configuration(configuration)
            .with_asynchronous_custom_protocol("asset".into(), move |_, request, responder| {
                let application = Arc::clone(&application);
                runtime.spawn(async move {
                    let response = match application.get_or_init(ApplicationBackend::new).await {
                        Ok(backend) => asset::respond(backend, request).await,
                        Err(_) => asset::error_response(503),
                    };
                    responder.respond(response);
                });
            })
            .with_devtools(true)
            .with_ipc_handler(move |request| {
                let _ = commands.send(request.into_body());
            })
            .build(&Parent(parent))?;
        (*app)
            .windows
            .send(Open { incoming, outgoing })
            .map_err(|_| "backend has stopped")?;
        (*app).runtime.spawn(async move {
            while let Some(frame) = replies.recv().await {
                let mut script = format!("globalThis.__tucodeBackendMessage?.({frame});");
                // Batch bursts so terminal output does not flood the AppKit queue.
                for _ in 0..63 {
                    let Ok(frame) = replies.try_recv() else {
                        break;
                    };
                    script.push_str(&format!("globalThis.__tucodeBackendMessage?.({frame});"));
                }
                on_main(move || {
                    EDITORS.with(|editors| {
                        if let Some(editor) = editors.borrow().get(&id) {
                            if let Err(e) = editor.view.evaluate_script(&script) {
                                eprintln!("WebView reply: {e}");
                            }
                        }
                    })
                });
            }
        });
        EDITORS.with(|editors| editors.borrow_mut().insert(id, Editor { view }));
        Ok(id)
    })();
    match result {
        Ok(id) => id,
        Err(e) => {
            error(e);
            0
        }
    }
}

#[no_mangle]
pub extern "C" fn tucode_editor_view(id: u64) -> *mut c_void {
    EDITORS.with(|editors| {
        editors
            .borrow()
            .get(&id)
            .map_or(std::ptr::null_mut(), |editor| {
                Retained::as_ptr(&editor.view.webview()).cast_mut().cast()
            })
    })
}
#[no_mangle]
pub extern "C" fn tucode_editor_close(id: u64) {
    // Dropping Wry removes its handler, closes the command sender, and lets the
    // backend drain this window. Other windows keep their independent sessions.
    EDITORS.with(|editors| {
        editors.borrow_mut().remove(&id);
    });
}
