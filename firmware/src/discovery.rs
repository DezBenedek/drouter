use crate::{
    bird_dog::BirdDog,
    config::{Receiver, MAX_RECEIVERS},
};
use anyhow::Result;
pub fn verified_devices(api: &mut dyn BirdDog) -> Result<Vec<Receiver>> {
    let candidates = api.discover()?;
    Ok(candidates
        .into_iter()
        .take(MAX_RECEIVERS)
        .filter(|r| api.info(r).is_ok())
        .collect())
}
