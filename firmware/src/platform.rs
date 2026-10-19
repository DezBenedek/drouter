use crate::{
    bird_dog::BirdDog,
    config::*,
    remote,
    storage::{validate_size, Storage},
    web::{Device, Setup},
};
use anyhow::{bail, Result};
use esp_idf_svc::{
    eth::{EspEth, EthDriver, SpiEthChipset},
    eventloop::EspSystemEventLoop,
    hal::{
        peripherals::Peripherals,
        spi::{Dma, SpiDriver, SpiDriverConfig},
        task::watchdog::{config::Config as WdtConfig, TWDTDriver},
        units::FromValueType,
    },
    http::Method,
    http::{
        client::{Configuration as HttpConfig, EspHttpConnection},
        server::{Configuration as ServerConfig, EspHttpServer},
    },
    io::{Read, Write},
    ipv4,
    netif::{EspNetif, NetifConfiguration},
    nvs::{EspDefaultNvsPartition, EspEncryptedNvs, EspEncryptedNvsPartition},
    sys,
    wifi::{
        AccessPointConfiguration, AuthMethod, ClientConfiguration,
        Configuration as WifiConfiguration, EspWifi,
    },
    ws::{
        client::{EspWebSocketClient, EspWebSocketClientConfig, WebSocketEventType},
        FrameType,
    },
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    net::Ipv4Addr,
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};
type Shared = Arc<Mutex<Device>>;
struct NvsStorage {
    nvs: EspEncryptedNvs,
}
impl NvsStorage {
    fn new() -> Result<Self> {
        Ok(Self {
            nvs: EspEncryptedNvs::new(
                EspEncryptedNvsPartition::take("config", Some("nvs_keys"))?,
                "drouter",
                true,
            )?,
        })
    }
}
impl Storage for NvsStorage {
    fn load(&self) -> Result<Option<Config>> {
        let mut configs = vec![];
        let mut found = false;
        for name in ["slot0", "slot1"] {
            match self.nvs.blob_len(name) {
                Ok(None) => continue,
                Ok(Some(length)) if length <= 24608 => {
                    found = true;
                }
                _ => {
                    found = true;
                    continue;
                }
            }
            let mut buf = vec![0; 24608];
            if let Ok(Some(bytes)) = self.nvs.get_blob(name, &mut buf) {
                if bytes.len() >= 32 && Sha256::digest(&bytes[32..]).as_slice() == &bytes[..32] {
                    if let Ok(c) = serde_json::from_slice::<Config>(&bytes[32..]) {
                        if c.validate().is_ok() {
                            configs.push(c);
                        }
                    }
                }
            }
        }
        configs.sort_by_key(|c| c.revision);
        if found && configs.is_empty() {
            bail!("Configuration damaged; use USB recovery");
        }
        Ok(configs.pop())
    }
    fn save(&mut self, c: &Config) -> Result<()> {
        c.validate()?;
        let bytes = serde_json::to_vec(c)?;
        validate_size(&bytes)?;
        self.nvs.set_blob(
            if c.revision % 2 == 0 {
                "slot0"
            } else {
                "slot1"
            },
            &[Sha256::digest(&bytes).to_vec(), bytes].concat(),
        )?;
        Ok(())
    }
    fn reset(&mut self) -> Result<()> {
        self.nvs.remove("slot0")?;
        self.nvs.remove("slot1")?;
        Ok(())
    }
}
struct EspBirdDog {
    deadline: Instant,
}
impl BirdDog for EspBirdDog {
    fn begin_operation(&mut self) {
        self.deadline = Instant::now() + Duration::from_secs(10);
    }
    fn request(
        &mut self,
        r: &Receiver,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        if Instant::now() >= self.deadline {
            bail!("Operation deadline exceeded");
        }
        let mut conn = EspHttpConnection::new(&HttpConfig {
            timeout: Some(Duration::from_secs(2)),
            buffer_size: Some(1024),
            ..Default::default()
        })?;
        let url = format!("http://{}:{}{}", r.ip, r.port, path);
        let body = body.map(|v| v.to_string()).unwrap_or_default();
        let len = body.len().to_string();
        conn.initiate_request(
            if method == "POST" {
                Method::Post
            } else {
                Method::Get
            },
            &url,
            &[
                ("Content-Type", "application/json"),
                ("Content-Length", &len),
            ],
        )?;
        if !body.is_empty() {
            conn.write_all(body.as_bytes())?;
        }
        conn.initiate_response()?;
        if !(200..300).contains(&conn.status()) {
            bail!("BirdDog HTTP {}", conn.status());
        }
        let mut data = Vec::new();
        let mut buf = [0; 1024];
        loop {
            let n = conn.read(&mut buf)?;
            if n == 0 {
                break;
            }
            if data.len() + n > MAX_MESSAGE {
                bail!("BirdDog response too large");
            }
            data.extend_from_slice(&buf[..n]);
        }
        if method == "POST" {
            return Ok(serde_json::from_slice(&data).unwrap_or(json!({})));
        }
        Ok(serde_json::from_slice(&data)?)
    }
}
fn ethernet_netif(c: &EthernetConfig) -> Result<EspNetif> {
    static NEXT_NETIF: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let generation = NEXT_NETIF.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut config = NetifConfiguration::eth_default_client();
    config.key = format!("DR_ETH_{generation}").as_str().try_into().unwrap();
    config.route_priority = 60;
    if let Some(ip) = c.address {
        config.ip_configuration = Some(ipv4::Configuration::Client(
            ipv4::ClientConfiguration::Fixed(ipv4::ClientSettings {
                ip,
                subnet: ipv4::Subnet {
                    gateway: c.gateway.unwrap_or(Ipv4Addr::UNSPECIFIED),
                    mask: c
                        .mask
                        .unwrap()
                        .try_into()
                        .map_err(|_| anyhow::anyhow!("Invalid subnet mask"))?,
                },
                dns: c.dns,
                secondary_dns: None,
            }),
        ));
    }
    Ok(EspNetif::new_with_conf(&config)?)
}
fn wifi_configuration(
    ap: &AccessPointConfiguration,
    profile: Option<&WifiProfile>,
) -> Result<WifiConfiguration> {
    let station = if let Some(p) = profile {
        ClientConfiguration {
            ssid: p
                .ssid
                .as_str()
                .try_into()
                .map_err(|_| anyhow::anyhow!("SSID too long"))?,
            password: p
                .password
                .as_str()
                .try_into()
                .map_err(|_| anyhow::anyhow!("Password too long"))?,
            auth_method: AuthMethod::WPA2Personal,
            ..Default::default()
        }
    } else {
        ClientConfiguration::default()
    };
    Ok(WifiConfiguration::Mixed(station, ap.clone()))
}
fn apply_wifi(
    wifi: &mut EspWifi<'_>,
    ap: &AccessPointConfiguration,
    profile: Option<&WifiProfile>,
    with_ap: bool,
) -> Result<()> {
    let WifiConfiguration::Mixed(station, access_point) = wifi_configuration(ap, profile)? else {
        unreachable!()
    };
    let _ = wifi.disconnect();
    let config = if with_ap {
        WifiConfiguration::Mixed(station, access_point)
    } else {
        WifiConfiguration::Client(station)
    };
    wifi.set_configuration(&config)?;
    if profile.is_some() {
        wifi.connect()?;
    }
    Ok(())
}
fn create_server(shared: Shared) -> Result<EspHttpServer<'static>> {
    let mut server = EspHttpServer::new(&ServerConfig {
        stack_size: 32768,
        max_uri_handlers: 16,
        max_open_sockets: 5,
        session_timeout: Duration::from_secs(20),
        ..Default::default()
    })?;
    for (path, mime, bytes) in [
        (
            "/",
            "text/html",
            include_bytes!("../web/index.html.gz").as_slice(),
        ),
        (
            "/assets/local.js",
            "text/javascript",
            include_bytes!("../web/local.js.gz").as_slice(),
        ),
        (
            "/assets/shared/client.js",
            "text/javascript",
            include_bytes!("../web/shared/client.js.gz").as_slice(),
        ),
        (
            "/assets/shared/style.css",
            "text/css",
            include_bytes!("../web/shared/style.css.gz").as_slice(),
        ),
        (
            "/assets/shared/auth.js",
            "text/javascript",
            include_bytes!("../web/shared/auth.js.gz").as_slice(),
        ),
        (
            "/assets/shared/auth_bg.wasm",
            "application/wasm",
            include_bytes!("../web/shared/auth_bg.wasm.gz").as_slice(),
        ),
        (
            "/assets/shared/crypto.js",
            "text/javascript",
            include_bytes!("../web/shared/crypto.js.gz").as_slice(),
        ),
    ] {
        server.fn_handler::<anyhow::Error,_>(path,Method::Get,move |request| {
            request.into_response(200,None,&[("Content-Type",mime),("Content-Encoding","gzip"),("Cache-Control","no-store"),("X-Content-Type-Options","nosniff"),("Content-Security-Policy","default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'")])?.write_all(bytes)?; Ok(())
        })?;
    }
    let state = shared.clone();
    server.fn_handler::<anyhow::Error, _>("/bootstrap", Method::Get, move |request| {
        let d = state.lock().unwrap();
        let body = json!({"setup":d.config.is_none(),"name":d.config.as_ref().map(|c|&c.name)})
            .to_string();
        request
            .into_response(
                200,
                None,
                &[
                    ("Content-Type", "application/json"),
                    ("Cache-Control", "no-store"),
                ],
            )?
            .write_all(body.as_bytes())?;
        Ok(())
    })?;
    for path in ["/session", "/setup", "/api"] {
        let state = shared.clone();
        server.fn_handler::<anyhow::Error, _>(path, Method::Post, move |mut request| {
            let host = request.header("Host").unwrap_or("").to_owned();
            if request
                .header("Origin")
                .is_some_and(|o| o != format!("http://{host}"))
            {
                request.into_status_response(403)?;
                return Ok(());
            }
            let len = request
                .header("Content-Length")
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(0);
            if len > MAX_MESSAGE {
                request.into_status_response(413)?;
                return Ok(());
            }
            let mut bytes = vec![0; len];
            request.read_exact(&mut bytes)?;
            let result: Result<Value> = (|| {
                if path == "/session" {
                    return Ok(json!({"sid":drouter_auth::random_hex(18)}));
                }
                let v: Value = serde_json::from_slice(&bytes)?;
                let mut device = state.lock().unwrap();
                if path == "/setup" {
                    device.setup(serde_json::from_value::<Setup>(v)?)
                } else {
                    let sid = v["sid"]
                        .as_str()
                        .filter(|s| s.len() == 36 && s.bytes().all(|b| b.is_ascii_hexdigit()))
                        .ok_or_else(|| anyhow::anyhow!("Invalid session"))?;
                    Ok(device.frame(sid, v["frame"].clone(), false))
                }
            })();
            let (status, body) = match result {
                Ok(v) => (200, v),
                Err(_) => (400, json!({"error":"Request rejected"})),
            };
            request
                .into_response(
                    status,
                    None,
                    &[
                        ("Content-Type", "application/json"),
                        ("Cache-Control", "no-store"),
                    ],
                )?
                .write_all(body.to_string().as_bytes())?;
            Ok(())
        })?;
    }
    Ok(server)
}
fn remote_loop(shared: Shared) {
    let mut backoff = remote::Backoff::default();
    loop {
        let config = {
            let d = shared.lock().unwrap();
            d.config
                .clone()
                .filter(|c| c.cloud_enabled && d.network.online())
        };
        let Some(c) = config else {
            {
                let mut d = shared.lock().unwrap();
                d.network.cloud = if d.config.as_ref().is_some_and(|c| c.cloud_enabled) {
                    "offline"
                } else {
                    "disabled"
                }
                .into();
            }
            std::thread::sleep(Duration::from_secs(2));
            continue;
        };
        if !c.server.starts_with("https://") {
            std::thread::sleep(Duration::from_secs(30));
            continue;
        }
        if std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            < 1_700_000_000
        {
            std::thread::sleep(Duration::from_secs(5));
            continue;
        }
        let name = c.remote_name();
        let url = format!(
            "{}/relay/{name}/device",
            c.server.replacen("https://", "wss://", 1)
        );
        let (tx, rx) = mpsc::sync_channel(4);
        let cfg = EspWebSocketClientConfig {
            disable_auto_reconnect: true,
            crt_bundle_attach: Some(sys::esp_crt_bundle_attach),
            skip_cert_common_name_check: false,
            buffer_size: MAX_MESSAGE,
            task_stack: 8192,
            network_timeout_ms: Duration::from_secs(10),
            ping_interval_sec: Duration::from_secs(300),
            ..Default::default()
        };
        shared.lock().unwrap().network.cloud = "connecting".into();
        let websocket = EspWebSocketClient::new(&url, &cfg, Duration::from_secs(5), move |event| {
            let message = match event {
                Ok(event) => match &event.event_type {
                    WebSocketEventType::Text(text) if text.len() <= MAX_MESSAGE => {
                        Some(text.to_string())
                    }
                    WebSocketEventType::Disconnected | WebSocketEventType::Closed => {
                        Some(String::new())
                    }
                    _ => None,
                },
                Err(_) => Some(String::new()),
            };
            if let Some(message) = message {
                let _ = tx.try_send(message);
            }
        });
        if let Ok(mut ws) = websocket {
            let started = Instant::now();
            let mut registered = false;
            let mut remote_sessions = std::collections::BTreeSet::new();
            loop {
                let valid = {
                    let d = shared.lock().unwrap();
                    d.config.as_ref().is_some_and(|x| {
                        x.cloud_enabled && x.remote_name() == name && x.server == c.server
                    })
                };
                if !valid || !registered && started.elapsed() > Duration::from_secs(15) {
                    break;
                }
                match rx.recv_timeout(Duration::from_secs(1)) {
                    Ok(text) => {
                        if text.is_empty() {
                            break;
                        }
                        let Ok(v) = serde_json::from_str::<Value>(&text) else {
                            break;
                        };
                        let reply = match v["type"].as_str() {
                            Some("challenge") => {
                                Some(remote::registration(&c, v["nonce"].as_str().unwrap_or("")))
                            }
                            Some("registered") => {
                                registered = true;
                                shared.lock().unwrap().network.cloud = "connected".into();
                                None
                            }
                            Some("forward") if registered => {
                                let sid = v["sid"].as_str().unwrap_or("");
                                if sid.len() != 36 {
                                    break;
                                }
                                if remote_sessions.len() < 8 {
                                    remote_sessions.insert(sid.to_string());
                                }
                                let frame =
                                    shared.lock().unwrap().frame(sid, v["frame"].clone(), true);
                                Some(json!({"type":"reply","sid":sid,"frame":frame}))
                            }
                            Some("leave") => {
                                if let Some(sid) = v["sid"].as_str() {
                                    shared.lock().unwrap().auth.remove(sid);
                                    remote_sessions.remove(sid);
                                }
                                None
                            }
                            _ => None,
                        };
                        if let Some(reply) = reply {
                            if ws
                                .send(FrameType::Text(false), reply.to_string().as_bytes())
                                .is_err()
                            {
                                break;
                            }
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(_) => break,
                }
                if registered && started.elapsed() > Duration::from_secs(30) {
                    backoff.reset();
                }
            }
            {
                let mut d = shared.lock().unwrap();
                for sid in remote_sessions {
                    d.auth.remove(&sid);
                }
            }
        }
        shared.lock().unwrap().network.cloud = "offline".into();
        std::thread::sleep(Duration::from_secs(backoff.next_delay()));
    }
}
pub fn run() -> Result<()> {
    unsafe {
        sys::bootloader_random_enable();
    }
    let peripherals = Peripherals::take()?;
    let sysloop = EspSystemEventLoop::take()?;
    let nvs = EspDefaultNvsPartition::take()?;
    let setup_token = drouter_auth::random_hex(16);
    let mut storage = NvsStorage::new()?;
    let button = esp_idf_svc::hal::gpio::PinDriver::input(
        peripherals.pins.gpio0,
        esp_idf_svc::hal::gpio::Pull::Up,
    )?;
    if let Err(e) = storage.load() {
        log::error!(
            "Configuration recovery required: {e}. Hold BOOT for 12 seconds to erase user data."
        );
        let mut held: Option<Instant> = None;
        loop {
            if button.is_low() {
                if held.get_or_insert_with(Instant::now).elapsed() >= Duration::from_secs(12) {
                    storage.reset()?;
                    unsafe {
                        sys::esp_restart();
                    }
                }
            } else {
                held = None;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    let mut device = Device::new(
        Box::new(storage),
        Box::new(EspBirdDog {
            deadline: Instant::now() + Duration::from_secs(10),
        }),
        setup_token.clone(),
        false,
    )?;
    let initial = device.config.clone();
    let mut mac = [0; 6];
    esp_idf_svc::sys::esp!(unsafe {
        sys::esp_read_mac(mac.as_mut_ptr(), sys::esp_mac_type_t_ESP_MAC_ETH)
    })?;
    mac[0] = (mac[0] | 2) & 0xfe;
    let spi = SpiDriver::new(
        peripherals.spi2,
        peripherals.pins.gpio13,
        peripherals.pins.gpio11,
        Some(peripherals.pins.gpio12),
        &SpiDriverConfig::new().dma(Dma::Auto(4096)),
    )?;
    let driver = EthDriver::new_spi(
        spi,
        peripherals.pins.gpio10,
        Some(peripherals.pins.gpio14),
        Some(peripherals.pins.gpio9),
        SpiEthChipset::W5500,
        20_u32.MHz().into(),
        Some(&mac),
        None,
        sysloop.clone(),
    )?;
    let mut eth = EspEth::wrap_all(
        driver,
        ethernet_netif(
            &initial
                .as_ref()
                .map(|c| c.ethernet.clone())
                .unwrap_or_default(),
        )?,
    )?;
    eth.start()?;
    let ap_password = drouter_auth::random_hex(12);
    let ssid = format!("DRouter-Setup-{:02X}{:02X}", mac[4], mac[5]);
    let ap = AccessPointConfiguration {
        ssid: ssid.as_str().try_into().unwrap(),
        password: ap_password.as_str().try_into().unwrap(),
        auth_method: AuthMethod::WPA2Personal,
        channel: 6,
        max_connections: 2,
        ..Default::default()
    };
    unsafe {
        sys::bootloader_random_disable();
    }
    let mut wifi = EspWifi::new(peripherals.modem, sysloop, Some(nvs))?;
    esp_idf_svc::sys::esp!(unsafe {
        sys::esp_wifi_set_storage(sys::wifi_storage_t_WIFI_STORAGE_RAM)
    })?;
    wifi.set_configuration(&wifi_configuration(&ap, None)?)?;
    wifi.start()?;

    println!("Physical recovery: hold BOOT for 3 seconds to reveal the setup AP credentials; hold for 12 seconds to erase configuration.");
    if initial.is_none() {
        println!("Setup SSID: {ssid}\nSetup AP password: {ap_password}\nPhysical provisioning token: {setup_token}\nOpen http://192.168.4.1");
    }
    device.network.cloud = if initial.as_ref().is_some_and(|c| c.cloud_enabled) {
        "offline"
    } else {
        "disabled"
    }
    .into();
    let shared = Arc::new(Mutex::new(device));
    let _server = create_server(shared.clone())?;
    let _sntp = esp_idf_svc::sntp::EspSntp::new_default()?;
    let remote_state = shared.clone();
    std::thread::Builder::new()
        .name("remote".into())
        .stack_size(32768)
        .spawn(move || remote_loop(remote_state))?;
    let mut watchdog = TWDTDriver::new(
        peripherals.twdt,
        &WdtConfig {
            duration: Duration::from_secs(120),
            panic_on_trigger: true,
            ..Default::default()
        },
    )?;
    let mut subscription = watchdog.watch_current_task()?;
    let mut scan_at = 0;
    let mut actual_profile: Option<String> = None;
    let mut failed_until = std::collections::BTreeMap::<String, u64>::new();
    let mut connect_at = 0;
    let mut ethernet_config = initial
        .as_ref()
        .map(|c| serde_json::to_string(&c.ethernet).unwrap())
        .unwrap_or_default();
    let mut held: Option<Instant> = None;
    let mut revealed = false;
    let mut ap_enabled = true;
    let mut ap_until = 300;
    let mut actual_signature = String::new();
    loop {
        subscription.feed()?;
        if button.is_low() {
            let start = held.get_or_insert_with(Instant::now);
            if start.elapsed().as_secs() >= 3 && !revealed {
                println!("Recovery AP SSID: {ssid}\nRecovery AP password: {ap_password}");
                revealed = true;
                ap_enabled = true;
                let c = shared.lock().unwrap().config.clone();
                let profile = c.as_ref().and_then(|c| {
                    c.wifi
                        .iter()
                        .find(|p| Some(&p.id) == actual_profile.as_ref())
                });
                if let Err(e) = apply_wifi(&mut wifi, &ap, profile, true) {
                    log::warn!("Recovery AP configuration failed: {e}");
                }
                ap_until = shared.lock().unwrap().now() + 300;
                connect_at = shared.lock().unwrap().now();
                scan_at = 0;
            }
            if start.elapsed().as_secs() >= 12 {
                shared.lock().unwrap().storage.reset()?;
                unsafe {
                    sys::esp_restart();
                }
            }
        } else {
            held = None;
            revealed = false;
        }
        let snapshot = {
            let mut d = shared.lock().unwrap();
            d.network.wifi.connected = wifi.is_up().unwrap_or(false);
            d.network.ethernet.link = eth.is_connected().unwrap_or(false);
            d.network.ethernet.ip = eth
                .netif()
                .get_ip_info()
                .ok()
                .map(|i| i.ip.to_string())
                .filter(|ip| ip != "0.0.0.0");
            d.network.free_memory = unsafe { sys::esp_get_free_heap_size() } as usize;
            d.config.clone()
        };
        if let Some(c) = snapshot {
            let now = shared.lock().unwrap().now();
            let serialized = serde_json::to_string(&c.ethernet)?;
            if serialized != ethernet_config {
                eth.stop()?;
                eth.swap_netif(ethernet_netif(&c.ethernet)?)?;
                eth.start()?;
                ethernet_config = serialized;
            }
            let requested_disconnect = shared.lock().unwrap().network.wifi.active.is_none();
            let current_profile = c
                .wifi
                .iter()
                .find(|p| Some(&p.id) == actual_profile.as_ref());
            let changed = current_profile
                .map(|p| serde_json::to_string(p).unwrap())
                .is_some_and(|s| s != actual_signature);
            if actual_profile.is_some() && (requested_disconnect || changed) {
                let _ = wifi.disconnect();
                actual_profile = None;
                shared.lock().unwrap().network.wifi.active = None;
                scan_at = 0;
                failed_until.clear();
            }
            if ap_enabled && now >= ap_until {
                let profile = c
                    .wifi
                    .iter()
                    .find(|p| Some(&p.id) == actual_profile.as_ref());
                if let Err(e) = apply_wifi(&mut wifi, &ap, profile, false) {
                    log::warn!("Wi-Fi AP transition failed: {e}");
                }
                ap_enabled = false;
                connect_at = now;
            }
            if actual_profile.is_some()
                && !wifi.is_up().unwrap_or(false)
                && now.saturating_sub(connect_at) > 30
            {
                if let Some(id) = actual_profile.take() {
                    failed_until.insert(id, now + 60);
                }
                shared
                    .lock()
                    .unwrap()
                    .network
                    .wifi
                    .disconnected(now, &c.wifi_policy);
                scan_at = now + c.wifi_policy.retry_secs;
            }
            if now >= scan_at {
                let scan = wifi
                    .scan_n::<32>()
                    .map(|(aps, _)| aps.iter().map(|ap| ap.ssid.to_string()).collect::<Vec<_>>())
                    .unwrap_or_default();
                let profiles: Vec<_> = c
                    .wifi
                    .iter()
                    .filter(|p| failed_until.get(&p.id).is_none_or(|t| now >= *t))
                    .cloned()
                    .collect();
                let choice = {
                    let mut d = shared.lock().unwrap();
                    let busy = d.last_operation.elapsed() < Duration::from_secs(5);
                    d.network
                        .wifi
                        .choose(&profiles, &scan, &c.wifi_policy, now, busy)
                };
                if let Some(id) = choice {
                    if actual_profile.as_ref() != Some(&id) {
                        let profile = c.wifi.iter().find(|p| p.id == id).unwrap();
                        match apply_wifi(&mut wifi, &ap, Some(profile), ap_enabled) {
                            Ok(()) => {
                                actual_signature = serde_json::to_string(profile)?;
                                actual_profile = Some(id);
                                connect_at = now;
                            }
                            Err(e) => {
                                log::warn!("Wi-Fi connection request failed: {e}");
                                failed_until.insert(id, now + 60);
                                shared
                                    .lock()
                                    .unwrap()
                                    .network
                                    .wifi
                                    .disconnected(now, &c.wifi_policy);
                                actual_profile = None;
                            }
                        }
                    }
                }
                scan_at = now
                    + if wifi.is_up().unwrap_or(false) {
                        c.wifi_policy.preferred_check_secs
                    } else {
                        c.wifi_policy.retry_secs
                    };
            }
            if shared
                .lock()
                .unwrap()
                .network
                .wifi
                .active
                .as_ref()
                .is_some_and(|id| !c.wifi.iter().any(|p| &p.id == id))
            {
                let _ = wifi.disconnect();
                actual_profile = None;
                shared.lock().unwrap().network.wifi.active = None;
                scan_at = 0;
            }
        } else if initial.is_some() {
            unsafe {
                sys::esp_restart();
            }
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}
