//! Shared tscode channel protocol for stdio and WebKit messages.
use crate::application::{ApplicationBackend, WindowConnection};
use crate::channel::{self, ChannelError, EventEmitter};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc::{self, UnboundedSender};
use tokio::task::JoinSet;
use tokio::time::timeout;
const PTY_SHUTDOWN: Duration = Duration::from_secs(6);

#[derive(Deserialize)]
struct Request {
    id: u64,
    cmd: String,
    args: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CallArgs {
    channel: String,
    command: String,
    arg: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListenArgs {
    channel: String,
    event: String,
    arg: Value,
    subscription_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnlistenArgs {
    subscription_id: String,
}

/// One line out. Untagged, so a reply carries `id` and a payload carries `event`
/// and the frontend tells them apart by which keys are present.
#[derive(Serialize)]
#[serde(untagged)]
enum Outgoing {
    Result { id: u64, result: Value },
    Error { id: u64, error: String },
    Event { event: String, payload: Value },
}

/// The writer end. Serializing here rather than in the writer task means a
/// message that cannot be serialized is reported to whoever produced it.
fn send(lines: &UnboundedSender<String>, message: &Outgoing) -> Result<(), ChannelError> {
    let line = serde_json::to_string(message)?;
    lines
        .send(line)
        .map_err(|_| ChannelError::unavailable("the host transport is closed"))
}

/// [`EventEmitter`] over the same writer the replies go through, so a payload and
/// a reply cannot interleave inside a line.
struct HostEmitter {
    lines: UnboundedSender<String>,
}

impl EventEmitter for HostEmitter {
    fn emit(&self, event_name: &str, payload: Value) -> Result<(), ChannelError> {
        send(
            &self.lines,
            &Outgoing::Event {
                event: event_name.to_owned(),
                payload,
            },
        )
    }
}

pub struct Connection {
    backend: WindowConnection,
    calls: JoinSet<()>,
}

impl Connection {
    /// Only call on a backend worker. Subscription changes retain arrival order;
    /// ordinary requests are spawned so slow work never holds up cancellation.
    pub fn dispatch(&mut self, lines: &UnboundedSender<String>, frame: &str) {
        match serde_json::from_str::<Request>(frame) {
            Ok(request) => dispatch(self, lines, request),
            Err(error) => log::error!("invalid backend request: {error}"),
        }
    }

    pub async fn serve(
        mut self,
        mut incoming: mpsc::UnboundedReceiver<String>,
        lines: UnboundedSender<String>,
    ) {
        while let Some(frame) = incoming.recv().await {
            self.dispatch(&lines, &frame);
        }
        self.close().await;
    }

    pub fn new(application: &ApplicationBackend, lines: &UnboundedSender<String>) -> Self {
        Self {
            backend: application.connect(Arc::new(HostEmitter {
                lines: lines.clone(),
            })),
            calls: JoinSet::new(),
        }
    }

    pub async fn close(mut self) {
        self.backend.registry.cancel_all();
        // Complete in-flight writes before releasing their handles. Other windows
        // continue serving while this connection drains.
        while self.calls.join_next().await.is_some() {}
        self.backend.files.close_handles().await;
        if timeout(PTY_SHUTDOWN, self.backend.pty.shutdown_all())
            .await
            .is_err()
        {
            log::warn!("host: window terminals did not shut down within {PTY_SHUTDOWN:?}");
        }
    }
}

fn dispatch(connection: &mut Connection, lines: &UnboundedSender<String>, request: Request) {
    let Request { id, cmd, args, .. } = request;
    while connection.calls.try_join_next().is_some() {}
    let registry = &connection.backend.registry;

    match cmd.as_str() {
        "channel_call" => {
            let registry = Arc::clone(registry);
            let lines = lines.clone();
            connection.calls.spawn(async move {
                let outcome = match from_args::<CallArgs>(&cmd, args) {
                    Ok(args) => {
                        channel::channel_call(&registry, &args.channel, &args.command, args.arg)
                            .await
                    }
                    Err(error) => Err(error),
                };
                reply(&lines, id, outcome);
            });
        }
        "channel_listen" => reply(
            lines,
            id,
            from_args::<ListenArgs>(&cmd, args).and_then(|args| {
                channel::channel_listen(
                    registry,
                    &args.channel,
                    &args.event,
                    args.arg,
                    &args.subscription_id,
                )
                .map(|()| Value::Null)
            }),
        ),
        "channel_unlisten" => reply(
            lines,
            id,
            from_args::<UnlistenArgs>(&cmd, args).and_then(|args| {
                channel::channel_unlisten(registry, &args.subscription_id).map(|()| Value::Null)
            }),
        ),
        other => reply(
            lines,
            id,
            Err(ChannelError::unknown(format!("no such host command: {other}")).into()),
        ),
    }
}

/// Answers one request. A reply that cannot be written is logged, not retried:
/// the only way to fail is a closed transport, and then nothing else will arrive
/// either.
fn reply(lines: &UnboundedSender<String>, id: u64, outcome: Result<Value, String>) {
    let message = match outcome {
        Ok(result) => Outgoing::Result { id, result },
        Err(error) => Outgoing::Error { id, error },
    };
    if let Err(error) = send(lines, &message) {
        log::warn!("host: dropping a reply to request {id}: {error}");
    }
}

/// Argument records arrive as one `Value` so a bad one fails here, in the wire
/// error form, rather than taking the connection down.
fn from_args<T: serde::de::DeserializeOwned>(cmd: &str, args: Value) -> Result<T, String> {
    serde_json::from_value(args)
        .map_err(|error| ChannelError::unknown(format!("bad arguments for {cmd}: {error}")).into())
}

//#endregion
