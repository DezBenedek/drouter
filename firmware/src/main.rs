fn main() {
    esp_idf_svc::sys::link_patches();
    esp_idf_svc::log::EspLogger::initialize_default();
    if let Err(e) = drouter::platform::run() {
        log::error!("Boot stopped safely: {e}");
        loop {
            std::thread::sleep(std::time::Duration::from_secs(10));
        }
    }
}
