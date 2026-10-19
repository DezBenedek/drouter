use crate::Shared;
use drouter::{
    config::MAX_MESSAGE,
    remote::{registration, registration_error, registration_failed, same_connection, Backoff},
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
                .await
                .config
                .clone()
                .filter(|c| c.cloud_enabled)
        };
        let Some(config) = config else {
            {
                let mut device = shared.device.lock().await;
                if device.network.cloud != "disabled" {
                    eprintln!("DRouter remote: disabled");
                }
                device.network.cloud = "disabled".into();
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        };
        if !shared.cloud_up.load(std::sync::atomic::Ordering::Relaxed)
            || !shared.device.lock().await.network.online()
        {
            shared.device.lock().await.network.cloud = "offline".into();
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        }
        let url = format!(
            "{}/relay/{}/device",
            config
                .server
                .replacen("https://", "wss://", 1)
                .replacen("http://", "ws://", 1),
            config.device_id()
        );
        shared.device.lock().await.network.cloud = "connecting".into();
        let limits = WebSocketConfig::default()
            .max_message_size(Some(MAX_MESSAGE))
            .max_frame_size(Some(MAX_MESSAGE));
        let connection = tokio::time::timeout(
            Duration::from_secs(10),
            connect_async_with_config(url, Some(limits), false),
        )
        .await;
        match &connection {
            Ok(Err(error)) => eprintln!("DRouter remote connection: {error}"),
            Err(_) => eprintln!("DRouter remote connection timed out"),
            _ => {}
        }
        if let Ok(Ok((mut ws, _))) = connection {
            let mut registered = false;
            let mut remote_sessions = std::collections::BTreeSet::new();
            let connected = std::time::Instant::now();
            let mut timer = tokio::time::interval(Duration::from_secs(1));
            loop {
                tokio::select! {
                    _ = timer.tick() => {
                        let valid = { let d = shared.device.lock().await; d.config.as_ref().is_some_and(|c| c.cloud_enabled && same_connection(c, &config)) && d.network.online() };
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
                                    Some("registered") => { registered=true;let mut d=shared.device.lock().await;d.network.cloud="connected".into();d.network.registered_name=v["name"].as_str().map(str::to_string);d.network.last_cloud_connection=Some(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs());eprintln!("DRouter remote: connected");None },
                                    Some("registration.error") => {let state=registration_error(v["code"].as_str().unwrap_or(""));shared.device.lock().await.network.cloud=state.into();eprintln!("DRouter remote registration: {state}");break;},
                                    Some("forward") if registered => {
                                        let Some(sid) = v["sid"].as_str().filter(|s| s.len() == 36) else { break; };
                                        if remote_sessions.len()<8 {remote_sessions.insert(sid.to_string());}
                                        let shared2 = shared.clone(); let sid2 = sid.to_string(); let frame = v["frame"].clone();
                                        let reply = tokio::task::spawn_blocking(move || shared2.device.blocking_lock().frame(&sid2,frame,true)).await;
                                        reply.ok().map(|frame| json!({"type":"reply","sid":sid,"frame":frame}))
                                    },
                                    Some("leave") => { if let Some(sid) = v["sid"].as_str() { shared.device.lock().await.auth.remove(sid); remote_sessions.remove(sid); } None },
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
                let mut d = shared.device.lock().await;
                for sid in remote_sessions {
                    d.auth.remove(&sid);
                }
            }
        }
        {
            let mut d = shared.device.lock().await;
            if !registration_failed(&d.network.cloud) {
                d.network.cloud = "offline".into();
            }
        }
        for _ in 0..backoff.next_delay() {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let d = shared.device.lock().await;
            if !d
                .config
                .as_ref()
                .is_some_and(|c| same_connection(c, &config))
            {
                backoff.reset();
                break;
            }
        }
    }
}
