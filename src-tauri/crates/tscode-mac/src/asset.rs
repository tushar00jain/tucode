//! Browser resource transport, backed by the same filesystem permissions as IPC.
use tscode_app::{application::ApplicationBackend, channel::ChannelErrorCode};
use wry::http::{Request, Response};

pub async fn respond(backend: &ApplicationBackend, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() != "GET" {
        return error_response(405);
    }
    if request.uri().scheme_str() != Some("asset")
        || request.uri().authority().map(|value| value.as_str()) != Some("localhost")
    {
        return error_response(400);
    }
    let Some(path) = url::Url::parse(&format!("file://{}", request.uri().path()))
        .ok()
        .and_then(|url| url.to_file_path().ok())
    else {
        return error_response(400);
    };
    match backend.read_resource(&path).await {
        Ok(bytes) => response(
            200,
            content_type(path.extension().and_then(|ext| ext.to_str()).unwrap_or("")),
            bytes,
        ),
        Err(error) => error_response(match error.code {
            ChannelErrorCode::NoPermissions => 403,
            ChannelErrorCode::FileNotFound | ChannelErrorCode::FileNotADirectory => 404,
            ChannelErrorCode::FileIsADirectory => 400,
            _ => 500,
        }),
    }
}

fn content_type(extension: &str) -> &'static str {
    match extension.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "tif" | "tiff" => "image/tiff",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "css" => "text/css",
        "js" | "mjs" => "text/javascript",
        "json" => "application/json",
        "wasm" => "application/wasm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
}

fn response(status: u16, mime: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Access-Control-Allow-Origin", "tucode://app")
        .header("Cache-Control", "no-store")
        .body(body)
        .expect("static response headers")
}

pub fn error_response(status: u16) -> Response<Vec<u8>> {
    response(status, "text/plain", Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::{path::Path, sync::Arc};
    use tscode_app::channel::{ChannelError, EventEmitter, ServerChannel};

    struct Events;
    impl EventEmitter for Events {
        fn emit(&self, _: &str, _: Value) -> Result<(), ChannelError> {
            Ok(())
        }
    }
    fn request(path: &Path) -> Request<Vec<u8>> {
        let uri = url::Url::from_file_path(path)
            .unwrap()
            .to_string()
            .replacen("file://", "asset://localhost", 1);
        Request::builder().uri(uri).body(Vec::new()).unwrap()
    }

    #[tokio::test]
    async fn asset_reads_follow_registered_roots_and_file_changes() {
        let fixture = tempfile::tempdir().unwrap();
        std::env::set_var("TSCODE_USER_DATA_DIR", fixture.path().join("profile"));
        let backend = ApplicationBackend::new().await.unwrap();
        std::env::remove_var("TSCODE_USER_DATA_DIR");
        let connection = backend.connect(Arc::new(Events));
        let root = fixture.path().join("one");
        let second = fixture.path().join("two");
        for directory in [&root, &second] {
            std::fs::create_dir(directory).unwrap();
        }
        let image = root.join("logo # % café.PNG");
        let svg = second.join("logo.svg");
        let private = fixture.path().join("private.png");
        std::fs::write(&image, b"png bytes").unwrap();
        std::fs::write(&svg, b"<svg/>").unwrap();
        std::fs::write(&private, b"private").unwrap();
        assert_eq!(respond(&backend, request(&image)).await.status(), 403);
        for directory in [&root, &second] {
            connection
                .files
                .call(
                    "registerWorkspaceRoot",
                    json!({"scheme":"file","path":directory}),
                )
                .await
                .unwrap();
        }
        let loaded = respond(&backend, request(&image)).await;
        assert_eq!(loaded.status(), 200);
        assert_eq!(loaded.headers()["content-type"], "image/png");
        assert_eq!(
            loaded.headers()["access-control-allow-origin"],
            "tucode://app"
        );
        assert_eq!(loaded.body(), b"png bytes");
        assert_eq!(
            respond(&backend, request(&svg)).await.headers()["content-type"],
            "image/svg+xml"
        );
        std::fs::write(&image, b"updated").unwrap();
        assert_eq!(respond(&backend, request(&image)).await.body(), b"updated");
        assert_eq!(
            respond(&backend, request(&root.join("missing.png")))
                .await
                .status(),
            404
        );
        assert_eq!(respond(&backend, request(&private)).await.status(), 403);
        assert_eq!(
            respond(&backend, request(&root.join("../private.png")))
                .await
                .status(),
            403
        );
        std::os::unix::fs::symlink(&private, root.join("escape.png")).unwrap();
        assert_eq!(
            respond(&backend, request(&root.join("escape.png")))
                .await
                .status(),
            403
        );
        let mut write = request(&image);
        *write.method_mut() = wry::http::Method::POST;
        assert_eq!(respond(&backend, write).await.status(), 405);
        connection
            .files
            .call(
                "unregisterWorkspaceRoot",
                json!({"scheme":"file","path":root.canonicalize().unwrap()}),
            )
            .await
            .unwrap();
        assert_eq!(respond(&backend, request(&image)).await.status(), 403);
    }
}
