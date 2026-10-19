use crate::Shared;
use drouter::{
    config::MAX_MESSAGE,
    remote::{registration, Backoff},
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::time::Duration;
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
};
pub async fn run(shared: Shared) {
    let mut backoff = Backoff::default();
    loop {
        let config = {
            shared
                .device
                .lock()
                .unwrap()
                .config
                .clone()
                .filter(|c| c.cloud_enabled)
        };
        let Some(config) = config else {
            shared.device.lock().unwrap().network.cloud = "disabled".into();
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        };
        if !shared.cloud_up.load(std::sync::atomic::Ordering::Relaxed)
            || !shared.device.lock().unwrap().network.online()
        {
            shared.device.lock().unwrap().network.cloud = "offline".into();
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        }
        let name = config.remote_name();
        let url = format!(
            "{}/relay/{name}/device",
            config
                .server
                .replacen("https://", "wss://", 1)
                .replacen("http://", "ws://", 1)
        );
        shared.device.lock().unwrap().network.cloud = "connecting".into();
        let limits = WebSocketConfig::default()
            .max_message_size(Some(MAX_MESSAGE))
            .max_frame_size(Some(MAX_MESSAGE));
        if let Ok(Ok((mut ws, _))) = tokio::time::timeout(
            Duration::from_secs(10),
            connect_async_with_config(url, Some(limits), false),
        )
        .await
        {
            let mut registered = false;
            let mut remote_sessions = std::collections::BTreeSet::new();
            let connected = std::time::Instant::now();
            let mut timer = tokio::time::interval(Duration::from_secs(1));
            loop {
                tokio::select! {
                    _ = timer.tick() => {
                        let valid = { let d = shared.device.lock().unwrap(); d.config.as_ref().is_some_and(|c| c.cloud_enabled && c.remote_name() == name && c.server == config.server) && d.network.online() };
                        if !valid || !shared.cloud_up.load(std::sync::atomic::Ordering::Relaxed) || !registered && connected.elapsed().as_secs() > 10 { let _ = ws.close(None).await; break; }
                        if registered && connected.elapsed().as_secs() > 30 { backoff.reset(); }
                    },
                    incoming = ws.next() => {
                        let Some(Ok(message)) = incoming else { break; };
                        match message {
                            Message::Text(text) => {
                                let Ok(v) = serde_json::from_str::<Value>(&text) else { break; };
                                let outgoing = match v["type"].as_str() {
                                    Some("challenge") => Some(registration(&config, v["nonce"].as_str().unwrap_or(""))),
                                    Some("registered") => { registered = true; shared.device.lock().unwrap().network.cloud = "connected".into(); None },
                                    Some("forward") if registered => {
                                        let Some(sid) = v["sid"].as_str().filter(|s| s.len() == 36) else { break; };
                                        if remote_sessions.len()<8 {remote_sessions.insert(sid.to_string());}
                                        let shared2 = shared.clone(); let sid2 = sid.to_string(); let frame = v["frame"].clone();
                                        let reply = tokio::task::spawn_blocking(move || shared2.device.lock().unwrap().frame(&sid2,frame,true)).await;
                                        reply.ok().map(|frame| json!({"type":"reply","sid":sid,"frame":frame}))
                                    },
                                    Some("leave") => { if let Some(sid) = v["sid"].as_str() { shared.device.lock().unwrap().auth.remove(sid); remote_sessions.remove(sid); } None },
                                    _ => None,
                                };
                                if let Some(outgoing) = outgoing { if ws.send(Message::text(outgoing.to_string())).await.is_err() { break; } }
                            },
                            Message::Ping(bytes) => { if ws.send(Message::Pong(bytes)).await.is_err() { break; } },
                            Message::Close(_) => break,
                            _ => {},
                        }
                    }
                }
            }
            {
                let mut d = shared.device.lock().unwrap();
                for sid in remote_sessions {
                    d.auth.remove(&sid);
                }
            }
        }
        {
            let mut d = shared.device.lock().unwrap();
            d.network.cloud = "offline".into();
        }
        tokio::time::sleep(Duration::from_secs(backoff.next_delay())).await;
    }
}
