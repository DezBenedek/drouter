use crate::config::Config;
use anyhow::{bail, Result};
pub trait Storage: Send {
    fn load(&self) -> Result<Option<Config>>;
    fn save(&mut self, config: &Config) -> Result<()>;
    fn reset(&mut self) -> Result<()>;
}
pub fn validate_size(bytes: &[u8]) -> Result<()> {
    if bytes.len() > 24576 {
        bail!("Configuration exceeds 24 KiB capacity");
    }
    Ok(())
}
