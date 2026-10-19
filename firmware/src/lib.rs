pub mod auth;
pub mod bird_dog;
pub mod config;
pub mod discovery;
pub mod ethernet;
pub mod network;
#[cfg(feature = "esp")]
pub mod platform;
pub mod presets;
pub mod remote;
pub mod routing;
pub mod storage;
#[cfg(test)]
mod tests;
pub mod watchdog;
pub mod web;
pub mod wifi;

mod management;
