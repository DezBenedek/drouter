use serde::Serialize;
#[derive(Default, Clone, Serialize)]
pub struct EthernetState {
    pub link: bool,
    pub ip: Option<String>,
    pub error: Option<String>,
}
pub const W5500_MISO: i32 = 12;
pub const W5500_MOSI: i32 = 11;
pub const W5500_SCLK: i32 = 13;
pub const W5500_CS: i32 = 14;
pub const W5500_RESET: i32 = 9;
pub const W5500_INT: i32 = 10;
