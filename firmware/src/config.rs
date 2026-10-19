use anyhow::{bail, Result};
use drouter_auth::{random_hex, Credential};
use ed25519_dalek::SigningKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::net::Ipv4Addr;

pub const MAX_RECEIVERS: usize = 16;
pub const MAX_SOURCES: usize = 64;
pub const MAX_PRESETS: usize = 16;
pub const MAX_MESSAGE: usize = 32768;
pub const MAX_WIFI_LIST_BYTES: usize = 13000;
pub const DEFAULT_SERVER: &str = "https://drouter.dezso.hu";
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WifiProfile {
    pub id: String,
    pub ssid: String,
    pub password: String,
    #[serde(default = "enabled_default")]
    pub enabled: bool,
    #[serde(default = "priority_default")]
    pub priority: u32,
}
impl WifiProfile {
    pub fn public(&self) -> serde_json::Value {
        serde_json::json!({"id":self.id,"ssid":self.ssid,"enabled":self.enabled,"priority":self.priority})
    }
}
fn enabled_default() -> bool {
    true
}
fn priority_default() -> u32 {
    u32::MAX
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WifiPolicy {
    pub preferred_check_secs: u64,
    pub retry_secs: u64,
    pub prefer_higher: bool,
}
impl Default for WifiPolicy {
    fn default() -> Self {
        Self {
            preferred_check_secs: 300,
            retry_secs: 15,
            prefer_higher: true,
        }
    }
}
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct EthernetConfig {
    pub address: Option<Ipv4Addr>,
    pub mask: Option<Ipv4Addr>,
    pub gateway: Option<Ipv4Addr>,
    pub dns: Option<Ipv4Addr>,
}
impl EthernetConfig {
    pub fn validate(&self) -> Result<()> {
        if let Some(ip) = self.address {
            let mask = self
                .mask
                .ok_or_else(|| anyhow::anyhow!("Static IP requires a mask"))?;
            let bits = u32::from(mask);
            if bits == 0
                || (!bits).wrapping_add(1) & !bits != 0
                || ip.is_unspecified()
                || ip.is_multicast()
            {
                bail!("Invalid IP or subnet mask");
            }
            if let Some(gw) = self.gateway {
                if u32::from(ip) & bits != u32::from(gw) & bits {
                    bail!("Gateway outside subnet");
                }
            }
        } else if self.mask.is_some() || self.gateway.is_some() {
            bail!("Static fields require an address");
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receiver {
    pub id: String,
    pub label: String,
    pub ip: Ipv4Addr,
    pub port: u16,
    pub channel: u8,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub routes: Vec<(String, String)>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SavedSource {
    pub id: String,
    pub source: String,
    pub original_name: String,
    pub display_name: String,
    pub order: u32,
    pub available: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SimpleAction {
    pub id: String,
    pub label: String,
    pub icon: Option<String>,
    pub receiver: String,
    pub source: String,
    pub enabled: bool,
    pub order: u32,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct SimpleProfile {
    pub id: String,
    pub name: String,
    pub description: String,
    pub credential: Credential,
    pub enabled: bool,
    pub order: u32,
    pub actions: Vec<SimpleAction>,
}
impl SimpleProfile {
    pub fn public(&self) -> serde_json::Value {
        serde_json::json!({"id":self.id,"name":self.name,"description":self.description,"enabled":self.enabled,"order":self.order,"actions":self.actions})
    }
}
fn locked_default() -> bool {
    true
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Config {
    pub schema: u32,
    #[serde(default)]
    pub saved_sources: Vec<SavedSource>,
    #[serde(default)]
    pub simple_profiles: Vec<SimpleProfile>,
    #[serde(default = "locked_default")]
    pub event_mode: bool,
    pub revision: u64,
    pub name: String,
    pub credential: Credential,
    pub identity: String,
    pub wifi: Vec<WifiProfile>,
    pub wifi_policy: WifiPolicy,
    pub ethernet: EthernetConfig,
    pub receivers: Vec<Receiver>,
    pub presets: Vec<Preset>,
    pub cloud_enabled: bool,
    pub server: String,
}
impl Config {
    pub fn new(name: &str, password: &str) -> Result<Self> {
        let identity = random_hex(32);
        let key = SigningKey::from_bytes(&hex::decode(&identity)?.try_into().unwrap());
        let fingerprint = hex::encode(&Sha256::digest(key.verifying_key().as_bytes())[..16]);
        let salt = hex::encode(Sha256::digest(
            format!("drouter-srp-salt-v1:{fingerprint}").as_bytes(),
        ));
        Ok(Self {
            schema: 3,
            saved_sources: vec![],
            simple_profiles: vec![],
            event_mode: false,
            revision: 1,
            name: normalize_name(name)?,
            credential: Credential::with_salt(password, &salt)?,
            identity,
            wifi: vec![],
            wifi_policy: WifiPolicy::default(),
            ethernet: EthernetConfig::default(),
            receivers: vec![],
            presets: vec![],
            cloud_enabled: false,
            server: DEFAULT_SERVER.into(),
        })
    }
    pub fn signing_key(&self) -> SigningKey {
        SigningKey::from_bytes(&hex::decode(&self.identity).unwrap().try_into().unwrap())
    }
    pub fn public_key(&self) -> String {
        hex::encode(self.signing_key().verifying_key().as_bytes())
    }
    pub fn device_id(&self) -> String {
        hex::encode(Sha256::digest(
            self.signing_key().verifying_key().as_bytes(),
        ))
    }
    pub fn remote_name(&self) -> String {
        self.name.clone()
    }
    pub fn migrate(&mut self) -> Result<bool> {
        if self.schema > 3 || self.schema == 0 {
            bail!("Unsupported configuration schema");
        }
        let changed = self.schema < 3;
        if changed {
            if self.schema == 1 {
                for (i, w) in self.wifi.iter_mut().enumerate() {
                    w.priority = i as u32;
                }
            }
            self.schema = 3;
        }
        self.wifi.sort_by_key(|w| w.priority);
        self.validate()?;
        Ok(changed)
    }
    pub fn validate(&self) -> Result<()> {
        if !(1..=3).contains(&self.schema)
            || normalize_name(&self.name)? != self.name
            || self.receivers.len() > MAX_RECEIVERS
            || self.presets.len() > MAX_PRESETS
        {
            bail!("Invalid configuration");
        }
        let identity = hex::decode(&self.identity)?;
        if identity.len() != 32
            || hex::decode(&self.credential.salt)?.len() != 32
            || self.credential.verifier.is_empty()
            || hex::decode(&self.credential.verifier)?.len() > 256
        {
            bail!("Invalid credentials");
        }
        if self.saved_sources.len() > MAX_SOURCES || self.simple_profiles.len() > 8 {
            bail!("Configuration capacity exceeded");
        }
        let mut ids = std::collections::BTreeSet::new();
        let mut names = std::collections::BTreeSet::new();
        for source in &self.saved_sources {
            label(&source.display_name)?;
            if source.id.is_empty()
                || source.id.len() > 32
                || source.source.is_empty()
                || source.source.len() > 256
                || source.original_name.len() > 256
                || !ids.insert(&source.id)
                || !names.insert(&source.source)
            {
                bail!("Invalid saved source");
            }
        }
        if serde_json::to_vec(&self.saved_sources)?.len() > 13000 {
            bail!("Saved sources exceed transport capacity");
        }
        if serde_json::to_vec(
            &self
                .simple_profiles
                .iter()
                .map(SimpleProfile::public)
                .collect::<Vec<_>>(),
        )?
        .len()
            > 13000
        {
            bail!("Simple Modes exceed transport capacity");
        }
        ids.clear();
        for profile in &self.simple_profiles {
            label(&profile.name)?;
            if profile.id.is_empty()
                || profile.id.len() > 32
                || !ids.insert(&profile.id)
                || profile.description.len() > 256
                || !(1..=10).contains(&profile.actions.len())
                || hex::decode(&profile.credential.salt)?.len() != 32
                || profile.credential.verifier.is_empty()
                || hex::decode(&profile.credential.verifier)?.len() > 256
            {
                bail!("Invalid Simple Mode profile");
            }
            let mut buttons = std::collections::BTreeSet::new();
            for action in &profile.actions {
                label(&action.label)?;
                if action.id.is_empty()
                    || action.id.len() > 32
                    || !buttons.insert(&action.id)
                    || action.receiver.len() > 32
                    || action.source.is_empty()
                    || action.source.len() > 256
                    || action.icon.as_ref().is_some_and(|i| i.len() > 32)
                {
                    bail!("Invalid Simple Mode action");
                }
            }
        }
        self.ethernet.validate()?;
        if !(60..=3600).contains(&self.wifi_policy.preferred_check_secs)
            || !(5..=120).contains(&self.wifi_policy.retry_secs)
        {
            bail!("Invalid Wi-Fi timers");
        }
        let mut ids = std::collections::BTreeSet::new();
        for p in &self.wifi {
            validate_wifi(p)?;
            if !ids.insert(&p.id) {
                bail!("Duplicate Wi-Fi profile ID");
            }
        }
        crate::storage::validate_size(&serde_json::to_vec(self)?)?;
        if serde_json::to_vec(
            &self
                .wifi
                .iter()
                .map(WifiProfile::public)
                .collect::<Vec<_>>(),
        )?
        .len()
            > MAX_WIFI_LIST_BYTES
        {
            bail!("Wi-Fi profile list exceeds transport capacity");
        }
        Ok(())
    }
}
pub fn normalize_name(s: &str) -> Result<String> {
    let n = s.trim().to_ascii_lowercase();
    if !(3..=32).contains(&n.len())
        || !n
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        || n.starts_with('-')
        || n.ends_with('-')
        || n.contains("--")
    {
        bail!("Use 3–32 lowercase letters, digits or single hyphens");
    }
    Ok(n)
}
pub fn label(s: &str) -> Result<()> {
    if s.is_empty() || s.len() > 64 || s.chars().any(char::is_control) {
        bail!("Invalid label");
    }
    Ok(())
}
pub fn validate_wifi(p: &WifiProfile) -> Result<()> {
    if p.id.is_empty()
        || p.id.len() > 32
        || p.ssid.is_empty()
        || p.ssid.len() > 32
        || !(8..=63).contains(&p.password.len())
    {
        bail!("WPA2 profiles require an SSID and an 8–63 byte password");
    }
    Ok(())
}
