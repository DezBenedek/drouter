use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use anyhow::{bail, Result};
use drouter_auth::Credential;
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use srp_state::Pending;
use std::collections::BTreeMap;
use zeroize::Zeroize;
pub const SESSION_SECONDS: u64 = 24 * 60 * 60;
pub const SETTINGS_ACCESS_SECONDS: u64 = 6 * 60 * 60;
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
    resume_until: u64,
    ticket: Option<String>,
    rx: u64,
    tx: u64,
}
impl Drop for Session {
    fn drop(&mut self) {
        self.key.zeroize();
    }
}
struct ResumeTicket {
    secret: Vec<u8>,
    role: Role,
    owner: String,
    expires: u64,
    session_expires: u64,
    elevated_until: u64,
}
impl Drop for ResumeTicket {
    fn drop(&mut self) {
        self.secret.zeroize();
    }
}
struct ResumeChallenge {
    ticket: String,
    nonce: String,
    expires: u64,
}
#[derive(Default)]
pub struct Auth {
    pending: BTreeMap<String, Pending>,
    tickets: BTreeMap<String, ResumeTicket>,
    resume_pending: BTreeMap<String, ResumeChallenge>,
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
        self.cleanup(now);
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
        self.logout(sid);
        self.sessions.insert(
            sid.into(),
            Session {
                role,
                requests: vec![],
                key: state.key().to_vec(),
                expires: now + SESSION_SECONDS,
                elevated_until: now + SETTINGS_ACCESS_SECONDS,
                resume_until: now + SETTINGS_ACCESS_SECONDS,
                ticket: None,
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
    fn cleanup(&mut self, now: u64) {
        self.pending.retain(|_, p| p.expires > now);
        self.sessions.retain(|_, s| s.expires > now);
        self.tickets.retain(|_, t| t.expires > now);
        self.resume_pending
            .retain(|_, p| p.expires > now && self.tickets.contains_key(&p.ticket));
        self.attempts.retain(|t| now.saturating_sub(*t) < 60);
    }
    pub fn issue_resume(&mut self, sid: &str, now: u64) -> Result<Value> {
        self.cleanup(now);
        let session = self
            .sessions
            .get(sid)
            .filter(|s| s.expires > now && s.resume_until > now)
            .ok_or_else(|| anyhow::anyhow!("Resume window expired"))?;
        if self.tickets.len() >= 16
            && !session
                .ticket
                .as_ref()
                .is_some_and(|id| self.tickets.contains_key(id))
        {
            bail!("Session capacity reached");
        }
        let id = drouter_auth::random_hex(16);
        let secret = drouter_auth::random_hex(32);
        let ticket = ResumeTicket {
            secret: hex::decode(&secret)?,
            role: session.role.clone(),
            owner: sid.into(),
            expires: session.resume_until.min(session.expires),
            session_expires: session.expires,
            elevated_until: session.elevated_until,
        };
        let expires_in = ticket.expires - now;
        let session = self.sessions.get_mut(sid).unwrap();
        if let Some(old) = session.ticket.replace(id.clone()) {
            self.tickets.remove(&old);
        }
        self.tickets.insert(id.clone(), ticket);
        Ok(json!({"ticket":id,"secret":secret,"expiresIn":expires_in}))
    }
    pub fn resume_start(&mut self, sid: &str, ticket: &str, now: u64) -> Result<Value> {
        self.cleanup(now);
        if now < self.blocked_until
            || self.attempts.len() >= 5
            || self.resume_pending.len() >= 8
            || self.sessions.contains_key(sid)
            || self.pending.contains_key(sid)
        {
            bail!("Authentication unavailable");
        }
        self.attempts.push(now);
        let ticket_data = self
            .tickets
            .get(ticket)
            .ok_or_else(|| anyhow::anyhow!("Authentication unavailable"))?;
        // Transfer may replace its original active session even at the eight-session limit.
        if self.sessions.len() + self.pending.len() >= 8
            && !self.sessions.contains_key(&ticket_data.owner)
        {
            bail!("Authentication unavailable");
        }
        let nonce = drouter_auth::random_hex(32);
        let proof = resume_proof(&ticket_data.secret, "server", sid, ticket, &nonce)?;
        self.resume_pending.insert(
            sid.into(),
            ResumeChallenge {
                ticket: ticket.into(),
                nonce: nonce.clone(),
                expires: now + 30,
            },
        );
        Ok(json!({"type":"auth.resume.challenge","nonce":nonce,"proof":proof}))
    }
    pub fn resume_prove(&mut self, sid: &str, proof: &str, now: u64) -> Result<Value> {
        let pending = self
            .resume_pending
            .remove(sid)
            .ok_or_else(|| anyhow::anyhow!("Authentication failed"))?;
        let ticket = self
            .tickets
            .get(&pending.ticket)
            .ok_or_else(|| anyhow::anyhow!("Authentication failed"))?;
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&ticket.secret)?;
        mac.update(resume_transcript("client", sid, &pending.ticket, &pending.nonce).as_bytes());
        if pending.expires <= now
            || ticket.expires <= now
            || hex::decode(proof)
                .ok()
                .is_none_or(|bytes| mac.verify_slice(&bytes).is_err())
        {
            self.failures = self.failures.saturating_add(1);
            self.blocked_until = now + (1u64 << self.failures.min(10)).min(900);
            bail!("Authentication failed");
        }
        let confirmation = resume_proof(
            &ticket.secret,
            "accepted",
            sid,
            &pending.ticket,
            &pending.nonce,
        )?;
        let key = resume_key(&ticket.secret, sid, &pending.ticket, &pending.nonce)?;
        let ticket = self.tickets.remove(&pending.ticket).unwrap();
        self.sessions.remove(&ticket.owner);
        if self.sessions.len() + self.pending.len() >= 8 {
            bail!("Authentication unavailable");
        }
        let expires_in = ticket.session_expires - now;
        self.sessions.insert(
            sid.into(),
            Session {
                role: ticket.role.clone(),
                requests: vec![],
                key,
                expires: ticket.session_expires,
                elevated_until: ticket.elevated_until,
                resume_until: ticket.expires,
                ticket: None,
                rx: 0,
                tx: 0,
            },
        );
        self.attempts.pop();
        Ok(json!({"type":"auth.resumed","proof":confirmation,"expiresIn":expires_in}))
    }
    pub fn logout(&mut self, sid: &str) {
        if let Some(session) = self.sessions.get(sid) {
            if let Some(ticket) = &session.ticket {
                self.tickets.remove(ticket);
            }
        }
        self.remove(sid);
    }
    pub fn revoke_resume_profile(&mut self, profile_id: &str) {
        self.tickets.retain(|_, ticket| !matches!(&ticket.role, Role::SimpleMode { profile_id: id } if id == profile_id));
        self.resume_pending
            .retain(|_, p| self.tickets.contains_key(&p.ticket));
    }
    pub fn revoke_profile(&mut self, profile_id: &str) {
        self.sessions.retain(|_, session| !matches!(&session.role, Role::SimpleMode { profile_id: id } if id == profile_id));
        self.revoke_resume_profile(profile_id);
        self.pending.clear();
    }
    pub fn remove(&mut self, sid: &str) {
        self.pending.remove(sid);
        self.resume_pending.remove(sid);
        self.sessions.remove(sid);
    }
    pub fn revoke(&mut self) {
        self.sessions.clear();
        self.pending.clear();
        self.tickets.clear();
        self.resume_pending.clear();
    }
}
fn resume_transcript(kind: &str, sid: &str, ticket: &str, nonce: &str) -> String {
    format!("drouter-resume-v1\n{kind}\n{sid}\n{ticket}\n{nonce}")
}
pub(crate) fn resume_proof(
    secret: &[u8],
    kind: &str,
    sid: &str,
    ticket: &str,
    nonce: &str,
) -> Result<String> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(secret)?;
    mac.update(resume_transcript(kind, sid, ticket, nonce).as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}
pub(crate) fn resume_key(secret: &[u8], sid: &str, ticket: &str, nonce: &str) -> Result<Vec<u8>> {
    let mut key = vec![0; 32];
    Hkdf::<Sha256>::new(Some(&hex::decode(nonce)?), secret)
        .expand(
            format!("drouter-resume-key-v1\n{sid}\n{ticket}").as_bytes(),
            &mut key,
        )
        .map_err(|_| anyhow::anyhow!("Key derivation failed"))?;
    Ok(key)
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

#[cfg(test)]
mod resume_tests {
    use super::*;
    #[test]
    fn full_session_capacity_still_allows_replacing_the_owning_session() {
        let mut auth = Auth::default();
        for index in 0..8 {
            auth.sessions.insert(
                index.to_string(),
                Session {
                    role: Role::Admin,
                    requests: vec![],
                    key: vec![1; 32],
                    expires: 86400,
                    elevated_until: 21600,
                    resume_until: 21600,
                    ticket: None,
                    rx: 0,
                    tx: 0,
                },
            );
        }
        let saved = auth.issue_resume("0", 0).unwrap();
        let ticket = saved["ticket"].as_str().unwrap();
        let secret = hex::decode(saved["secret"].as_str().unwrap()).unwrap();
        let challenge = auth.resume_start("new", ticket, 100).unwrap();
        let proof = resume_proof(
            &secret,
            "client",
            "new",
            ticket,
            challenge["nonce"].as_str().unwrap(),
        )
        .unwrap();
        auth.resume_prove("new", &proof, 100).unwrap();
        assert_eq!(auth.sessions.len(), 8);
        assert!(!auth.sessions.contains_key("0"));
        assert!(auth.role("new", 100).is_ok());
        for index in 1..8 {
            assert!(auth.role(&index.to_string(), 100).is_ok());
        }
        let rotated = auth.issue_resume("new", 100).unwrap();
        assert!(auth
            .resume_start("too-late", rotated["ticket"].as_str().unwrap(), 21600)
            .is_err());
        assert!(auth.role("new", 21600).is_ok());
    }
}
