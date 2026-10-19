use anyhow::{bail, Result};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use srp::{
    client::SrpClient,
    groups::G_2048,
    server::{SrpServer, SrpServerVerifier},
};
use zeroize::Zeroize;

pub const USER: &[u8] = b"admin";
pub fn random_hex(len: usize) -> String {
    let mut bytes = vec![0; len];
    OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}
fn stretched(password: &str, salt: &[u8]) -> Vec<u8> {
    let mut out = vec![0; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, 100_000, &mut out);
    out
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Credential {
    pub salt: String,
    pub verifier: String,
}
impl Credential {
    pub fn new(password: &str) -> Result<Self> {
        Self::with_salt(password, &random_hex(32))
    }
    pub fn with_salt(password: &str, salt: &str) -> Result<Self> {
        if salt.len() != 64 || hex::decode(salt)?.len() != 32 {
            bail!("Invalid salt");
        }
        if !(4..=128).contains(&password.chars().count()) {
            bail!("Password must contain 4–128 Unicode characters");
        }
        let salt = salt.to_owned();
        let mut p = stretched(password, &hex::decode(&salt)?);
        let v = SrpClient::<Sha256>::new(&G_2048).compute_verifier(USER, &p, &hex::decode(&salt)?);
        p.zeroize();
        Ok(Self {
            salt,
            verifier: hex::encode(v),
        })
    }
    pub fn matches(&self, password: &str) -> bool {
        Self::with_salt(password, &self.salt).is_ok_and(|c| c.verifier == self.verifier)
    }
    pub fn begin(&self, a: &str) -> Result<(String, SrpServerVerifier<Sha256>)> {
        if a.len() > 512 {
            bail!("Invalid public key");
        }
        let b = hex::decode(random_hex(32))?;
        let server = SrpServer::<Sha256>::new(&G_2048);
        let v = hex::decode(&self.verifier)?;
        let public = server.compute_public_ephemeral(&b, &v);
        let state = server
            .process_reply(&b, &v, &hex::decode(a)?)
            .map_err(|_| anyhow::anyhow!("Invalid SRP public key"))?;
        Ok((hex::encode(public), state))
    }
}
#[cfg_attr(target_arch = "wasm32", wasm_bindgen::prelude::wasm_bindgen)]
pub struct Login {
    secret: Vec<u8>,
    public: Vec<u8>,
    key: Vec<u8>,
    verifier: Vec<srp::client::SrpClientVerifier<Sha256>>,
}
#[cfg_attr(target_arch = "wasm32", wasm_bindgen::prelude::wasm_bindgen)]
impl Login {
    #[cfg_attr(
        target_arch = "wasm32",
        wasm_bindgen::prelude::wasm_bindgen(constructor)
    )]
    pub fn new() -> Self {
        let secret = hex::decode(random_hex(32)).unwrap();
        let public = SrpClient::<Sha256>::new(&G_2048).compute_public_ephemeral(&secret);
        Self {
            secret,
            public,
            key: vec![],
            verifier: vec![],
        }
    }
    pub fn public_key(&self) -> String {
        hex::encode(&self.public)
    }
    pub fn respond(&mut self, password: &str, salt: &str, b: &str) -> String {
        self.try_respond(password, salt, b).unwrap_or_default()
    }
    pub fn finish(&self, proof: &str) -> String {
        self.verifier
            .iter()
            .find_map(|v| {
                hex::decode(proof)
                    .ok()
                    .filter(|p| v.verify_server(p).is_ok())
                    .map(|_| hex::encode(v.key()))
            })
            .unwrap_or_default()
    }
}
impl Default for Login {
    fn default() -> Self {
        Self::new()
    }
}
impl Login {
    fn try_respond(&mut self, password: &str, salt: &str, b: &str) -> Result<String> {
        if salt.len() != 64 || b.len() > 512 {
            bail!("Invalid challenge");
        }
        let salt = hex::decode(salt)?;
        let mut p = stretched(password, &salt);
        let result = SrpClient::<Sha256>::new(&G_2048)
            .process_reply(&self.secret, USER, &p, &salt, &hex::decode(b)?)
            .map_err(|_| anyhow::anyhow!("Invalid SRP challenge"))?;
        p.zeroize();
        self.key = result.key().to_vec();
        let proof = result.proof().to_vec();
        self.verifier.push(result);
        Ok(hex::encode(proof))
    }
}
impl Drop for Login {
    fn drop(&mut self) {
        self.secret.zeroize();
        self.key.zeroize();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn srp_round_trip_and_wrong_password() {
        let c = Credential::new("correct horse battery").unwrap();
        for password in ["correct horse battery", "wrong password"] {
            let mut client = Login::new();
            let (b, server) = c.begin(&client.public_key()).unwrap();
            let proof = client.respond(password, &c.salt, &b);
            let valid = server.verify_client(&hex::decode(proof).unwrap()).is_ok();
            assert_eq!(valid, password == "correct horse battery");
            if valid {
                assert_eq!(
                    client.finish(&hex::encode(server.proof())),
                    hex::encode(server.key())
                );
            }
        }
        assert!(c.begin("00").is_err());
    }
}
