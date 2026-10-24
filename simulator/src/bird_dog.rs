use anyhow::{bail, Result};
use axum::{
    extract::{Query, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use drouter::{
    bird_dog::BirdDog,
    config::{Receiver, MAX_MESSAGE},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::Read,
    net::Ipv4Addr,
    sync::{Arc, Mutex},
    time::Duration,
};
#[derive(Clone, Serialize, Deserialize)]
pub struct VirtualReceiver {
    pub active: String,
    pub sources: Vec<String>,
    pub stale_sources: Vec<String>,
    pub resets: u32,
    pub restarts: u32,
    pub reboots: u32,
    pub online: bool,
    pub ignore_switch: bool,
    pub delay_ms: u64,
    pub active_failures: u32,
    pub list_failures: u32,
    pub refresh_failures: u32,
    pub switch_failures: u32,
    pub lag_reads: u32,
    pub pending_source: Option<(String, u32)>,
    pub forget_route_on_reset: bool,
}
impl Default for VirtualReceiver {
    fn default() -> Self {
        Self {
            active: "Studio (Camera A)".into(),
            sources: vec![
                "Studio (Camera A)".into(),
                "Studio (Camera B)".into(),
                "Graphics (Program)".into(),
            ],
            stale_sources: vec![],
            resets: 0,
            restarts: 0,
            reboots: 0,
            online: true,
            ignore_switch: false,
            delay_ms: 0,
            active_failures: 0,
            list_failures: 0,
            refresh_failures: 0,
            switch_failures: 0,
            lag_reads: 0,
            pending_source: None,
            forget_route_on_reset: false,
        }
    }
}
pub type Virtual = Arc<Mutex<VirtualReceiver>>;
pub fn receiver(port: u16, index: usize) -> Receiver {
    Receiver {
        id: format!("virtual-{port}"),
        label: format!("BirdDog {}", index + 1),
        ip: Ipv4Addr::LOCALHOST,
        port,
        channel: 1,
    }
}
pub async fn serve(port: u16, state: Virtual) -> Result<()> {
    let app = Router::new()
        .route("/about", get(about))
        .route("/List", get(sources))
        .route("/connectTo", get(active).post(switch))
        .route("/refresh", post(refresh))
        .route("/reset", post(reset_sources))
        .route("/restart", post(restart))
        .route("/reboot", post(reboot))
        .with_state(state);
    axum::serve(
        tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await?,
        app,
    )
    .await?;
    Ok(())
}
async fn check(state: &Virtual) -> Result<VirtualReceiver, StatusCode> {
    let s = state.lock().unwrap().clone();
    if !s.online {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    if s.delay_ms > 0 {
        tokio::time::sleep(Duration::from_millis(s.delay_ms.min(10000))).await;
    }
    Ok(s)
}
async fn about(State(s): State<Virtual>) -> Result<Json<Value>, StatusCode> {
    check(&s).await?;
    Ok(Json(
        json!({"FirmwareVersion":"BirdDog Virtual 2.0","HostName":"birddog-simulator","Status":"active"}),
    ))
}
async fn sources(State(s): State<Virtual>) -> Result<Json<Value>, StatusCode> {
    check(&s).await?;
    let mut s = s.lock().unwrap();
    if s.list_failures > 0 {
        s.list_failures -= 1;
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    let s = s.clone();
    let list: serde_json::Map<String, Value> = s
        .sources
        .into_iter()
        .chain(s.stale_sources)
        .map(|name| (name, json!("127.0.0.1")))
        .collect();
    Ok(Json(json!(list)))
}
async fn active(State(s): State<Virtual>) -> Result<Json<Value>, StatusCode> {
    check(&s).await?;
    let mut s = s.lock().unwrap();
    if s.active_failures > 0 {
        s.active_failures -= 1;
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    if let Some((source, remaining)) = s.pending_source.take() {
        if remaining == 0 {
            s.active = source;
        } else {
            s.pending_source = Some((source, remaining - 1));
        }
    }
    Ok(Json(json!({"sourceName":s.active})))
}
async fn switch(
    State(s): State<Virtual>,
    Query(q): Query<HashMap<String, String>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, StatusCode> {
    let current = check(&s).await?;
    let source = body["sourceName"]
        .as_str()
        .or_else(|| q.get("sourcename").map(String::as_str))
        .ok_or(StatusCode::BAD_REQUEST)?;
    if !current.sources.iter().any(|n| n == source) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut state = s.lock().unwrap();
    if state.switch_failures > 0 {
        state.switch_failures -= 1;
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    if !current.ignore_switch {
        if state.lag_reads > 0 {
            let lag = state.lag_reads;
            state.pending_source = Some((source.into(), lag));
        } else {
            state.active = source.into();
        }
    }
    Ok(Json(json!({"sourceName":source})))
}
async fn refresh(State(s): State<Virtual>) -> Result<Json<Value>, StatusCode> {
    check(&s).await?;
    let mut s = s.lock().unwrap();
    if s.refresh_failures > 0 {
        s.refresh_failures -= 1;
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    Ok(Json(json!({"refreshed":true})))
}
async fn reset_sources(State(s): State<Virtual>) -> Result<Json<Value>, StatusCode> {
    check(&s).await?;
    let mut state = s.lock().unwrap();
    state.stale_sources.clear();
    state.resets += 1;
    if state.forget_route_on_reset {
        state.active.clear();
        state.pending_source = None;
    }
    Ok(Json(json!({})))
}
async fn restart(State(s): State<Virtual>) -> Result<Json<Value>, StatusCode> {
    check(&s).await?;
    s.lock().unwrap().restarts += 1;
    Ok(Json(json!({})))
}
async fn reboot(State(s): State<Virtual>) -> Result<Json<Value>, StatusCode> {
    check(&s).await?;
    s.lock().unwrap().reboots += 1;
    Ok(Json(json!({})))
}
pub struct HttpBirdDog {
    pub deadline: std::time::Instant,
    pub agent: ureq::Agent,
    pub virtual_ports: Vec<u16>,
    pub ethernet_up: Arc<std::sync::atomic::AtomicBool>,
}
impl HttpBirdDog {
    pub fn new(virtual_ports: Vec<u16>, ethernet_up: Arc<std::sync::atomic::AtomicBool>) -> Self {
        Self {
            deadline: std::time::Instant::now() + Duration::from_secs(10),
            agent: ureq::AgentBuilder::new()
                .timeout(Duration::from_secs(2))
                .redirects(0)
                .build(),
            virtual_ports,
            ethernet_up,
        }
    }
}
impl BirdDog for HttpBirdDog {
    fn begin_operation(&mut self) {
        self.deadline = std::time::Instant::now() + Duration::from_secs(10);
    }
    fn request(
        &mut self,
        r: &Receiver,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        if std::time::Instant::now() >= self.deadline {
            bail!("Operation deadline exceeded");
        }
        if !self.ethernet_up.load(std::sync::atomic::Ordering::Relaxed) {
            bail!("Ethernet link is down");
        }
        let url = format!("http://{}:{}{}", r.ip, r.port, path);
        let request = self.agent.request(method, &url);
        let response = if let Some(body) = body {
            request.send_json(body)?
        } else {
            request.call()?
        };
        let mut data = Vec::new();
        response
            .into_reader()
            .take((MAX_MESSAGE + 1) as u64)
            .read_to_end(&mut data)?;
        if data.len() > MAX_MESSAGE {
            bail!("BirdDog response exceeds capacity");
        }
        if method == "POST" {
            return Ok(serde_json::from_slice(&data).unwrap_or(json!({})));
        }
        Ok(serde_json::from_slice(&data)?)
    }
    fn discover(&mut self) -> Result<Vec<Receiver>> {
        Ok(self
            .virtual_ports
            .iter()
            .enumerate()
            .map(|(index, p)| receiver(*p, index))
            .collect())
    }
}
