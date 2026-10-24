mod bird_dog;
mod remote;
mod storage;
use anyhow::Result;
use axum::{
    extract::{
        ws::{Message, WebSocket},
        DefaultBodyLimit, Path, State, WebSocketUpgrade,
    },
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use drouter::{
    config::MAX_MESSAGE,
    web::{Device, Setup},
};
use serde_json::{json, Value};
use std::{
    net::Ipv4Addr,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
#[derive(Clone)]
pub struct Shared {
    device: Arc<tokio::sync::Mutex<Device>>,
    virtuals: Vec<bird_dog::Virtual>,
    available_wifi: Arc<Mutex<Vec<String>>>,
    ethernet_up: Arc<AtomicBool>,
    cloud_up: Arc<AtomicBool>,
    slots: Arc<tokio::sync::Semaphore>,
}
#[tokio::main]
async fn main() -> Result<()> {
    let root = std::env::var("DROUTER_STATE").unwrap_or(".drouter-state".into());
    let store = storage::FileStorage::open(root)?;
    let bird_port: u16 = std::env::var("DROUTER_BIRDDOG_PORT_BASE")
        .unwrap_or("9001".into())
        .parse()?;
    anyhow::ensure!(
        (1..65535).contains(&bird_port),
        "Invalid virtual BirdDog base port"
    );
    let bird_ports = [bird_port, bird_port + 1];
    let ethernet_up = Arc::new(AtomicBool::new(true));
    let bird_api = bird_dog::HttpBirdDog::new(bird_ports.to_vec(), ethernet_up.clone());
    let device = Device::new(Box::new(store), Box::new(bird_api), true)?;
    let mut virtuals = vec![];
    for port in bird_ports {
        let s = Arc::new(Mutex::new(bird_dog::VirtualReceiver::default()));
        virtuals.push(s.clone());
        tokio::spawn(async move {
            if let Err(e) = bird_dog::serve(port, s).await {
                eprintln!("Virtual BirdDog failed: {e}");
            }
        });
    }
    let shared = Shared {
        device: Arc::new(tokio::sync::Mutex::new(device)),
        virtuals,
        available_wifi: Arc::new(Mutex::new(vec![
            "School-WiFi".into(),
            "Studio-WiFi".into(),
            "Backup-Hotspot".into(),
        ])),
        ethernet_up,
        cloud_up: Arc::new(AtomicBool::new(true)),
        slots: Arc::new(tokio::sync::Semaphore::new(8)),
    };
    tokio::spawn(remote::run(shared.clone()));
    let network = shared.clone();
    tokio::spawn(async move {
        loop {
            {
                let mut d = network.device.lock().await;
                d.network.available_wifi = network.available_wifi.lock().unwrap().clone();
                if let Some(c) = d.config.clone() {
                    let now = d.now();
                    let busy = d.last_operation.elapsed() < Duration::from_secs(5);
                    d.network.wifi.choose(
                        &c.wifi,
                        &network.available_wifi.lock().unwrap(),
                        &c.wifi_policy,
                        now,
                        busy,
                    );
                }
                d.network.wifi.connected = d.network.wifi.active.is_some();
                d.network.ethernet.link = network.ethernet_up.load(Ordering::Relaxed);
                d.network.ethernet.ip = d.network.ethernet.link.then(|| {
                    d.config
                        .as_ref()
                        .and_then(|c| c.ethernet.address)
                        .map(|ip| ip.to_string())
                        .unwrap_or("192.168.100.20".into())
                });
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
    let app = Router::new()
        .route("/", get(index))
        .route("/assets/{*file}", get(asset))
        .route("/bootstrap", get(bootstrap))
        .route("/setup", post(setup))
        .route("/setup/network", post(setup_network))
        .route("/session", post(session))
        .route("/api", post(api))
        .route("/ws", get(ws))
        .route("/sim/faults", post(faults))
        .layer(DefaultBodyLimit::max(MAX_MESSAGE))
        .with_state(shared);
    let port: u16 = std::env::var("DROUTER_PORT")
        .unwrap_or("8080".into())
        .parse()?;
    println!("DRouter local interface: http://127.0.0.1:{port}");
    axum::serve(
        tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await?,
        app,
    )
    .await?;
    Ok(())
}
async fn index() -> Response {
    asset_file("index.html").await
}
async fn asset(Path(file): Path<String>) -> Response {
    asset_file(&file).await
}
async fn asset_file(file: &str) -> Response {
    if file.contains("..") || file.contains('\\') {
        return StatusCode::NOT_FOUND.into_response();
    }
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../firmware/web");
    let mime = if file.ends_with(".html") {
        "text/html"
    } else if file.ends_with(".css") {
        "text/css"
    } else if file.ends_with(".wasm") {
        "application/wasm"
    } else {
        "text/javascript"
    };
    match tokio::fs::read(root.join(format!("{file}.gz"))).await {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, mime),
                (header::CONTENT_ENCODING, "gzip"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => match tokio::fs::read(root.join(file)).await {
            Ok(bytes) => (
                [
                    (header::CONTENT_TYPE, mime),
                    (header::CACHE_CONTROL, "no-store"),
                ],
                bytes,
            )
                .into_response(),
            Err(_) => StatusCode::NOT_FOUND.into_response(),
        },
    }
}
async fn bootstrap(State(s): State<Shared>) -> Json<Value> {
    let d = s.device.lock().await;
    Json(json!({"setup":d.config.is_none(),"name":d.config.as_ref().map(|c| &c.name)}))
}
fn local_origin(headers: &HeaderMap) -> bool {
    match (
        headers.get("origin").and_then(|x| x.to_str().ok()),
        headers.get("host").and_then(|x| x.to_str().ok()),
    ) {
        (Some(origin), Some(host)) => origin == format!("http://{host}"),
        (None, _) => true,
        _ => false,
    }
}
async fn setup(State(s): State<Shared>, headers: HeaderMap, Json(setup): Json<Setup>) -> Response {
    if !local_origin(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    tokio::task::spawn_blocking(move || match s.device.blocking_lock().setup(setup) {
        Ok(v) => Json(v).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":e.to_string()})),
        )
            .into_response(),
    })
    .await
    .unwrap()
}
async fn setup_network(
    State(s): State<Shared>,
    headers: HeaderMap,
    Json(_v): Json<Value>,
) -> Response {
    if !local_origin(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    match s.device.lock().await.setup_network() {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::CONFLICT, Json(json!({"error":e.to_string()}))).into_response(),
    }
}
async fn session(headers: HeaderMap) -> Response {
    if !local_origin(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    Json(json!({"sid":drouter_auth::random_hex(18)})).into_response()
}
async fn api(State(s): State<Shared>, headers: HeaderMap, Json(v): Json<Value>) -> Response {
    if !local_origin(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(sid) = v["sid"]
        .as_str()
        .filter(|s| s.len() == 36 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(str::to_string)
    else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let Ok(_permit) = s.slots.clone().try_acquire_owned() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    tokio::task::spawn_blocking(move || {
        let _permit = _permit;
        let mut device = s.device.blocking_lock();
        let reply = device.frame(&sid, v["frame"].clone(), false);
        Json(reply).into_response()
    })
    .await
    .unwrap()
}
async fn ws(State(s): State<Shared>, headers: HeaderMap, upgrade: WebSocketUpgrade) -> Response {
    if !local_origin(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Ok(permit) = s.slots.clone().try_acquire_owned() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    upgrade
        .max_message_size(MAX_MESSAGE)
        .max_frame_size(MAX_MESSAGE)
        .on_upgrade(move |socket| socket_loop(socket, s, permit))
}
async fn socket_loop(mut socket: WebSocket, s: Shared, _permit: tokio::sync::OwnedSemaphorePermit) {
    let sid = drouter_auth::random_hex(18);
    if socket
        .send(Message::Text(
            json!({"type":"hello","sid":sid}).to_string().into(),
        ))
        .await
        .is_err()
    {
        return;
    }
    while let Ok(Some(Ok(message))) = tokio::time::timeout(
        Duration::from_secs(drouter::auth::SESSION_SECONDS),
        socket.recv(),
    )
    .await
    {
        if let Message::Text(text) = message {
            let Ok(v) = serde_json::from_str(&text) else {
                break;
            };
            let s2 = s.clone();
            let sid2 = sid.clone();
            let reply = tokio::task::spawn_blocking(move || {
                let mut device = s2.device.blocking_lock();
                device.frame(&sid2, v, false)
            })
            .await
            .unwrap();
            if socket
                .send(Message::Text(reply.to_string().into()))
                .await
                .is_err()
            {
                break;
            }
        } else if matches!(message, Message::Close(_)) {
            break;
        }
    }
    s.device.lock().await.auth.remove(&sid);
}
async fn faults(State(s): State<Shared>, headers: HeaderMap, Json(v): Json<Value>) -> Response {
    let token = std::env::var("DROUTER_SIM_CONTROL").unwrap_or_default();
    if token.len() < 16
        || headers
            .get("x-simulator-token")
            .and_then(|x| x.to_str().ok())
            != Some(token.as_str())
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    if let Some(up) = v["ethernet"].as_bool() {
        s.ethernet_up.store(up, Ordering::Relaxed);
    }
    if let Some(up) = v["cloud"].as_bool() {
        s.cloud_up.store(up, Ordering::Relaxed);
    }
    if let Some(wifi) = v["wifi"].as_array() {
        *s.available_wifi.lock().unwrap() = wifi
            .iter()
            .filter_map(|x| x.as_str().map(str::to_string))
            .take(64)
            .collect();
    }
    if let Some(index) = v["receiver"].as_u64() {
        if let Some(state) = s.virtuals.get(index as usize) {
            let mut state = state.lock().unwrap();
            if let Some(sources) = v["sources"].as_array() {
                if sources.len() > 64
                    || sources
                        .iter()
                        .any(|s| s.as_str().is_none_or(|s| s.is_empty() || s.len() > 256))
                {
                    return StatusCode::BAD_REQUEST.into_response();
                }
                state.sources = sources
                    .iter()
                    .map(|s| s.as_str().unwrap().to_string())
                    .collect();
            }
            if let Some(stale) = v["stale_sources"].as_array() {
                if stale.len() > 64
                    || stale
                        .iter()
                        .any(|v| v.as_str().is_none_or(|s| s.is_empty() || s.len() > 256))
                {
                    return StatusCode::BAD_REQUEST.into_response();
                }
                state.stale_sources = stale
                    .iter()
                    .map(|v| v.as_str().unwrap().to_string())
                    .collect();
            }
            if let Some(active) = v["active"].as_str() {
                if active.len() > 256 {
                    return StatusCode::BAD_REQUEST.into_response();
                }
                state.active = active.into();
                state.pending_source = None;
            }
            if let Some(online) = v["online"].as_bool() {
                state.online = online;
            }
            if let Some(ignore) = v["ignore_switch"].as_bool() {
                state.ignore_switch = ignore;
            }
            for key in [
                "active_failures",
                "list_failures",
                "refresh_failures",
                "switch_failures",
                "lag_reads",
            ] {
                if let Some(value) = v[key].as_u64() {
                    let value = value.min(20) as u32;
                    match key {
                        "active_failures" => state.active_failures = value,
                        "list_failures" => state.list_failures = value,
                        "refresh_failures" => state.refresh_failures = value,
                        "switch_failures" => state.switch_failures = value,
                        _ => state.lag_reads = value,
                    }
                }
            }
            if let Some(value) = v["forget_route_on_reset"].as_bool() {
                state.forget_route_on_reset = value;
            }
            if let Some(delay) = v["delay_ms"].as_u64() {
                state.delay_ms = delay.min(10000);
            }
        }
    }
    Json(json!({"ok":true,"receivers":s.virtuals.iter().map(|s| s.lock().unwrap().clone()).collect::<Vec<_>>()})).into_response()
}
