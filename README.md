# DRouter

Standalone Rust NDI routing controller for the **Waveshare ESP32-S3-ETH, SKU 28972**, with an optional Cloudflare remote relay. The ESP32 owns its configuration, password verifier, Wi-Fi credentials, receivers and presets. It controls BirdDog decoders; it never carries NDI video.

The macOS simulator runs the same authentication, validation, routing, preset, Wi-Fi selection and configuration core as the firmware. Its two virtual BirdDog HTTP servers implement mutable decoder state, unavailable devices, ignored switches and request delays. The Cloudflare Worker is a real Wrangler Durable Object service, not a simulated HTTP relay.

![Remote routing interface](docs/screenshots/remote-routing.png)

## Repository

| Directory | Purpose |
| --- | --- |
| `firmware/` | Shared Rust device core, ESP-IDF hardware integration, compressed vanilla HTML/CSS/JS local UI |
| `cloud/` | Worker, hibernating Durable Object relay, React/TypeScript remote interface, relay/browser integration tests |
| `protocol/` | JSON schema, protocol/security specification, shared native/WASM SRP implementation |
| `simulator/` | Native Rust server, encrypted file storage, virtual BirdDog HTTP devices and network fault controls |
| `scripts/` | Asset regeneration, test runner, firmware image helpers |
| `docs/` | Hardware acceptance plan, implementation details, captured browser screenshots |

## Quick start on macOS

