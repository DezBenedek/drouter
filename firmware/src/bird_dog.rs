use crate::config::{Receiver, MAX_SOURCES};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::net::Ipv4Addr;
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct Source {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ip: Option<Ipv4Addr>,
}
pub trait BirdDog: Send {
    fn begin_operation(&mut self) {}
    fn request(
        &mut self,
        receiver: &Receiver,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value>;
    fn discover(&mut self) -> Result<Vec<Receiver>> {
        bail!("Automatic BirdDog discovery is unavailable for this API; add a receiver by IP")
    }
    fn about(&mut self, receiver: &Receiver) -> Result<Value> {
        let info = self.request(receiver, "GET", "/about", None)?;
        let identity = format!(
            "{} {}",
            info.get("FirmwareVersion")
                .and_then(Value::as_str)
                .unwrap_or(""),
            info.get("HostName").and_then(Value::as_str).unwrap_or("")
        );
        if !identity.to_ascii_lowercase().contains("birddog") {
            bail!("Device did not identify as BirdDog");
        }
        Ok(info)
    }
    fn info(&mut self, receiver: &Receiver) -> Result<Value> {
        let info = self.about(receiver)?;
        self.active(receiver)?;
        Ok(info)
    }
    fn reset_sources(&mut self, receiver: &Receiver) -> Result<Vec<Source>> {
        self.request(receiver, "POST", "/reset", Some(json!({})))?;
        let mut sources = self.sources(receiver, false)?;
        for _ in 0..5 {
            if !sources.is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
            sources = self.sources(receiver, false)?;
        }
        Ok(sources)
    }
    fn sources(&mut self, receiver: &Receiver, refresh: bool) -> Result<Vec<Source>> {
        if refresh {
            self.request(receiver, "POST", "/refresh", Some(json!({})))?;
        }
        let data = self.request(receiver, "GET", "/List", None)?;
        let mut sources = Vec::new();
        if let Some(object) = data.as_object() {
            for (name, value) in object {
                if name == "None" && value == "None" {
                    continue;
                }
                if name.len() > 256 {
                    bail!("Source name too long");
                }
                sources.push(Source {
                    name: name.clone(),
                    ip: source_ip(value),
                });
            }
        } else if let Some(array) = data.as_array() {
            for s in array {
                let name = s
                    .as_str()
                    .or_else(|| s.get("sourceName").and_then(Value::as_str))
                    .ok_or_else(|| anyhow::anyhow!("Invalid source entry"))?;
                if name.len() > 256 {
                    bail!("Source name too long");
                }
                sources.push(Source {
                    name: name.into(),
                    ip: source_ip(s),
                });
            }
        } else {
            bail!("Unsupported BirdDog source list");
        }
        sources.retain(|s| !s.name.trim().is_empty() && s.name != "None");
        sources.sort_by(|a, b| a.name.cmp(&b.name));
        sources.dedup_by(|a, b| a.name == b.name);
        if sources.len() > MAX_SOURCES {
            bail!("Source limit exceeded");
        }
        Ok(sources)
    }

    fn active(&mut self, receiver: &Receiver) -> Result<String> {
        let data = self.request(
            receiver,
            "GET",
            &format!("/connectTo?ChNum={}", receiver.channel),
            None,
        )?;
        data.get("sourceName")
            .and_then(Value::as_str)
            .map(|source| {
                if source == "None" {
                    String::new()
                } else {
                    source.to_string()
                }
            })
            .ok_or_else(|| anyhow::anyhow!("Unsupported BirdDog active source response"))
    }
    fn switch(&mut self, receiver: &Receiver, source: &str) -> Result<()> {
        let path = format!(
            "/connectTo?ChNum={}&sourcename={}&status=Decode",
            receiver.channel,
            percent_encode(source)
        );
        self.request(
            receiver,
            "POST",
            &path,
            Some(json!({"ChNum": receiver.channel.to_string(), "sourceName": source})),
        )?;
        Ok(())
    }
}
fn source_ip(value: &Value) -> Option<Ipv4Addr> {
    let raw = value
        .as_str()
        .or_else(|| value.get("ip").and_then(Value::as_str))
        .or_else(|| value.get("address").and_then(Value::as_str))?;
    let host = raw
        .strip_prefix("ndi://")
        .or_else(|| raw.strip_prefix("http://"))
        .unwrap_or(raw)
        .split('/')
        .next()?
        .split(':')
        .next()?;
    host.parse().ok()
}
pub fn percent_encode(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
