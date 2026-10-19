use crate::{ethernet::EthernetState, wifi::WifiState};
use serde::Serialize;
#[derive(Default, Clone, Serialize)]
pub struct NetworkState {
    pub ethernet: EthernetState,
    pub wifi: WifiState,
    pub cloud: String,
    pub registered_name: Option<String>,
    pub last_cloud_connection: Option<u64>,
    pub available_wifi: Vec<String>,
    pub free_memory: usize,
}
impl NetworkState {
    pub fn online(&self) -> bool {
        (self.ethernet.link && self.ethernet.ip.is_some()) || self.wifi.connected
    }
}
