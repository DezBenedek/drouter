use crate::config::Config;
use ed25519_dalek::Signer;
use rand::Rng;
use serde_json::{json, Value};
pub fn same_connection(a: &Config, b: &Config) -> bool {
    a.cloud_enabled == b.cloud_enabled
        && a.name == b.name
        && a.identity == b.identity
        && a.server == b.server
}
pub fn registration_error(code: &str) -> &'static str {
    match code {
        "name_unavailable" => "name_unavailable",
        "identity_in_use" => "identity_in_use",
        "invalid_identity" => "identity_rejected",
        _ => "registry_unavailable",
    }
}
pub fn registration_failed(state: &str) -> bool {
    matches!(
        state,
        "name_unavailable" | "identity_in_use" | "identity_rejected" | "registry_unavailable"
    )
}
pub fn registration(config: &Config, challenge: &str) -> Value {
    let name = &config.name;
    let device_id = config.device_id();
    let message = format!("drouter-register-v2\n{device_id}\n{name}\n{challenge}");
    json!({"type":"register","name":name,"deviceId":device_id,"publicKey":config.public_key(),"signature":hex::encode(config.signing_key().sign(message.as_bytes()).to_bytes())})
}
#[derive(Default)]
pub struct Backoff {
    failures: u32,
}
impl Backoff {
    pub fn next_delay(&mut self) -> u64 {
        let cap = (1u64 << self.failures.min(8)).min(300);
        self.failures = self.failures.saturating_add(1);
        rand::thread_rng().gen_range((cap / 2).max(1)..=cap.max(2))
    }
    pub fn reset(&mut self) {
        self.failures = 0;
    }
}
