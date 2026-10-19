use crate::{
    auth::Auth, bird_dog::BirdDog, config::*, discovery, network::NetworkState, presets, routing,
    storage::Storage,
};
use anyhow::{bail, Result};
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use std::time::Instant;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub v: u8,
    pub id: String,
    pub op: String,
    pub params: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Id {
    id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Route {
    receiver: String,
    source: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Rename {
    id: String,
    name: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Name {
    name: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Order {
    ids: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub name: Option<String>,
    pub password: Option<String>,
    pub ethernet: Option<EthernetConfig>,
    pub wifi_policy: Option<WifiPolicy>,
    pub cloud_enabled: Option<bool>,
    pub server: Option<String>,
    pub expected_revision: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Setup {
    pub token: String,
    pub name: String,
    pub password: String,
    pub wifi: Option<WifiProfile>,
    pub ethernet: EthernetConfig,
    pub cloud_enabled: bool,
}
pub struct Device {
    pub config: Option<Config>,
    pub auth: Auth,
    pub network: NetworkState,
    pub api: Box<dyn BirdDog>,
    pub storage: Box<dyn Storage>,
    pub boot: Instant,
    pub last_operation: Instant,
    pub setup_token: String,
    pub errors: u64,
    pub allow_dev: bool,
}
impl Device {
    pub fn new(
        storage: Box<dyn Storage>,
        api: Box<dyn BirdDog>,
        setup_token: String,
        allow_dev: bool,
    ) -> Result<Self> {
        let config = storage.load()?;
        if let Some(c) = &config {
            c.validate()?;
        }
        Ok(Self {
            config,
            auth: Auth::default(),
            network: NetworkState {
                cloud: "disabled".into(),
                ..Default::default()
            },
            api,
            storage,
            boot: Instant::now(),
            last_operation: Instant::now(),
            setup_token,
            errors: 0,
            allow_dev,
        })
    }
    pub fn now(&self) -> u64 {
        self.boot.elapsed().as_secs()
    }
    pub fn setup(&mut self, setup: Setup) -> Result<Value> {
        use sha2::{Digest, Sha256};
        if self.config.is_some()
            || Sha256::digest(setup.token.as_bytes()) != Sha256::digest(self.setup_token.as_bytes())
        {
            bail!("Physical setup authorization required");
        }
        let mut c = Config::new(&setup.name, &setup.password)?;
        c.ethernet = setup.ethernet;
        c.cloud_enabled = setup.cloud_enabled;
        if let Some(w) = setup.wifi {
            c.wifi.push(w);
        }
        c.validate()?;
        self.storage.save(&c)?;
        let result = json!({"name":c.name,"remote_name":c.remote_name()});
        self.config = Some(c);
        self.setup_token.clear();
        Ok(result)
    }
    pub fn frame(&mut self, sid: &str, frame: Value, remote: bool) -> Value {
        let result = self.try_frame(sid, frame, remote);
        match result {
            Ok(v) => v,
            Err(_) => {
                self.errors = self.errors.saturating_add(1);
                json!({"type":"error","message":"Request rejected or device unavailable"})
            }
        }
    }
    fn try_frame(&mut self, sid: &str, frame: Value, remote: bool) -> Result<Value> {
        let c = self
            .config
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Setup required"))?;
        if remote && !c.cloud_enabled {
            bail!("Remote access disabled");
        }
        let now = self.now();
        match frame["type"].as_str() {
            Some("auth.start") => {
                self.auth
                    .start(sid, frame["a"].as_str().unwrap_or(""), &c.credential, now)
            }
            Some("auth.proof") => self
                .auth
                .prove(sid, frame["proof"].as_str().unwrap_or(""), now),
            Some("rpc") => {
                let request = self.auth.decrypt(sid, &frame, now)?;
                let id = request.get("id").cloned().unwrap_or(Value::Null);
                let result = serde_json::from_value::<Request>(request)
                    .map_err(anyhow::Error::from)
                    .and_then(|r| self.execute(r, self.auth.elevated(sid, now), remote));
                let reply = match result {
                    Ok(value) => json!({"v":1,"id":id,"ok":true,"result":value}),
                    Err(e) => {
                        self.errors += 1;
                        json!({"v":1,"id":id,"ok":false,"error":{"code":"operation_failed","message":e.to_string()}})
                    }
                };
                let encrypted = self.auth.encrypt(sid, &reply)?;
                if reply["ok"] == true && reply["result"]["reauthenticate"] == true {
                    self.auth.revoke();
                }
                Ok(encrypted)
            }
            _ => bail!("Unknown frame"),
        }
    }
    fn commit(&mut self, mut c: Config) -> Result<()> {
        c.validate()?;
        let previous = self.config.as_ref().unwrap();
        c.revision = previous.revision;
        if serde_json::to_vec(&c)? == serde_json::to_vec(previous)? {
            return Ok(());
        }
        c.revision += 1;
        self.storage.save(&c)?;
        self.config = Some(c);
        Ok(())
    }
    pub fn execute(&mut self, r: Request, elevated: bool, remote: bool) -> Result<Value> {
        if r.v != 1 || r.id.is_empty() || r.id.len() > 64 {
            bail!("Invalid request version or ID");
        }
        self.last_operation = Instant::now();
        self.api.begin_operation();
        let mut c = self
            .config
            .clone()
            .ok_or_else(|| anyhow::anyhow!("Setup required"))?;
        let p = &r.params;
        let mutates = matches!(
            r.op.as_str(),
            "wifi.add"
                | "wifi.remove"
                | "wifi.reorder"
                | "wifi.connect"
                | "settings.update"
                | "sessions.revoke"
                | "factory.reset"
        );
        if mutates && !elevated {
            bail!("Reconnect to authorize this sensitive operation");
        }
        match r.op.as_str() {
            "device.info" => {
                let _: Empty = parse(p)?;
                Ok(
                    json!({"name":c.name,"remote_name":c.remote_name(),"version":env!("CARGO_PKG_VERSION"),"revision":c.revision,"receivers":c.receivers.len(),"cloud_enabled":c.cloud_enabled,"server":c.server,"ethernet_config":c.ethernet,"wifi_policy":c.wifi_policy}),
                )
            }
            "device.health" => {
                let _: Empty = parse(p)?;
                Ok(
                    json!({"uptime":self.now(),"free_memory":self.network.free_memory,"errors":self.errors,"storage":"healthy"}),
                )
            }
            "network.status" => {
                let _: Empty = parse(p)?;
                let mut v = serde_json::to_value(&self.network)?;
                v["active_ssid"] = json!(c
                    .wifi
                    .iter()
                    .find(|p| Some(&p.id) == self.network.wifi.active.as_ref())
                    .map(|p| &p.ssid));
                Ok(v)
            }
            "wifi.list" => {
                let _: Empty = parse(p)?;
                Ok(json!(c
                    .wifi
                    .iter()
                    .map(|w| json!({"id":w.id,"ssid":w.ssid}))
                    .collect::<Vec<_>>()))
            }
            "wifi.add" => {
                let w: WifiProfile = parse(p)?;
                validate_wifi(&w)?;
                if let Some(old) = c.wifi.iter_mut().find(|x| x.id == w.id) {
                    *old = w;
                } else {
                    c.wifi.push(w);
                }
                self.commit(c)?;
                Ok(json!({"saved":true}))
            }
            "wifi.remove" => {
                let w: Id = parse(p)?;
                c.wifi.retain(|p| p.id != w.id);
                self.commit(c)?;
                Ok(json!({"removed":true}))
            }
            "wifi.reorder" => {
                let o: Order = parse(p)?;
                let mut ids = o.ids.clone();
                ids.sort();
                ids.dedup();
                if ids.len() != c.wifi.len()
                    || o.ids.len() != c.wifi.len()
                    || !ids.iter().all(|id| c.wifi.iter().any(|w| &w.id == id))
                {
                    bail!("Provide each saved Wi-Fi ID exactly once");
                }
                c.wifi
                    .sort_by_key(|w| o.ids.iter().position(|id| id == &w.id).unwrap());
                self.commit(c)?;
                Ok(json!({"saved":true}))
            }
            "wifi.connect" => {
                let w: Id = parse(p)?;
                if !c.wifi.iter().any(|p| p.id == w.id) {
                    bail!("Unknown Wi-Fi profile");
                }
                self.network.wifi.request(w.id);
                Ok(json!({"scheduled":true}))
            }
            "receivers.list" => {
                let _: Empty = parse(p)?;
                Ok(json!(c.receivers.iter().map(|r| json!({"config":r,"state":routing::read(&mut *self.api,r),"capabilities":["api2","decode","sources"]})).collect::<Vec<_>>()))
            }
            "receivers.discover" => {
                let _: Empty = parse(p)?;
                Ok(json!(discovery::verified_devices(&mut *self.api)?))
            }
            "receivers.add" => {
                let receiver: Receiver = parse(p)?;
                label(&receiver.label)?;
                if receiver.id.is_empty()
                    || receiver.id.len() > 32
                    || receiver.port == 0
                    || !(1..=4).contains(&receiver.channel)
                    || !(receiver.ip.is_private()
                        || receiver.ip.is_link_local()
                        || self.allow_dev && receiver.ip.is_loopback())
                {
                    bail!("Use a private IPv4 address and channel 1–4");
                }
                self.api.info(&receiver)?;
                if let Some(old) = c.receivers.iter_mut().find(|r| r.id == receiver.id) {
                    *old = receiver;
                } else {
                    c.receivers.push(receiver);
                }
                self.commit(c)?;
                Ok(json!({"saved":true}))
            }
            "receivers.rename" => {
                let n: Rename = parse(p)?;
                label(&n.name)?;
                let receiver = c
                    .receivers
                    .iter_mut()
                    .find(|r| r.id == n.id)
                    .ok_or_else(|| anyhow::anyhow!("Unknown receiver"))?;
                receiver.label = n.name;
                self.commit(c)?;
                Ok(json!({"saved":true}))
            }
            "receivers.remove" => {
                let n: Id = parse(p)?;
                c.receivers.retain(|r| r.id != n.id);
                self.commit(c)?;
                Ok(json!({"removed":true}))
            }
            "sources.list" | "sources.refresh" => {
                let _: Empty = parse(p)?;
                let refresh = r.op == "sources.refresh";
                let mut sources = Vec::new();
                let mut errors = Vec::new();
                for receiver in &c.receivers {
                    match self.api.sources(receiver, refresh) {
                        Ok(found) => {
                            for source in found {
                                if !sources.contains(&source) {
                                    if sources.len() >= MAX_SOURCES {
                                        bail!("Source capacity exceeded");
                                    }
                                    sources.push(source);
                                }
                            }
                        }
                        Err(e) => {
                            errors.push(json!({"receiver":receiver.id,"message":e.to_string()}))
                        }
                    }
                }
                Ok(json!({"sources":sources,"errors":errors}))
            }
            "route.get" => {
                let _: Empty = parse(p)?;
                Ok(json!(c
                    .receivers
                    .iter()
                    .map(|r| routing::read(&mut *self.api, r))
                    .collect::<Vec<_>>()))
            }
            "route.set" => {
                let route: Route = parse(p)?;
                let receiver = c
                    .receivers
                    .iter()
                    .find(|r| r.id == route.receiver)
                    .ok_or_else(|| anyhow::anyhow!("Unknown receiver"))?;
                Ok(json!(routing::set(
                    &mut *self.api,
                    receiver,
                    &route.source
                )?))
            }
            "presets.list" => {
                let _: Empty = parse(p)?;
                Ok(json!(c.presets))
            }
            "presets.create" => {
                let name: Name = parse(p)?;
                label(&name.name)?;
                let mut routes = vec![];
                for receiver in &c.receivers {
                    routes.push((receiver.id.clone(), self.api.active(receiver)?));
                }
                let preset = Preset {
                    id: drouter_auth::random_hex(8),
                    name: name.name,
                    routes,
                };
                c.presets.push(preset.clone());
                self.commit(c)?;
                Ok(json!(preset))
            }
            "presets.update" => {
                let n: Rename = parse(p)?;
                label(&n.name)?;
                let preset = c
                    .presets
                    .iter_mut()
                    .find(|p| p.id == n.id)
                    .ok_or_else(|| anyhow::anyhow!("Unknown preset"))?;
                preset.name = n.name;
                self.commit(c)?;
                Ok(json!({"saved":true}))
            }
            "presets.delete" => {
                let n: Id = parse(p)?;
                c.presets.retain(|p| p.id != n.id);
                self.commit(c)?;
                Ok(json!({"removed":true}))
            }
            "presets.apply" => {
                let n: Id = parse(p)?;
                let preset = c
                    .presets
                    .iter()
                    .find(|p| p.id == n.id)
                    .ok_or_else(|| anyhow::anyhow!("Unknown preset"))?;
                Ok(json!({"results":presets::apply(&mut *self.api,&c.receivers,preset)}))
            }
            "settings.update" => {
                let s: Settings = parse(p)?;
                if s.expected_revision != c.revision {
                    bail!("Settings changed; refresh and retry");
                }
                let reauthenticate =
                    s.password.is_some() || s.name.is_some() || s.cloud_enabled.is_some();
                if let Some(n) = s.name {
                    c.name = normalize_name(&n)?;
                }
                if let Some(password) = s.password {
                    c.credential =
                        drouter_auth::Credential::with_salt(&password, &c.credential.salt)?;
                }
                if let Some(e) = s.ethernet {
                    c.ethernet = e;
                }
                if let Some(w) = s.wifi_policy {
                    c.wifi_policy = w;
                }
                if let Some(enabled) = s.cloud_enabled {
                    c.cloud_enabled = enabled;
                }
                if let Some(server) = s.server {
                    if remote {
                        bail!("Server changes require local access");
                    }
                    if server.len() > 256
                        || !(server.starts_with("https://")
                            || self.allow_dev
                                && (server.starts_with("http://127.0.0.1:")
                                    || server.starts_with("http://localhost:")))
                        || server.contains('@')
                        || server.contains('?')
                        || server.contains('#')
                    {
                        bail!("Use an HTTPS server origin");
                    }
                    c.server = server.trim_end_matches('/').into();
                }
                self.commit(c)?;
                Ok(json!({"saved":true,"reauthenticate":reauthenticate}))
            }
            "sessions.revoke" => {
                let _: Empty = parse(p)?;
                Ok(json!({"reauthenticate":true}))
            }
            "factory.reset" => {
                let _: Empty = parse(p)?;
                if remote {
                    bail!("Factory reset requires local access");
                }
                self.storage.reset()?;
                self.config = None;
                self.setup_token = drouter_auth::random_hex(16);
                Ok(json!({"reauthenticate":true,"reset":true}))
            }
            _ => bail!("Unknown operation"),
        }
    }
}
fn parse<T: DeserializeOwned>(v: &Value) -> Result<T> {
    Ok(serde_json::from_value(v.clone())?)
}
