use crate::{bird_dog::BirdDog, config::Receiver, routing};
use anyhow::{bail, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};

const STEPS: [&str; 6] = [
    "Checking receiver connection and current route",
    "Checking the cached NDI source list",
    "Refreshing NDI discovery",
    "Clearing stale NDI entries and rediscovering active sources",
    "Restoring the captured route with readback retries",
    "Verifying the final route",
];

pub struct RepairJob {
    pub owner: String,
    pub receiver: Receiver,
    pub updated: Instant,
    phase: usize,
    source: String,
    cached: Vec<[u8; 8]>,
    notes: Vec<String>,
    refreshed: bool,
    reset: bool,
    restored: bool,
}
impl RepairJob {
    pub fn new(owner: &str, receiver: Receiver) -> Self {
        Self {
            owner: owner.into(),
            receiver,
            updated: Instant::now(),
            phase: 0,
            source: String::new(),
            cached: vec![],
            notes: vec![],
            refreshed: false,
            reset: false,
            restored: false,
        }
    }
    pub fn done(&self) -> bool {
        self.phase == STEPS.len()
    }
    pub fn status(&self, token: &str) -> Value {
        json!({"receiver":self.receiver.id,"token":token,"total":STEPS.len(),
            "completed":self.phase,"done":self.done(),"next":STEPS.get(self.phase),
            "source":self.source,"refreshed":self.refreshed,"reset":self.reset,
            "restored":self.restored,"verified":self.done(),"notes":self.notes})
    }
    fn note(&mut self, message: impl AsRef<str>) {
        if self.notes.len() < 10 {
            self.notes
                .push(message.as_ref().chars().take(240).collect());
        }
    }
    pub fn advance(&mut self, api: &mut dyn BirdDog, allowed: Option<&[String]>) -> Result<()> {
        self.updated = Instant::now();
        let receiver = self.receiver.clone();
        if self.phase > 0 && allowed.is_some_and(|list| !list.contains(&self.source)) {
            bail!("forbidden: Current source is not assigned to this profile");
        }
        match self.phase {
            0 => {
                let mut last_error = String::new();
                let mut captured = None;
                for attempt in 0..3 {
                    if attempt > 0 {
                        std::thread::sleep(Duration::from_millis(150));
                    }
                    match api.active(&receiver) {
                        Ok(source) => {
                            captured = Some(source);
                            break;
                        }
                        Err(error) => last_error = error.to_string(),
                    }
                }
                self.source = captured.ok_or_else(|| anyhow::anyhow!(
                    "Receiver unreachable after 3 checks. Check power, Ethernet, IP address and API port. {last_error}"
                ))?;
                if allowed.is_some_and(|list| !list.contains(&self.source)) {
                    bail!("forbidden: Current source is not assigned to this profile");
                }
                if !last_error.is_empty() {
                    self.note("Recovered a temporary receiver communication failure");
                }
                if self.source.is_empty() {
                    self.note(
                        "No active route: discovery will be repaired without choosing a source",
                    );
                }
            }
            1 => match api.sources(&receiver, false) {
                Ok(sources) => {
                    self.cached = sources.iter().map(|s| source_key(&s.name)).collect();
                    if !self.source.is_empty() && !self.cached.contains(&source_key(&self.source)) {
                        self.note(
                            "The current source was missing from the receiver discovery cache",
                        );
                    }
                }
                Err(error) => self.note(format!(
                    "Source-list read failed; attempting discovery recovery: {error}"
                )),
            },
            2 => {
                for attempt in 0..2 {
                    match api.sources(&receiver, true) {
                        Ok(_) => {
                            self.refreshed = true;
                            break;
                        }
                        Err(error) => {
                            self.note(format!("Discovery refresh failed: {error}"));
                            if attempt == 0 {
                                std::thread::sleep(Duration::from_millis(200));
                            }
                        }
                    }
                }
            }
            3 => match api.reset_sources(&receiver) {
                Ok(sources) => {
                    self.reset = true;
                    self.refreshed = true;
                    let removed = self
                        .cached
                        .iter()
                        .filter(|name| !sources.iter().any(|s| source_key(&s.name) == **name))
                        .count();
                    if removed > 0 {
                        self.note(format!("Removed {removed} stale NDI discovery entries"));
                    }
                    if !self.source.is_empty() && !sources.iter().any(|s| s.name == self.source) {
                        self.note("The original source is still missing; checking discovery again before restoration");
                    }
                }
                // Some firmware revisions lack reset. A working refresh + verified restoration is still useful.
                Err(error) => self.note(format!("NDI reset unavailable or failed: {error}")),
            },
            4 => {
                if !self.source.is_empty() {
                    routing::set(api, &receiver, &self.source)?;
                    self.restored = true;
                }
            }
            5 => {
                routing::verify(api, &receiver, &self.source)?;
                if !self.refreshed {
                    bail!("Route verified, but NDI discovery could not be repaired");
                }
            }
            _ => bail!("Repair has already completed"),
        }
        self.phase += 1;
        Ok(())
    }
}

fn source_key(name: &str) -> [u8; 8] {
    Sha256::digest(name.as_bytes())[..8].try_into().unwrap()
}
