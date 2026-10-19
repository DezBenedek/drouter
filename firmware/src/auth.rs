use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use anyhow::{bail, Result};
use drouter_auth::Credential;
use hkdf::Hkdf;
use serde_json::{json, Value};
use sha2::Sha256;
use srp_state::Pending;
use std::collections::BTreeMap;
use zeroize::Zeroize;
pub const SESSION_SECONDS: u64 = 24 * 60 * 60;
mod srp_state {
    pub struct Pending {
        pub states: Vec<(super::Role, srp::server::SrpServerVerifier<sha2::Sha256>)>,
        pub expires: u64,
    }
}
#[derive(Clone, serde::Serialize, PartialEq)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum Role {
    Admin,
    SimpleMode { profile_id: String },
}
pub struct Session {
    pub role: Role,
    requests: Vec<u64>,
    key: Vec<u8>,
    expires: u64,
    pub elevated_until: u64,
    rx: u64,
    tx: u64,
}
impl Drop for Session {
    fn drop(&mut self) {
        self.key.zeroize();
    }
}
#[derive(Default)]
pub struct Auth {
    pending: BTreeMap<String, Pending>,
    sessions: BTreeMap<String, Session>,
    attempts: Vec<u64>,
    failures: u32,
    blocked_until: u64,
}
impl Auth {
    pub fn start(
        &mut self,
        sid: &str,
        a: &str,
        credential: &Credential,
        now: u64,
    ) -> Result<Value> {
        self.pending.retain(|_, p| p.expires > now);
        self.sessions.retain(|_, s| s.expires > now);
        self.attempts.retain(|t| now.saturating_sub(*t) < 60);
        if now < self.blocked_until
            || self.attempts.len() >= 5
            || self.pending.len() + self.sessions.len() >= 8
        {
            bail!("Authentication unavailable");
        }
        self.attempts.push(now);
        let (b, state) = credential.begin(a)?;
        self.pending.insert(
            sid.into(),
            Pending {
                states: vec![(Role::Admin, state)],
                expires: now + 30,
            },
        );
        Ok(json!({"type":"auth.challenge","salt":credential.salt,"b":b}))
    }
    pub fn add_profiles(
        &mut self,
        sid: &str,
        a: &str,
        profiles: &[crate::config::SimpleProfile],
    ) -> Result<Value> {
        let pending = self
            .pending
            .get_mut(sid)
            .ok_or_else(|| anyhow::anyhow!("Authentication failed"))?;
        let mut challenges = vec![];
        for profile in profiles.iter().filter(|p| p.enabled) {
            let (b, state) = profile.credential.begin(a)?;
            pending.states.push((
                Role::SimpleMode {
                    profile_id: profile.id.clone(),
                },
                state,
            ));
            challenges.push(json!({"salt":profile.credential.salt,"b":b}));
        }
        Ok(json!(challenges))
    }
    pub fn role(&self, sid: &str, now: u64) -> Result<Role> {
        self.sessions
            .get(sid)
            .filter(|s| s.expires > now)
            .map(|s| s.role.clone())
            .ok_or_else(|| anyhow::anyhow!("Authentication required"))
    }
    pub fn prove_many(&mut self, sid: &str, proofs: &[String], now: u64) -> Result<Value> {
        let p = self
            .pending
            .remove(sid)
            .ok_or_else(|| anyhow::anyhow!("Authentication failed"))?;
        let found = p
            .states
            .into_iter()
            .zip(proofs)
            .find(|((_, state), proof)| {
                p.expires > now
                    && proof.len() == 64
                    && hex::decode(proof).is_ok_and(|p| state.verify_client(&p).is_ok())
            });
        let Some(((role, state), _)) = found else {
            self.failures = self.failures.saturating_add(1);
            self.blocked_until = now + (1u64 << self.failures.min(10)).min(900);
            bail!("Authentication failed");
        };
        self.attempts.pop();
        let reply = json!({"type":"auth.ok","proof":hex::encode(state.proof()),"expiresIn":SESSION_SECONDS});
        self.sessions.insert(
            sid.into(),
            Session {
                role,
                requests: vec![],
                key: state.key().to_vec(),
                expires: now + SESSION_SECONDS,
                elevated_until: now + 300,
                rx: 0,
                tx: 0,
            },
        );
        Ok(reply)
    }
    pub fn prove(&mut self, sid: &str, proof: &str, now: u64) -> Result<Value> {
        self.prove_many(sid, &[proof.into()], now)
    }
    pub fn decrypt(&mut self, sid: &str, frame: &Value, now: u64) -> Result<Value> {
        let s = self
            .sessions
            .get_mut(sid)
            .ok_or_else(|| anyhow::anyhow!("Authentication required"))?;
        s.requests.retain(|t| now.saturating_sub(*t) < 60);
        if s.requests.len() >= 180 {
            bail!("Session rate limit exceeded");
        }
        s.requests.push(now);
        let seq = frame["seq"].as_u64().unwrap_or(0);
        if s.expires <= now || seq != s.rx + 1 || seq > u32::MAX as u64 {
            bail!("Session expired or replay detected");
        }
        let data = frame["data"]
            .as_str()
            .filter(|d| d.len() <= 30000)
            .ok_or_else(|| anyhow::anyhow!("Invalid frame"))?;
        let bytes = crypt(false, &s.key, sid, seq, &hex::decode(data)?, false)?;
        s.rx = seq;
        Ok(serde_json::from_slice(&bytes)?)
    }
    pub fn encrypt(&mut self, sid: &str, value: &Value) -> Result<Value> {
        let s = self
            .sessions
            .get_mut(sid)
            .ok_or_else(|| anyhow::anyhow!("Authentication required"))?;
        let mut bytes = serde_json::to_vec(value)?;
        if bytes.len() > 14000 {
            bytes = serde_json::to_vec(
                &json!({"v":1,"id":value["id"],"ok":false,"error":{"code":"capacity","message":"Response exceeds device capacity"}}),
            )?;
        }
        s.tx += 1;
        let data = crypt(true, &s.key, sid, s.tx, &bytes, true)?;
        Ok(json!({"type":"rpc","seq":s.tx,"data":hex::encode(data)}))
    }
    pub fn elevated(&self, sid: &str, now: u64) -> bool {
        self.sessions
            .get(sid)
            .is_some_and(|s| s.elevated_until > now && s.expires > now)
    }
    pub fn revoke_profile(&mut self, profile_id: &str) {
        self.sessions.retain(|_, session| !matches!(&session.role, Role::SimpleMode { profile_id: id } if id == profile_id));
        self.pending.clear();
    }
    pub fn remove(&mut self, sid: &str) {
        self.pending.remove(sid);
        self.sessions.remove(sid);
    }
    pub fn revoke(&mut self) {
        self.sessions.clear();
        self.pending.clear();
    }
}
pub fn crypt(
    encrypt: bool,
    key: &[u8],
    sid: &str,
    seq: u64,
    bytes: &[u8],
    response: bool,
) -> Result<Vec<u8>> {
    let hk = Hkdf::<Sha256>::new(Some(sid.as_bytes()), key);
    let mut derived = [0; 32];
    hk.expand(
        if response {
            b"drouter-response-v1"
        } else {
            b"drouter-request-v1"
        },
        &mut derived,
    )
    .map_err(|_| anyhow::anyhow!("Key derivation failed"))?;
    let cipher = Aes256Gcm::new_from_slice(&derived)?;
    derived.zeroize();
    let mut nonce = [0u8; 12];
    nonce[4..].copy_from_slice(&seq.to_be_bytes());
    let aad = format!("{sid}:{seq}");
    let payload = Payload {
        msg: bytes,
        aad: aad.as_bytes(),
    };
    (if encrypt {
        cipher.encrypt(Nonce::from_slice(&nonce), payload)
    } else {
        cipher.decrypt(Nonce::from_slice(&nonce), payload)
    })
    .map_err(|_| anyhow::anyhow!("Invalid encrypted message"))
}
