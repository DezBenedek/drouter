use crate::{
    bird_dog::BirdDog,
    config::{Preset, Receiver},
    routing,
};
use serde_json::{json, Value};
pub fn apply(api: &mut dyn BirdDog, receivers: &[Receiver], preset: &Preset) -> Vec<Value> {
    preset
        .routes
        .iter()
        .map(|(id, source)| {
            let result = receivers
                .iter()
                .find(|r| &r.id == id)
                .ok_or_else(|| anyhow::anyhow!("Receiver was removed"))
                .and_then(|r| routing::set(api, r, source));
            match result {
                Ok(state) => json!({"receiver":id,"ok":true,"state":state}),
                Err(e) => json!({"receiver":id,"ok":false,"error":e.to_string()}),
            }
        })
        .collect()
}
