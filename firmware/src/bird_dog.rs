use crate::config::{Receiver, MAX_SOURCES};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct Source {
    pub name: String,
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
    fn info(&mut self, receiver: &Receiver) -> Result<Value> {
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
        self.active(receiver)?;
        Ok(info)
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
                sources.push(Source { name: name.clone() });
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
                sources.push(Source { name: name.into() });
            }
        } else {
            bail!("Unsupported BirdDog source list");
        }
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
            .map(str::to_string)
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
