//! Terminal transport: one shared channel connection over JSON lines on stdio.
use crate::{application::ApplicationBackend, rpc::Connection};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio::time::timeout;

pub async fn serve() {
    let (lines, mut outgoing) = mpsc::unbounded_channel::<String>();
    let mut writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(line) = outgoing.recv().await {
            if stdout.write_all(line.as_bytes()).await.is_err()
                || stdout.write_all(b"\n").await.is_err()
                || stdout.flush().await.is_err()
            {
                break;
            }
        }
    });
    match ApplicationBackend::new().await {
        Ok(application) => {
            let mut connection = Connection::new(&application, &lines);
            let mut stdin = BufReader::new(tokio::io::stdin()).lines();
            while let Ok(Some(line)) = stdin.next_line().await {
                connection.dispatch(&lines, &line);
            }
            connection.close().await;
        }
        Err(error) => log::error!("host initialization failed: {error}"),
    }
    drop(lines);
    if timeout(Duration::from_secs(2), &mut writer).await.is_err() {
        writer.abort();
    }
}
