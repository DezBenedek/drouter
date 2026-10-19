use crate::{
    auth::{Auth, Role},
    bird_dog::BirdDog,
    config::*,
    discovery,
    network::NetworkState,
    presets, routing,
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
struct WifiChange {
    id: String,
    ssid: String,
    password: Option<String>,
    enabled: Option<bool>,
    priority: Option<u32>,
    #[serde(default)]
    confirm_disconnect: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WifiToggle {
    id: String,
    enabled: bool,
    #[serde(default)]
    confirm_disconnect: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WifiRemove {
    id: String,
    #[serde(default)]
    confirm_disconnect: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Restore {
    identity: String,
    name: String,
    password: String,
    expected_revision: u64,
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
    pub name: String,
    pub password: String,
    pub wifi: Option<WifiProfile>,
    pub wifi_profiles: Option<Vec<WifiProfile>>,
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
    pub errors: u64,
    pub allow_dev: bool,
    pub last_simple_action: std::collections::BTreeMap<String, Instant>,
    pub access_log: std::collections::VecDeque<Value>,
}
impl Device {
    pub fn new(
        mut storage: Box<dyn Storage>,
        api: Box<dyn BirdDog>,
        allow_dev: bool,
    ) -> Result<Self> {
        let mut config = storage.load()?;
        if let Some(c) = &mut config {
            if c.migrate()? {
                c.revision += 1;
                storage.save(c)?;
            }
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
            errors: 0,
            allow_dev,
            last_simple_action: Default::default(),
            access_log: Default::default(),
        })
    }
    pub fn now(&self) -> u64 {
        self.boot.elapsed().as_secs()
    }
    pub fn setup(&mut self, setup: Setup) -> Result<Value> {
        if self.config.is_some() {
            bail!("Setup is already complete. Reload the page to sign in.");
        }
        let mut c = Config::new(&setup.name, &setup.password)?;
        c.ethernet = setup.ethernet;
        c.cloud_enabled = setup.cloud_enabled;
        if let Some(w) = setup.wifi {
            c.wifi.push(w);
        }
        if let Some(profiles) = setup.wifi_profiles {
            c.wifi.extend(profiles);
        }
        for (i, w) in c.wifi.iter_mut().enumerate() {
            w.priority = i as u32;
        }
        c.validate()?;
        self.storage.save(&c)?;
        let result = json!({"name":c.name,"remote_name":c.remote_name()});
        self.config = Some(c);
        Ok(result)
    }
    pub fn setup_network(&self) -> Result<Value> {
        if self.config.is_some() {
            bail!("Setup is already complete. Reload the page to sign in.");
        }
        Ok(json!({"ethernet":self.network.ethernet,"networks":self.network.available_wifi}))
    }
    fn wifi_safety(&self, id: &str, confirmed: bool, remote: bool) -> Result<()> {
        if remote
            && !confirmed
            && self.network.wifi.active.as_deref() == Some(id)
            && !(self.network.ethernet.link && self.network.ethernet.ip.is_some())
        {
            bail!("disconnect_confirmation_required: This is the active remote connection. Confirm that you have local Ethernet or physical recovery access.");
        }
        Ok(())
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
                let a = frame["a"].as_str().unwrap_or("");
                let mut challenge = self.auth.start(sid, a, &c.credential, now)?;
                if frame["multi"] == true {
                    challenge["alternatives"] =
                        self.auth.add_profiles(sid, a, &c.simple_profiles)?;
                }
                Ok(challenge)
            }
            Some("auth.proof") => {
                if let Some(proofs) = frame.get("proofs") {
                    let proofs: Vec<String> = serde_json::from_value(proofs.clone())?;
                    if proofs.len() > 9 {
                        bail!("Invalid proofs");
                    }
                    self.auth.prove_many(sid, &proofs, now)
                } else {
                    self.auth
                        .prove(sid, frame["proof"].as_str().unwrap_or(""), now)
                }
            }
            Some("rpc") => {
                let request = self.auth.decrypt(sid, &frame, now)?;
                let id = request.get("id").cloned().unwrap_or(Value::Null);
                let result = serde_json::from_value::<Request>(request)
                    .map_err(anyhow::Error::from)
                    .and_then(|r| self.execute_session(sid, r, remote));
                let reply = match result {
                    Ok(value) => json!({"v":1,"id":id,"ok":true,"result":value}),
                    Err(e) => {
                        self.errors += 1;
                        let message = e.to_string();
                        let code = message
                            .split_once(':')
                            .map(|(code, _)| code)
                            .filter(|code| {
                                matches!(
                                    *code,
                                    "confirmation_required"
                                        | "revision_conflict"
                                        | "duplicate_password"
                                        | "forbidden"
                                        | "event_locked"
                                        | "invalid_target"
                                        | "rate_limited"
                                        | "invalid_request"
                                        | "disconnect_confirmation_required"
                                )
                            })
                            .unwrap_or("operation_failed");
                        json!({"v":1,"id":id,"ok":false,"error":{"code":code,"message":message}})
                    }
                };
                let encrypted = self.auth.encrypt(sid, &reply)?;
                if reply["ok"] == true && reply["result"]["logout"] == true {
                    self.auth.remove(sid);
                }
                if reply["ok"] == true && reply["result"]["reauthenticate"] == true {
                    self.auth.revoke();
                }
                Ok(encrypted)
            }
            _ => bail!("Unknown frame"),
        }
    }
    fn execute_session(&mut self, sid: &str, r: Request, remote: bool) -> Result<Value> {
        let now = self.now();
        let role = self.auth.role(sid, now)?;
        if r.v != 1 || r.id.is_empty() || r.id.len() > 64 {
            bail!("invalid_request: Invalid protocol request");
        }
        if r.op == "auth.session" || r.op == "auth.login" {
            let _: Empty = parse(&r.params)?;
            return Ok(serde_json::to_value(role)?);
        }
        if r.op == "auth.logout" {
            let _: Empty = parse(&r.params)?;
            return Ok(json!({"logout":true}));
        }
        if let Role::SimpleMode { profile_id } = role {
            let c = self
                .config
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("Setup required"))?;
            let profile = c
                .simple_profiles
                .iter()
                .find(|p| p.id == profile_id && p.enabled)
                .ok_or_else(|| anyhow::anyhow!("forbidden: Profile disabled or removed"))?;
            if r.op == "event.status" {
                let _: Empty = parse(&r.params)?;
                return Ok(json!({"enabled":c.event_mode}));
            }
            if r.op == "simple.actions.list" {
                let _: Empty = parse(&r.params)?;
                return Ok(
                    json!({"id":profile.id,"name":profile.name,"description":profile.description,"locked":c.event_mode,"actions":profile.actions.iter().filter(|a| a.enabled).collect::<Vec<_>>()}),
                );
            }
            if r.op != "simple.action.execute" {
                bail!("forbidden: Administrator access required");
            }
            if c.event_mode {
                bail!("event_locked: Simple Mode is temporarily locked by the administrator");
            }
            let id: Id = parse(&r.params)?;
            let action = profile
                .actions
                .iter()
                .find(|a| a.id == id.id && a.enabled)
                .ok_or_else(|| anyhow::anyhow!("forbidden: Unknown action"))?;
            let receiver = c
                .receivers
                .iter()
                .find(|r| r.id == action.receiver)
                .ok_or_else(|| anyhow::anyhow!("invalid_target: Output removed"))?
                .clone();
            let source = action.source.clone();
            let key = format!("{}:{}", profile_id, action.id);
            if self
                .last_simple_action
                .get(&key)
                .is_some_and(|t| t.elapsed().as_secs() < 2)
            {
                bail!("rate_limited: Wait before repeating this action");
            }
            if self.last_simple_action.len() >= 80 {
                self.last_simple_action
                    .retain(|_, t| t.elapsed().as_secs() < 2);
            }
            if self.last_simple_action.len() >= 80 && !self.last_simple_action.contains_key(&key) {
                bail!("rate_limited: Action capacity reached");
            }
            self.last_simple_action.insert(key, Instant::now());
            self.api.begin_operation();
            return Ok(json!(routing::set(&mut *self.api, &receiver, &source)?));
        }
        self.execute(r, self.auth.elevated(sid, now), remote)
    }
    pub(crate) fn commit(&mut self, mut c: Config) -> Result<()> {
        for (i, w) in c.wifi.iter_mut().enumerate() {
            w.priority = i as u32;
        }
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
                | "wifi.set_enabled"
                | "identity.export"
                | "identity.restore"
                | "settings.update"
                | "sessions.revoke"
                | "factory.reset"
                | "auth.password.change"
                | "simple.create"
                | "simple.update"
                | "simple.delete"
                | "simple.actions.create"
                | "simple.actions.update"
                | "simple.actions.delete"
                | "simple.actions.reorder"
                | "event.enable"
                | "event.disable"
        );
        if mutates && !elevated {
            bail!("Reconnect to authorize this sensitive operation");
        }
        if let Some(result) = self.management(&r, &mut c)? {
            return Ok(result);
        }
        match r.op.as_str() {
            "device.info" => {
                let _: Empty = parse(p)?;
                Ok(
                    json!({"name":c.name,"remote_name":c.remote_name(),"device_id":c.device_id(),"version":env!("CARGO_PKG_VERSION"),"revision":c.revision,"receivers":c.receivers.len(),"cloud_enabled":c.cloud_enabled,"server":c.server,"ethernet_config":c.ethernet,"wifi_policy":c.wifi_policy,"event_mode":c.event_mode}),
                )
            }
            "device.health" => {
                let _: Empty = parse(p)?;
                Ok(
                    json!({"uptime":self.now(),"free_memory":self.network.free_memory,"errors":self.errors,"storage":"healthy","config_bytes":serde_json::to_vec(&c)?.len(),"config_capacity":24576}),
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
                    .map(WifiProfile::public)
                    .collect::<Vec<_>>()))
            }
            "wifi.add" => {
                let update: WifiChange = parse(p)?;
                let old = c.wifi.iter().find(|w| w.id == update.id);
                let w = WifiProfile {
                    id: update.id.clone(),
                    ssid: update.ssid,
                    password: update
                        .password
                        .filter(|s| !s.is_empty())
                        .or_else(|| old.map(|w| w.password.clone()))
                        .ok_or_else(|| anyhow::anyhow!("A new network requires a password"))?,
                    enabled: update
                        .enabled
                        .unwrap_or_else(|| old.is_none_or(|w| w.enabled)),
                    priority: update
                        .priority
                        .unwrap_or_else(|| old.map_or(c.wifi.len() as u32, |w| w.priority)),
                };
                validate_wifi(&w)?;
                if old.is_some_and(|o| !w.enabled || o.ssid != w.ssid || o.password != w.password) {
                    self.wifi_safety(&w.id, update.confirm_disconnect, remote)?;
                }
                if let Some(old) = c.wifi.iter_mut().find(|x| x.id == w.id) {
                    *old = w;
                } else {
                    c.wifi.push(w);
                }
                c.wifi.sort_by_key(|w| w.priority);
                self.commit(c)?;
                Ok(json!({"saved":true}))
            }
            "wifi.remove" => {
                let w: WifiRemove = parse(p)?;
                self.wifi_safety(&w.id, w.confirm_disconnect, remote)?;
                c.wifi.retain(|p| p.id != w.id);
                self.commit(c)?;
                Ok(json!({"removed":true}))
            }
            "wifi.set_enabled" => {
                let w: WifiToggle = parse(p)?;
                if !w.enabled {
                    self.wifi_safety(&w.id, w.confirm_disconnect, remote)?;
                }
                c.wifi
                    .iter_mut()
                    .find(|p| p.id == w.id)
                    .ok_or_else(|| anyhow::anyhow!("Unknown Wi-Fi profile"))?
                    .enabled = w.enabled;
                self.commit(c)?;
                Ok(json!({"saved":true}))
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
                let w: WifiRemove = parse(p)?;
                if let Some(active) = self.network.wifi.active.as_deref() {
                    self.wifi_safety(active, w.confirm_disconnect, remote)?;
                }
                if !c.wifi.iter().any(|p| p.id == w.id && p.enabled) {
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
                if refresh {
                    for saved in &mut c.saved_sources {
                        saved.available = sources.iter().any(|s| s.name == saved.source);
                    }
                    self.commit(c)?;
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
                    self.unique_password(&password, None)?;
                    c.credential = drouter_auth::Credential::new(&password)?;
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
            "identity.export" => {
                let _: Empty = parse(p)?;
                if remote {
                    bail!("Recovery keys are available only through local access");
                }
                Ok(json!({"v":1,"name":c.name,"device_id":c.device_id(),"identity":c.identity}))
            }
            "identity.restore" => {
                if remote {
                    bail!("Identity recovery requires local access");
                }
                let restore: Restore = parse(p)?;
                if restore.expected_revision != c.revision {
                    bail!("Settings changed; refresh and retry");
                }
                if hex::decode(&restore.identity)?.len() != 32 {
                    bail!("Invalid recovery key");
                }
                self.unique_password(&restore.password, None)?;
                c.identity = restore.identity;
                c.name = normalize_name(&restore.name)?;
                use sha2::{Digest, Sha256};
                let salt = hex::encode(Sha256::digest(
                    format!("drouter-srp-salt-v1:{}", &c.device_id()[..32]).as_bytes(),
                ));
                c.credential = drouter_auth::Credential::with_salt(&restore.password, &salt)?;
                self.commit(c)?;
                Ok(json!({"saved":true,"reauthenticate":true}))
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
                Ok(json!({"reauthenticate":true,"reset":true}))
            }
            _ => bail!("Unknown operation"),
        }
    }
}
fn parse<T: DeserializeOwned>(v: &Value) -> Result<T> {
    Ok(serde_json::from_value(v.clone())?)
}
