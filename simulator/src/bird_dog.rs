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
    pub online: bool,
    pub ignore_switch: bool,
    pub delay_ms: u64,
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
            online: true,
            ignore_switch: false,
            delay_ms: 0,
        }
    }
}
pub type Virtual = Arc<Mutex<VirtualReceiver>>;
pub fn receiver(port: u16) -> Receiver {
    Receiver {
        id: format!("virtual-{port}"),
        label: format!("BirdDog {}", port - 9000),
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
    let s = check(&s).await?;
    let list: serde_json::Map<String, Value> = s
        .sources
        .into_iter()
        .map(|name| (name, json!("127.0.0.1")))
        .collect();
    Ok(Json(json!(list)))
}
async fn active(State(s): State<Virtual>) -> Result<Json<Value>, StatusCode> {
    let s = check(&s).await?;
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
    if !current.ignore_switch {
        s.lock().unwrap().active = source.into();
    }
    Ok(Json(json!({"sourceName":source})))
}
async fn refresh(State(s): State<Virtual>) -> Result<Json<Value>, StatusCode> {
    check(&s).await?;
    Ok(Json(json!({"refreshed":true})))
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
        Ok(self.virtual_ports.iter().map(|p| receiver(*p)).collect())
    }
}
