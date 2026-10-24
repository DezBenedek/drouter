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
pub fn verify(api: &mut dyn BirdDog, receiver: &Receiver, source: &str) -> Result<RouteState> {
    let mut detail = String::new();
    for attempt in 0..8 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        match api.active(receiver) {
            Ok(actual) if actual == source => {
                return Ok(RouteState {
                    receiver: receiver.id.clone(),
                    source: Some(actual),
                    online: true,
                    error: None,
                })
            }
            Ok(actual) => detail = format!("Current source: {actual}"),
            Err(error) => detail = error.to_string(),
        }
    }
    bail!("Receiver did not confirm the requested source: {detail}")
}
pub fn set(api: &mut dyn BirdDog, receiver: &Receiver, source: &str) -> Result<RouteState> {
    if source.is_empty() || source.len() > 256 || source == "None" {
        bail!("Invalid source name");
    }
    // Discovery is per receiver. The union shown by the UI may be ahead of this decoder's cache.
    let cached = api.sources(receiver, false);
    if !cached
        .as_ref()
        .is_ok_and(|list| list.iter().any(|s| s.name == source))
        && !api
            .sources(receiver, true)?
            .iter()
            .any(|s| s.name == source)
    {
        bail!("Source is unavailable on this receiver after discovery refresh");
    }
    let mut failure = String::new();
    for _ in 0..2 {
        // A POST timeout can still mean the device applied the command. Check before resending.
        if let Err(error) = api.switch(receiver, source) {
            failure = error.to_string();
        }
        match verify(api, receiver, source) {
            Ok(state) => return Ok(state),
            Err(error) => failure = format!("{failure} {error}").trim().to_string(),
        }
    }
    bail!("{failure}")
}
