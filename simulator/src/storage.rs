use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use anyhow::{bail, Result};
use drouter::{
    config::Config,
    storage::{validate_size, Storage},
};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};
pub struct FileStorage {
    path: PathBuf,
    key: Vec<u8>,
    _lock: fs::File,
}
fn private_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut f = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    Ok(())
}
impl FileStorage {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        fs::create_dir_all(&path)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(path.join("state.lock"))?;
        lock.try_lock()
            .map_err(|_| anyhow::anyhow!("Simulator state is already in use"))?;
        let key_path = path.join("storage.key");
        let key = if key_path.exists() {
            fs::read(key_path)?
        } else {
            if path.join("config.0").exists() || path.join("config.1").exists() {
                bail!("Storage key missing; restore backup or explicitly erase state");
            }
            let key = hex::decode(drouter_auth::random_hex(32))?;
            private_write(&key_path, &key)?;
            key
        };
        if key.len() != 32 {
            bail!("Invalid storage key");
        }
        Ok(Self {
            path,
            key,
            _lock: lock,
        })
    }
    fn decode(&self, bytes: &[u8]) -> Result<Config> {
        if bytes.len() < 28 || bytes.len() > 25000 {
            bail!("Invalid configuration length");
        }
        let cipher = Aes256Gcm::new_from_slice(&self.key)?;
        let plain = cipher
            .decrypt(Nonce::from_slice(&bytes[..12]), &bytes[12..])
            .map_err(|_| anyhow::anyhow!("Configuration authentication failed"))?;
        let config: Config = serde_json::from_slice(&plain)?;
        config.validate()?;
        Ok(config)
    }
}
impl Storage for FileStorage {
    fn load(&self) -> Result<Option<Config>> {
        let mut found = false;
        let mut slots = 0;
        let mut configs = vec![];
        for slot in 0..2 {
            let p = self.path.join(format!("config.{slot}"));
            if p.exists() {
                found = true;
                slots += 1;
                if let Ok(c) = fs::read(p)
                    .map_err(anyhow::Error::from)
                    .and_then(|b| self.decode(&b))
                {
                    configs.push(c);
                }
            }
        }
        configs.sort_by_key(|c| c.revision);
        if found && configs.is_empty() {
            bail!("Both configuration slots are damaged; restore backup or explicitly erase state");
        }
        let damaged = slots > configs.len();
        let mut config = configs.pop();
        if damaged {
            if let Some(c) = &mut config {
                c.event_mode = true;
            }
        }
        Ok(config)
    }
    fn save(&mut self, config: &Config) -> Result<()> {
        config.validate()?;
        let bytes = serde_json::to_vec(config)?;
        validate_size(&bytes)?;
        let nonce = hex::decode(drouter_auth::random_hex(12))?;
        let cipher = Aes256Gcm::new_from_slice(&self.key)?;
        let encrypted = cipher
            .encrypt(Nonce::from_slice(&nonce), bytes.as_slice())
            .map_err(|_| anyhow::anyhow!("Encryption failed"))?;
        let temp = self.path.join("config.tmp");
        private_write(&temp, &[nonce, encrypted].concat())?;
        fs::rename(
            temp,
            self.path.join(format!("config.{}", config.revision % 2)),
        )?;
        fs::File::open(&self.path)?.sync_all()?;
        Ok(())
    }
    fn reset(&mut self) -> Result<()> {
        for slot in 0..2 {
            let path = self.path.join(format!("config.{slot}"));
            if path.exists() {
                fs::remove_file(path)?;
            }
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encrypted_persistence_and_interrupted_write() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = FileStorage::open(dir.path()).unwrap();
        let mut c = Config::new("test-router", "correct horse battery").unwrap();
        c.presets.push(drouter::config::Preset {
            id: "1".into(),
            name: "Opening".into(),
            routes: vec![("one".into(), "Camera A".into())],
        });
        store.save(&c).unwrap();
        c.revision += 1;
        c.name = "updated".into();
        store.save(&c).unwrap();
        drop(store);
        let store = FileStorage::open(dir.path()).unwrap();
        assert_eq!(store.load().unwrap().unwrap().presets[0].name, "Opening");
        let data = fs::read(dir.path().join("config.0")).unwrap();
        assert!(!String::from_utf8_lossy(&data).contains("Opening"));
        fs::write(dir.path().join("config.0"), b"partial").unwrap();
        let recovered = store.load().unwrap().unwrap();
        assert_eq!(recovered.name, "test-router");
        assert!(recovered.event_mode);
        fs::write(dir.path().join("config.1"), b"partial").unwrap();
        assert!(store.load().is_err());
    }
}
