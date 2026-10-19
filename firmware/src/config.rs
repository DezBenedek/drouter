use anyhow::{bail, Result};
use drouter_auth::{random_hex, Credential};
use ed25519_dalek::SigningKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::net::Ipv4Addr;

pub const MAX_RECEIVERS: usize = 16;
pub const MAX_SOURCES: usize = 64;
pub const MAX_PRESETS: usize = 16;
pub const MAX_WIFI: usize = 8;
pub const MAX_MESSAGE: usize = 32768;
pub const DEFAULT_SERVER: &str = "https://drouter.dezso.hu";
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WifiProfile {
    pub id: String,
    pub ssid: String,
    pub password: String,
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
pub struct Config {
    pub schema: u32,
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
            schema: 1,
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
    pub fn remote_name(&self) -> String {
        format!(
            "{}--{}",
            self.name,
            hex::encode(&Sha256::digest(self.signing_key().verifying_key().as_bytes())[..16])
        )
    }
    pub fn validate(&self) -> Result<()> {
        if self.schema != 1
            || normalize_name(&self.name)? != self.name
            || self.wifi.len() > MAX_WIFI
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
        self.ethernet.validate()?;
        if !(60..=3600).contains(&self.wifi_policy.preferred_check_secs)
            || !(5..=120).contains(&self.wifi_policy.retry_secs)
        {
            bail!("Invalid Wi-Fi timers");
        }
        for p in &self.wifi {
            validate_wifi(p)?;
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
