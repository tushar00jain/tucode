use serde_json::{json, Value};
use std::time::Duration;
use tokio::{sync::mpsc, time::timeout};
use tscode_app::{application::ApplicationBackend, rpc::Connection};

static PROFILE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn application(profile: &tempfile::TempDir) -> ApplicationBackend {
    std::env::set_var("TSCODE_USER_DATA_DIR", profile.path());
    let app = ApplicationBackend::new().await.unwrap();
    std::env::remove_var("TSCODE_USER_DATA_DIR");
    app
}

struct Client {
    connection: Connection,
    send: mpsc::UnboundedSender<String>,
    receive: mpsc::UnboundedReceiver<String>,
}
impl Client {
    fn new(app: &ApplicationBackend) -> Self {
        let (send, receive) = mpsc::unbounded_channel();
        Self {
            connection: Connection::new(app, &send),
            send,
            receive,
        }
    }
    fn request(&mut self, id: u64, cmd: &str, args: Value) {
        self.connection.dispatch(
            &self.send,
            &json!({"id":id,"cmd":cmd,"args":args}).to_string(),
        );
    }
    async fn next(&mut self) -> Value {
        let frame = timeout(Duration::from_secs(5), self.receive.recv())
            .await
            .unwrap()
            .unwrap();
        serde_json::from_str(&frame).unwrap()
    }
    async fn call(&mut self, command: &str, arg: Value) -> Value {
        self.request(
            1,
            "channel_call",
            json!({"channel":"file","command":command,"arg":arg}),
        );
        loop {
            let message = self.next().await;
            if message["id"] == 1 {
                return message;
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shared_profile_independent_handles_events_and_window_shutdown() {
    let _guard = PROFILE.lock().await;
    let workspace = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    let app = application(&profile).await;
    let mut left = Client::new(&app);
    let mut right = Client::new(&app);
    let user = left.call("userDataDir", json!([])).await["result"].clone();
    assert_eq!(right.call("userDataDir", json!([])).await["result"], user);
    let uri = |path: &std::path::Path| json!({"scheme":"file","path":path.to_str().unwrap()});
    let settings = uri(&std::path::Path::new(user["path"].as_str().unwrap()).join("settings.json"));
    assert!(left
        .call(
            "writeFile",
            json!([settings,{"data":[123,125]},{"create":true,"overwrite":true}])
        )
        .await
        .get("error")
        .is_none());
    assert_eq!(
        right.call("readFile", json!([settings])).await["result"]["data"],
        json!([123, 125])
    );
    let handle = left.call("open", json!([settings, {}])).await["result"].clone();
    assert!(right.call("read", json!([handle, 0, 2])).await["error"]
        .as_str()
        .unwrap()
        .contains("does not belong"));
    let right_handle = right.call("open", json!([settings, {}])).await["result"].clone();
    let root = left
        .call("registerWorkspaceRoot", json!([uri(workspace.path())]))
        .await["result"]
        .clone();
    for client in [&mut left, &mut right] {
        client.request(2,"channel_listen",json!({"channel":"file","event":"fileChange","arg":["watch"],"subscriptionId":"same-id"}));
        assert_eq!(client.next().await["id"], 2);
        assert!(client
            .call(
                "watch",
                json!(["watch","same-request",root,{"recursive":true,"excludes":[]}])
            )
            .await
            .get("error")
            .is_none());
    }
    std::fs::write(workspace.path().join("before.txt"), "one").unwrap();
    assert_eq!(left.next().await["event"], "tscode:sub:same-id");
    assert_eq!(right.next().await["event"], "tscode:sub:same-id");
    left.connection.close().await;
    // Drain any coalesced events from the first write before issuing another call.
    while right.receive.try_recv().is_ok() {}
    assert!(right
        .call("read", json!([right_handle, 0, 2]))
        .await
        .get("error")
        .is_none());
    std::fs::write(workspace.path().join("after.txt"), "two").unwrap();
    let mut after = false;
    for _ in 0..10 {
        let event = right.next().await;
        if event.to_string().contains("after.txt") {
            after = true;
            break;
        }
    }
    assert!(after);
    let mut third = Client::new(&app);
    assert_eq!(
        third.call("readFile", json!([settings])).await["result"]["data"],
        json!([123, 125])
    );
    third.connection.close().await;
    right.connection.close().await;
}

#[tokio::test]
async fn subscription_changes_keep_arrival_order_and_bad_calls_do_not_poison_connection() {
    let _guard = PROFILE.lock().await;
    let profile = tempfile::tempdir().unwrap();
    let app = application(&profile).await;
    let mut client = Client::new(&app);
    client.request(
        1,
        "channel_listen",
        json!({"channel":"file","event":"fileChange","arg":["watch"],"subscriptionId":"once"}),
    );
    client.request(2, "channel_unlisten", json!({"subscriptionId":"once"}));
    assert_eq!(client.next().await["id"], 1);
    assert_eq!(client.next().await["id"], 2);
    client.request(
        3,
        "channel_call",
        json!({"channel":"missing","command":"stat","arg":[]}),
    );
    assert!(client.next().await["error"].is_string());
    assert!(client.call("userDataDir", json!([])).await["result"].is_object());
    client.connection.close().await;
    drop(profile);
}
