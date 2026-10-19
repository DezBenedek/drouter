use crate::{bird_dog::BirdDog, config::Receiver};
use anyhow::{bail, Result};
use serde::Serialize;
#[derive(Clone, Serialize)]
pub struct RouteState {
    pub receiver: String,
    pub source: Option<String>,
    pub online: bool,
    pub error: Option<String>,
}
pub fn read(api: &mut dyn BirdDog, receiver: &Receiver) -> RouteState {
    match api.active(receiver) {
        Ok(source) => RouteState {
            receiver: receiver.id.clone(),
            source: Some(source),
            online: true,
            error: None,
        },
        Err(e) => RouteState {
            receiver: receiver.id.clone(),
            source: None,
            online: false,
            error: Some(e.to_string()),
        },
    }
}
pub fn set(api: &mut dyn BirdDog, receiver: &Receiver, source: &str) -> Result<RouteState> {
    if !api
        .sources(receiver, false)?
        .iter()
        .any(|s| s.name == source)
    {
        bail!("Source is unavailable on this receiver");
    }
    api.switch(receiver, source)?;
    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        if api.active(receiver)? == source {
            return Ok(RouteState {
                receiver: receiver.id.clone(),
                source: Some(source.to_string()),
                online: true,
                error: None,
            });
        }
    }
    bail!("Receiver did not confirm the requested source")
}