Install [Rust with rustup](https://rustup.rs/) and Node.js 22.12 or newer. The checked-in WASM and compressed local assets let you build the simulator and cloud without installing the ESP toolchain or regenerating assets. The tested native Rust version is 1.96.1; ESP builds use the separate `esp` toolchain.

From the repository root:

```sh
npm ci --prefix cloud
cargo build -p drouter-simulator
cargo run -p drouter-simulator
```

Open **http://127.0.0.1:8080**. The terminal prints a newly generated physical provisioning token. Enter that token, choose a device name and an administrator password of at least 12 characters. Ethernet defaults to DHCP; Wi-Fi and Cloud access are optional. There is no default administrator password. Choose **Devices → Detect devices** to register both verified virtual receivers, then use **Routing**. The simulator binds loopback only.

State is saved under `.drouter-state/` using AES-256-GCM. The directory is mode 0700 and its encryption key/files are mode 0600. Keep the complete directory, including its key, when backing up. Only one simulator can use a state directory at a time. Virtual receiver state belongs to the receiver processes and resets on restart; DRouter presets and configuration persist. Boot reads the actual current routes and does not apply a preset.

To use another simulator state directory or HTTP port:

```sh
DROUTER_STATE=/tmp/drouter-development DROUTER_PORT=8081 cargo run -p drouter-simulator
```

The two virtual receiver ports remain 9001 and 9002; run only one simulator instance per host with this launcher.

## Local Cloudflare development

In a second terminal:

```sh
npm run build --prefix cloud
npm run dev --prefix cloud
```

This starts the real Worker, static React assets and Durable Object at **http://127.0.0.1:8787**. No domain, Cloudflare account, API token, D1, KV or R2 is needed for local development.

In the local device UI, go to **Settings**, open **Advanced server override**, set the server to `http://127.0.0.1:8787`, enable Cloud access, then save. This revokes sessions; log in locally again. The simulator automatically connects to Wrangler. Copy the full **remote name** from Settings and enter it with the same administrator password at `http://127.0.0.1:8787`.

For React hot reload, leave Wrangler running and start:

```sh
npm run ui --prefix cloud
```

Open **http://127.0.0.1:5173**. Vite proxies relay WebSockets to Wrangler. The development Origin exception is restricted to loopback. Production defaults to `https://drouter.dezso.hu`; ordinary users do not enter a server URL. Only the simulator accepts loopback HTTP overrides. The ESP32 requires HTTPS, verified certificates and valid system time.

## Identity, passwords and recovery

The friendly device name is normalized to lowercase ASCII letters, digits and single hyphens. The cloud login name appends a device-generated identity fingerprint, for example `studio-router--b361ca087443879bea0dd8d5b633ff7e`. Copy the actual generated value from your device.

This suffix is an explicit safe limitation of zero persistent cloud registrations. A bare friendly name cannot remain securely reserved while a device is offline without a registry. An Ed25519 signature proves ownership of the full name, and another device cannot take it over after disconnection. Duplicate live identities are rejected. The device retains its identity across reboots and password changes. A factory reset erases it and produces a new remote name. Recover the original identity only from your own device backup; there is no cloud account reset or insecure name-reclamation endpoint.

The browser authenticates directly to the device using the same RustCrypto SRP implementation on both sides. Password hardening uses PBKDF2-HMAC-SHA256; the device stores only salt and SRP verifier. Application commands and responses use directional AES-GCM keys derived from the SRP session. Cloudflare sees neither passwords, verifiers nor plaintext configuration updates. Browser memory is temporary; there is no sensitive state in localStorage or a cloud database. See [the full protocol and trust boundary](protocol/README.md).

Sessions expire after 30 minutes. Wi-Fi/security/settings mutations require authentication within the last five minutes; reconnect to authorize them again. **Revoke all sessions** works locally and remotely. Changing the password or disabling Cloud access revokes sessions. A lost administrator password requires physical factory reset, which erases user data; the relay cannot reset it while retaining access.

## Tests

Install Chromium once:

```sh
cd cloud
npx playwright install chromium
cd ..
```

Run all host checks, Worker tests, build and end-to-end Chromium tests:

```sh
./scripts/test.sh
```

Or run them separately:

```sh
cargo test --workspace
cargo build -p drouter-simulator
npm test --prefix cloud
npm run build --prefix cloud
npm run test:e2e --prefix cloud
```

The integration runner starts and stops its own simulator and Wrangler processes, provisions a fresh temporary device, and exercises real HTTP BirdDog devices through the real relay. Ports **8080, 8787, 9001 and 9002 must be free**. It tests local and remote routing, wrong passwords, unauthorized commands, identity collisions and spoofing, source-switch verification, partial preset failures, request deadlines, Wi-Fi reordering/redaction, Ethernet failures, Cloud outage/reconnect, restart persistence, invalid JSON, oversized requests and local session revocation. Chromium also logs in to both interfaces, changes real virtual-decoder state, checks mobile overflow and captures screenshots. Native tests cover replay, expiration, pending/authentication limits, Wi-Fi fallback/preferred-network hysteresis, storage rollback and interrupted-write recovery.

## Simulator fault injection

Fault control is disabled unless you explicitly supply a secret of at least 16 characters. It is a simulator-only endpoint, separate from the production application protocol.

```sh
DROUTER_SIM_CONTROL=development-control-token cargo run -p drouter-simulator
```

Example requests:

```sh
curl http://127.0.0.1:8080/sim/faults \
  -H 'Content-Type: application/json' \
  -H 'x-simulator-token: development-control-token' \
  -d '{"receiver":0,"ignore_switch":true}'

curl http://127.0.0.1:8080/sim/faults \
  -H 'Content-Type: application/json' \
  -H 'x-simulator-token: development-control-token' \
  -d '{"cloud":false,"ethernet":false,"wifi":["Backup-Hotspot"]}'
```

Supported fields: `cloud`, `ethernet`, available `wifi` SSIDs; receiver index `receiver` with `online`, `ignore_switch`, or `delay_ms` (maximum 10 seconds). Switch failures and timeouts are real failed HTTP/readback operations, not preprogrammed successful responses. Restore `cloud:true` and `ethernet:true` independently.

Saved WPA2-Personal networks are tried in list order. An absent network falls back to the next visible profile. The preferred-network check defaults to 300 seconds; two consecutive preferred scans and a minimum dwell period prevent oscillation. Retry and preferred-network policy can be changed in Settings. Credentials are never returned in `wifi.list`. WPA-Enterprise is not implemented.

## ESP32-S3 firmware build on macOS

Install Xcode command-line tools if needed (`xcode-select --install`), Homebrew Python/CMake/Ninja, and the supported ESP Rust tools:

```sh
brew install python cmake ninja
cargo install espup --locked
cargo install ldproxy --locked
cargo install espflash --locked
espup install --targets esp32s3 --export-file "$PWD/export-esp.sh"
. ./export-esp.sh
cd firmware
cargo +esp build --features esp --release
cd ..
```

Run the `cargo +esp` command **inside `firmware/`** so its `.cargo/config.toml` supplies the Xtensa target, linker and partition-table copy configuration. The target is **`xtensa-esp32s3-espidf`**. ESP-IDF is pinned to **v5.4.2**, `esp-idf-svc` to its locked 0.52 release, and `esp_websocket_client` to 1.4.0. The first build downloads ESP-IDF and managed C/Python dependencies into `.embuild/`; allow several GB of disk space. Do not put an activated Python virtualenv first on PATH when building: ESP-IDF creates its own Python environment. Re-source `export-esp.sh` in each new shell.

Firmware assets are embedded at compile time. Ordinary firmware builds need no npm/React build. If you change the shared SRP client or local assets, regenerate first:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked
npm ci --prefix cloud
./scripts/build-web.sh
```

The wasm-bindgen CLI version must match `Cargo.lock`. `WASM_BINDGEN=/absolute/path/to/wasm-bindgen ./scripts/build-web.sh` selects an existing binary. Regeneration minifies the generated binding/crypto module and gzip-compresses every served local asset.

### Flashing and serial logs

Connect the board's USB-C data port. List available ports:

```sh
espflash list-ports
```

Use your actual `/dev/cu.usbmodem…` path. From the repository root:

```sh
espflash flash \
  --chip esp32s3 \
  --port /dev/cu.usbmodemYOURPORT \
  --flash-size 16mb \
  --partition-table firmware/partitions.csv \
  --bootloader target/xtensa-esp32s3-espidf/release/bootloader.bin \
  --monitor \
  target/xtensa-esp32s3-espidf/release/drouter-firmware
```

The custom ESP-IDF bootloader is required for the selected PSRAM/flash/NVS configuration. If automatic USB reset does not enter the bootloader, hold BOOT, press RESET, then release BOOT and retry. Open logs without reflashing:

```sh
espflash monitor --port /dev/cu.usbmodemYOURPORT
```

First boot prints the unique WPA2 setup AP SSID/password and a separate physical provisioning token over USB. Join `DRouter-Setup-XXXX`, open `http://192.168.4.1`, and enter the token. AP credentials are generated securely per boot and are not uploaded. The early boot entropy source is explicitly enabled for provisioning/key generation, then disabled before Wi-Fi starts; runtime randomness uses the active Wi-Fi subsystem. The configured-device recovery flow uses the onboard BOOT button to disclose the current recovery AP credentials over USB after a three-second hold. A 12-second hold resets configuration. Boot configuration corruption never silently erases user data; USB erase remains available.

**Erasing configuration is destructive.** With the board connected, this explicitly removes the configuration partition and generates a new device identity on setup:

```sh
espflash erase-parts --port /dev/cu.usbmodemYOURPORT config
```

To return every partition to blank flash, `espflash erase-flash --port /dev/cu.usbmodemYOURPORT` erases the firmware and all keys; flash again afterward. Neither operation has been run without the physical board.

### Hardware configuration

| W5500 signal | GPIO |
| --- | --- |
| MISO | 12 |
| MOSI | 11 |
| SCLK | 13 |
| CS | 14 |
| Reset | 9 |
| Interrupt | 10 |

These assignments come from the [official Waveshare board documentation](https://docs.waveshare.com/ESP32-S3-ETH/Development-Environment-Setup-ESP-IDF). SPI2 runs at 20 MHz with DMA. No flash/PSRAM pins are repurposed. Wi-Fi and Ethernet coexist; Wi-Fi's default-route priority is higher for internet access, while connected Ethernet subnets carry BirdDog traffic. Use distinct, non-overlapping subnets when both interfaces are active.

The 16 MB partition layout reserves encrypted NVS configuration, an NVS key partition, OTA metadata and two 7 MiB application slots. It needs no microSD. OTA slots are reserved for future updates; no OTA updater is advertised. Configuration uses two revisioned, checksummed NVS blobs and avoids writes when values are unchanged. Wi-Fi driver persistence is disabled; saved profiles live in encrypted configuration. NVS encryption protects credential blobs, but development NVS keys are not protected against a physical flash dump until a reviewed flash-encryption/secure-boot provisioning process is applied. This project does not burn irreversible security eFuses automatically.

## BirdDog compatibility

The adapter implements the documented [BirdDog API 2.0](https://birddog.tv/AV/API/) endpoints `/about`, `/List`, `/connectTo` and `/refresh`, normally on port 8080. The source list accepts the documented object form and a bounded array variant. Switching sends the documented `sourceName` POST and verifies `/connectTo` readback with bounded retries. Devices that do not identify as BirdDog or do not provide decoder readback are rejected.

API 1.0 is deliberately not claimed. Automatic discovery of physical BirdDog devices is not claimed because a verified universal receiver-discovery service was not established from the API reference. Manual private IPv4 registration is implemented; simulator discovery verifies the two known virtual endpoints through the same adapter. Specific models/firmware versions still require interoperability checks against real devices; the vendor documentation is inconsistent in some response details. See [hardware acceptance](docs/HARDWARE-ACCEPTANCE.md).

## Deployment

Local development does not deploy anything. To deploy the already reviewed cloud build to your own Cloudflare account:

```sh
cd cloud
npx wrangler login
npm run deploy
```

This creates one Worker and its Durable Object class/migration. The operator needs a Cloudflare account; end users do not. Use the Worker hostname as a local device advanced override during self-hosted testing. To serve the default production address, configure `drouter.dezso.hu` as the Worker's custom domain in Cloudflare. DNS ownership and deployment credentials are required for that operator step. The production domain has not been provisioned by this repository task.

There are no mandatory D1, KV, R2 or account bindings, no cron triggers and no persistent monitoring. Presence is derived from live sockets. Worker observability is disabled in configuration; avoid enabling request-body/WebSocket logging. Hibernation attachments and cleanup alarms contain only transient authentication/connection bookkeeping. No configuration, receiver/source list, preset or routing history is written to Durable Object storage.

## Verification boundary

See [the recorded software verification results](docs/VERIFICATION.md) for toolchain versions and the executed checks. `./scripts/firmware-image.sh` reproduces the merged flash image after a successful firmware build.

Software tests, browser screenshots and a firmware cross-build can establish implementation behavior before hardware arrives. They cannot establish electrical behavior, PSRAM stability, power-loss resilience on real flash, Wi-Fi roaming timing, physical Ethernet throughput, BirdDog model compatibility or 24/7 stability. The exact remaining measurements and soak tests are listed in [HARDWARE-ACCEPTANCE.md](docs/HARDWARE-ACCEPTANCE.md). Treat this as an implemented, testable initial release pending that acceptance, not a physically verified production appliance.
